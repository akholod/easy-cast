import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assetRecorded,
  createJournal,
  ledgerSynced,
  sameScope,
  type Scope,
} from '../src/journal.js';
import { EasyCastError } from '../src/errors.js';
import { spawnScrubbed } from '../src/secret/spawn.js';

let dir: string;
const scope = (over: Partial<Scope> = {}): Scope => ({
  owner: 'akholod',
  repo: 'easy-cast',
  kind: 'pr',
  number: 42,
  key: 'attach-abc',
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easy-cast-journal-'));
});
afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

describe('append', () => {
  it('writes one json line per event', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'u1', scope(), '2026-08-16T00:00:00Z'));
    journal.appendEvent(ledgerSynced('d1', scope(), '2026-08-16T00:00:01Z'));

    const lines = readFileSync(journal.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).ev).toBe('asset-recorded');
  });

  // A read-modify-write would let the later writer clobber the earlier one's
  // records — the exact loss this log exists to prevent.
  it('does not lose records when two writers interleave against one file', () => {
    const journal = createJournal(dir);
    const a = createJournal(dir);
    const b = createJournal(dir);
    for (let i = 0; i < 50; i += 1) {
      a.appendEvent(assetRecorded(`a${i}`, 'u', scope(), '2026-08-16T00:00:00Z'));
      b.appendEvent(assetRecorded(`b${i}`, 'u', scope(), '2026-08-16T00:00:00Z'));
    }

    const { events } = journal.readAll();
    expect(events).toHaveLength(100);
    expect(new Set(events.map((e) => (e.ev === 'asset-recorded' ? e.d : ''))).size).toBe(100);
  });

  // Through the production API: a record written by somebody else between our two
  // calls must survive. A read-modify-write would silently drop it, which is the
  // failure the whole log exists to prevent.
  it('preserves a record written by another writer between two appendEvent calls', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('mine-1', 'u1', scope(), 't'));

    appendFileSync(
      journal.path,
      `${JSON.stringify(assetRecorded('theirs', 'u-theirs', scope(), 't'))}\n`,
    );

    journal.appendEvent(assetRecorded('mine-2', 'u2', scope(), 't'));

    const digests = journal.readAll().events.map((e) => e.d);
    expect(digests).toEqual(['mine-1', 'theirs', 'mine-2']);
  });

  // The mechanism `appendEvent` relies on, exercised at the OS level: a single
  // write(2) on an O_APPEND descriptor is atomic on a local filesystem.
  it('appends from two concurrent OS processes without losing or tearing a record', async () => {
    const journal = createJournal(dir);
    const target = JSON.stringify(journal.path);
    // Each record is written with a single write(2) on an O_APPEND descriptor,
    // which the kernel serialises on a local filesystem. A read-modify-write
    // here would drop roughly half the records.
    const writer = (tag: string) =>
      `const fs=require('node:fs');
       for(let i=0;i<200;i++){
         const fd=fs.openSync(${target},'a');
         fs.writeSync(fd,JSON.stringify({v:1,ev:'asset-recorded',d:'${tag}'+i,u:'u',at:'t',scope:null})+'\\n');
         fs.closeSync(fd);
       }`;

    // Through spawnScrubbed like everything else: it is the only door to a child
    // process (P3), and these two inherit no environment at all.
    const run = (tag: string) =>
      spawnScrubbed(process.execPath, ['-e', writer(tag)], { allowEnv: [] });

    const runs = await Promise.all([run('x'), run('y')]);
    expect(runs.map((result) => result.exitCode)).toEqual([0, 0]);

    const { events, anomalies } = journal.readAll();
    expect(events).toHaveLength(400);
    expect(new Set(events.map((e) => (e.ev === 'asset-recorded' ? e.d : ''))).size).toBe(400);
    expect(anomalies).toEqual([]);
  });
});

describe('reading damaged logs', () => {
  it('quarantines a torn final line and keeps every good record', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('good1', 'u1', scope(), 't'));
    journal.appendEvent(assetRecorded('good2', 'u2', scope(), 't'));
    appendFileSync(journal.path, '{"v":1,"ev":"asset-record');

    const { events, anomalies } = journal.readAll();
    expect(events).toHaveLength(2);
    expect(anomalies.map((a) => a.code)).toEqual(['journal-line-quarantined']);
  });

  // D19 again: an event from a future format is skipped, never guessed at.
  it('quarantines an event of an unknown version', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('good', 'u', scope(), 't'));
    appendFileSync(journal.path, `${JSON.stringify({ v: 99, ev: 'asset-recorded', d: 'x' })}\n`);

    const { events, anomalies } = journal.readAll();
    expect(events).toHaveLength(1);
    expect(anomalies[0].detail).toContain('unknown event version 99');
  });

  // `JSON.parse` returns null for a line reading "null"; reading `.v` off it threw.
  // The command whose job is to make a damaged log readable must not be crashable
  // by a damaged log.
  it.each(['null', '42', '"a string"', '[]'])('quarantines the line %s instead of crashing', (line) => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('good', 'u', scope(), 't'));
    appendFileSync(journal.path, `${line}\n`);

    const { events, anomalies } = journal.readAll();
    expect(events).toHaveLength(1);
    expect(anomalies.map((a) => a.code)).toContain('journal-line-quarantined');
    expect(() => journal.foldPending()).not.toThrow();
  });

  it('reports an empty log rather than failing when nothing was ever written', () => {
    expect(createJournal(dir).readAll()).toEqual({ events: [], anomalies: [] });
  });
});

describe('pending fold', () => {
  it('lists an upload that never reached the comment ledger', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'u1', scope(), 't'));
    journal.appendEvent(assetRecorded('d2', 'u2', scope(), 't'));
    journal.appendEvent(ledgerSynced('d1', scope(), 't'));

    const { pending } = journal.foldPending();
    expect(pending).toEqual([{ scope: scope(), d: 'd2', u: 'u2' }]);
  });

  it('carries the scope on every pending record so two targets stay distinguishable', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'u1', scope({ number: 1 }), 't'));
    journal.appendEvent(assetRecorded('d2', 'u2', scope({ number: 2 }), 't'));

    const { pending } = journal.foldPending();
    expect(pending.map((p) => p.scope.number).sort()).toEqual([1, 2]);
  });

  // `upload` prints the URL to stdout; that is its delivery. There is no comment
  // for it to be out of sync with, so it must never look like a backlog.
  it('never treats an `upload` record as pending', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'u1', null, 't'));
    expect(journal.foldPending().pending).toEqual([]);
  });

  it('still shows `upload` records in the full read, so nothing is invisible', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'u1', null, 't'));
    expect(journal.readAll().events).toHaveLength(1);
  });

  // Folding all the syncs first would let an old one cancel a LATER upload of the
  // same digest, reporting an empty backlog while that upload sat in no comment.
  it('still reports an upload that came after an earlier sync of the same digest', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'u1', scope(), 't1'));
    journal.appendEvent(ledgerSynced('d1', scope(), 't2'));
    journal.appendEvent(assetRecorded('d1', 'u2', scope(), 't3'));

    expect(journal.foldPending().pending).toEqual([{ scope: scope(), d: 'd1', u: 'u2' }]);
  });

  // A line can carry the current version and still be nonsense. Trusting the
  // version alone let a missing scope reach the fold and throw.
  it('quarantines a current-version event that is missing its scope, rather than crashing', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('good', 'u', scope(), 't'));
    appendFileSync(journal.path, `${JSON.stringify({ v: 1, ev: 'ledger-synced', d: 'x', at: 't' })}\n`);

    const { pending, anomalies } = journal.foldPending();
    expect(pending).toHaveLength(1);
    expect(anomalies.map((a) => a.code)).toContain('journal-line-quarantined');
  });

  it('reports nothing pending once everything has synced', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'u1', scope(), 't'));
    journal.appendEvent(ledgerSynced('d1', scope(), 't'));
    expect(journal.foldPending().pending).toEqual([]);
  });
});

describe('scoped lookup', () => {
  it('returns the url recorded for exactly this scope', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'u1', scope(), 't'));
    expect(journal.lookupScoped('d1', scope())).toBe('u1');
  });

  it.each([
    ['a different pull request', scope({ number: 43 })],
    ['a different key', scope({ key: 'other' })],
    ['a different repo', scope({ repo: 'other' })],
    ['a different owner', scope({ owner: 'someone' })],
    ['an issue rather than a pull request', scope({ kind: 'issue' })],
  ])('refuses to reuse a url across %s', (_label, other) => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'u1', scope(), 't'));
    expect(journal.lookupScoped('d1', other)).toBeUndefined();
  });

  it('never reuses an `upload` record, which was never cited anywhere', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'u1', null, 't'));
    expect(journal.lookupScoped('d1', scope())).toBeUndefined();
  });
});

describe('writability pre-flight', () => {
  it('accepts a writable state directory', () => {
    expect(() => createJournal(dir).ensureWritable()).not.toThrow();
  });

  // Discovering this after an irreversible upload is precisely the failure the
  // journal exists to prevent, so it is checked before the first byte leaves.
  it('refuses with exit 2 journal_not_writable when the directory is read-only', () => {
    const readOnly = join(dir, 'locked');
    writeFileSync(join(dir, 'blocker'), '');
    chmodSync(dir, 0o500);

    try {
      createJournal(readOnly).ensureWritable();
      expect.unreachable('expected ensureWritable to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EasyCastError);
      expect((error as EasyCastError).reason).toBe('journal_not_writable');
      expect((error as EasyCastError).outcome.exitCode).toBe(2);
      expect((error as EasyCastError).outcome.nextAction).toBe('fix-environment');
    }
  });
});

describe('scope equality', () => {
  it('requires all five fields to match', () => {
    expect(sameScope(scope(), scope())).toBe(true);
    expect(sameScope(scope(), scope({ key: 'x' }))).toBe(false);
  });
});

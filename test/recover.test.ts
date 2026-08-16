import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetRecorded, createJournal, ledgerSynced, type Scope } from '../src/journal.js';
import { recoverFromDir } from '../src/recover.js';

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
  dir = mkdtempSync(join(tmpdir(), 'easy-cast-recover-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('recover', () => {
  it('reports an empty journal as nothing outstanding', () => {
    const output = recoverFromDir(dir);
    expect(output.exitCode).toBe(0);
    expect(output.reason).toBe('recover_report');
    expect(output.nextAction).toBe('done');
    expect(output.recovery?.pending).toEqual([]);
    expect(output.recovery?.commentLedgerPersisted).toBe(true);
  });

  it('lists an upload that never reached a comment, with its scope', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'https://example.invalid/1', scope(), 't'));

    const output = recoverFromDir(dir);
    expect(output.recovery?.commentLedgerPersisted).toBe(false);
    expect(output.recovery?.pending).toEqual([
      { scope: scope(), digest: 'd1', url: 'https://example.invalid/1' },
    ]);
    expect(output.message).toContain('not yet written into a comment');
  });

  it('stops listing a record once it has been synced', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'https://example.invalid/1', scope(), 't'));
    journal.appendEvent(ledgerSynced('d1', scope(), 't'));

    expect(recoverFromDir(dir).recovery?.pending).toEqual([]);
  });

  // Every recorded asset is listed, not only the pending ones — an `upload`
  // record has no comment to be out of sync with, but it still exists forever.
  it('shows every recorded asset while keeping pending a strict subset', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'https://example.invalid/1', null, 't'));
    journal.appendEvent(assetRecorded('d2', 'https://example.invalid/2', scope(), 't'));

    const output = recoverFromDir(dir);
    expect(output.uploaded).toHaveLength(2);
    expect(output.recovery?.pending).toHaveLength(1);
    expect(output.recovery?.pending[0].digest).toBe('d2');
  });

  it('surfaces a quarantined line instead of hiding it', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'https://example.invalid/1', scope(), 't'));
    appendFileSync(journal.path, '{"v":1,"ev":"asset-record');

    const output = recoverFromDir(dir);
    expect(output.anomalies?.map((a) => a.code)).toContain('journal-line-quarantined');
    expect(output.uploaded).toHaveLength(1);
  });

  it('always discloses that uploads cannot be undone', () => {
    expect(recoverFromDir(dir).uploadsAreIrreversible).toBe(true);
  });

  it('is a single valid JSON object', () => {
    const journal = createJournal(dir);
    journal.appendEvent(assetRecorded('d1', 'https://example.invalid/1', scope(), 't'));
    expect(() => JSON.parse(JSON.stringify(recoverFromDir(dir)))).not.toThrow();
  });
});

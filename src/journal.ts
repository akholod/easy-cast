import { openSync, writeSync, closeSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { anomaly, type Anomaly } from './anomalies.js';
import { journalNotWritable } from './errors.js';

/**
 * A local write-ahead log of every irreversible upload.
 *
 * The comment ledger lives on GitHub, which means a run can succeed at uploading
 * and then fail to record what it uploaded — a lost response, a 502 on
 * createComment, a crash. Those URLs would then exist forever with nothing
 * pointing at them, and the next run would upload the same bytes again. This log
 * is written *before* any network write to GitHub, so the record survives
 * whatever happens next.
 */

export const JOURNAL_EVENT_VERSION = 1;

export interface Scope {
  readonly owner: string;
  readonly repo: string;
  readonly kind: 'pr' | 'issue';
  readonly number: number;
  readonly key: string;
}

export type JournalEvent =
  | {
      readonly v: number;
      readonly ev: 'asset-recorded';
      readonly d: string;
      readonly u: string;
      readonly at: string;
      /** `null` for the `upload` command, which has no target to sync to. */
      readonly scope: Scope | null;
    }
  | {
      readonly v: number;
      readonly ev: 'ledger-synced';
      readonly d: string;
      readonly at: string;
      readonly scope: Scope;
    };

export interface PendingRecord {
  readonly scope: Scope;
  readonly d: string;
  readonly u: string;
}

export interface JournalRead {
  readonly events: JournalEvent[];
  readonly anomalies: Anomaly[];
}

export const sameScope = (a: Scope, b: Scope): boolean =>
  a.owner === b.owner &&
  a.repo === b.repo &&
  a.kind === b.kind &&
  a.number === b.number &&
  a.key === b.key;

const scopeKey = (s: Scope): string => `${s.owner}/${s.repo}#${s.kind}:${s.number}:${s.key}`;

const isScope = (value: unknown): value is Scope => {
  if (value === null || typeof value !== 'object') return false;
  const scope = value as Record<string, unknown>;
  return (
    typeof scope.owner === 'string' &&
    typeof scope.repo === 'string' &&
    (scope.kind === 'pr' || scope.kind === 'issue') &&
    typeof scope.number === 'number' &&
    typeof scope.key === 'string'
  );
};

function isWellFormed(event: JournalEvent): boolean {
  if (typeof event.d !== 'string' || event.d === '' || typeof event.at !== 'string') return false;
  if (event.ev === 'asset-recorded') {
    return typeof event.u === 'string' && (event.scope === null || isScope(event.scope));
  }
  if (event.ev === 'ledger-synced') return isScope(event.scope);
  return false;
}

export interface Journal {
  readonly path: string;
  ensureWritable(): void;
  appendEvent(event: JournalEvent): void;
  readAll(): JournalRead;
  foldPending(): { pending: PendingRecord[]; anomalies: Anomaly[] };
  lookupScoped(digest: string, scope: Scope): string | undefined;
}

export function createJournal(stateDir: string): Journal {
  const path = join(stateDir, 'journal.jsonl');

  const ensureWritable = (): void => {
    // Checked before the first byte leaves for GitHub. Discovering the log is
    // unwritable *after* an irreversible upload is exactly the failure this
    // whole mechanism exists to prevent.
    try {
      mkdirSync(stateDir, { recursive: true });
      const probe = join(stateDir, '.write-probe');
      const fd = openSync(probe, 'w');
      closeSync(fd);
      unlinkSync(probe);
    } catch (cause) {
      throw journalNotWritable(
        `cannot write to ${stateDir}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

  const appendEvent = (event: JournalEvent): void => {
    mkdirSync(stateDir, { recursive: true });
    // One record, one write(2) on a file opened O_APPEND. A read-modify-write
    // would silently drop a concurrent process's records — reproducing the very
    // loss this log exists to prevent.
    const fd = openSync(path, 'a');
    try {
      writeSync(fd, `${JSON.stringify(event)}\n`);
    } finally {
      closeSync(fd);
    }
  };

  const readAll = (): JournalRead => {
    if (!existsSync(path)) return { events: [], anomalies: [] };

    const events: JournalEvent[] = [];
    const anomalies: Anomaly[] = [];
    const lines = readFileSync(path, 'utf8').split('\n');

    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue;
      let parsed: JournalEvent;
      try {
        parsed = JSON.parse(line) as JournalEvent;
      } catch {
        // A crash mid-write leaves a torn final line. Quarantine that one line
        // and keep the rest — truncating the file would discard good records.
        anomalies.push(anomaly('journal-line-quarantined', `line ${index + 1} did not parse`));
        continue;
      }
      // `JSON.parse` happily returns null, a number or a string. Reading `.v` off
      // one of those throws, and a damaged log must never be able to crash the
      // command whose whole job is to make a damaged log readable.
      if (parsed === null || typeof parsed !== 'object') {
        anomalies.push(anomaly('journal-line-quarantined', `line ${index + 1} is not an object`));
        continue;
      }
      if (parsed.v !== JOURNAL_EVENT_VERSION) {
        anomalies.push(
          anomaly('journal-line-quarantined', `line ${index + 1} has unknown event version ${parsed.v}`),
        );
        continue;
      }
      // A line can carry the current version and still be nonsense — a truncated
      // write that happened to end on a valid boundary, or a hand-edited file.
      // Trusting the version alone let a missing `scope` reach the fold and throw.
      if (!isWellFormed(parsed)) {
        anomalies.push(anomaly('journal-line-quarantined', `line ${index + 1} is not a well-formed event`));
        continue;
      }
      events.push(parsed);
    }
    return { events, anomalies };
  };

  const foldPending = (): { pending: PendingRecord[]; anomalies: Anomaly[] } => {
    const { events, anomalies } = readAll();

    // Folded in order, one pass. Collecting every `ledger-synced` first would let
    // an old sync cancel a *later* upload of the same digest — the sequence
    // record(u1), sync, record(u2) would report an empty backlog while u2 sat
    // in no comment at all.
    const pending = new Map<string, PendingRecord>();
    for (const event of events) {
      // `upload` records carry no scope: their delivery was printing the URL to
      // stdout, so there is no comment for them to be out of sync with.
      if (event.scope === null) continue;
      const id = `${scopeKey(event.scope)}|${event.d}`;
      if (event.ev === 'asset-recorded') pending.set(id, { scope: event.scope, d: event.d, u: event.u });
      else pending.delete(id);
    }
    return { pending: [...pending.values()], anomalies };
  };

  const lookupScoped = (digest: string, scope: Scope): string | undefined => {
    // Full scope match only. A URL recorded for another target or another --key
    // proves nothing about this one, and an uncited attachment URL answers 404,
    // so it cannot even be verified before being reused.
    for (const event of readAll().events) {
      if (event.ev !== 'asset-recorded' || event.scope === null) continue;
      if (event.d === digest && sameScope(event.scope, scope)) return event.u;
    }
    return undefined;
  };

  return { path, ensureWritable, appendEvent, readAll, foldPending, lookupScoped };
}

export const assetRecorded = (d: string, u: string, scope: Scope | null, at: string): JournalEvent => ({
  v: JOURNAL_EVENT_VERSION,
  ev: 'asset-recorded',
  d,
  u,
  at,
  scope,
});

export const ledgerSynced = (d: string, scope: Scope, at: string): JournalEvent => ({
  v: JOURNAL_EVENT_VERSION,
  ev: 'ledger-synced',
  d,
  at,
  scope,
});

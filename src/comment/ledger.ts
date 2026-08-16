import { anomaly, type Anomaly } from '../anomalies.js';

/**
 * The ledger maps an uploaded file's digest to the URL it got, and rides along
 * inside the tool's own comment as an HTML comment so it travels with the target
 * rather than with the machine.
 *
 * Without it every repeat run would upload the same bytes again, and the old
 * attachment would stay behind forever — attachments cannot be deleted.
 */

export type LedgerEntry = readonly [digest: string, url: string];

export const LEDGER_VERSION = 1;
export const LEDGER_CAP = 64;

const OPEN = `<!-- easy-cast:ledger:v${LEDGER_VERSION} `;
const CLOSE = ' -->';
/** Matches any version, so a block we cannot read is still recognised as ours. */
const ANY_VERSION = /<!-- easy-cast:ledger:v(\d+) ([\s\S]*?) -->/g;

export interface LedgerRead {
  readonly entries: LedgerEntry[];
  /** The block was ours and current, but its payload did not parse. */
  readonly malformed: boolean;
  /** The block was ours but from another format version — left untouched. */
  readonly quarantined: boolean;
  readonly anomalies: Anomaly[];
}

export function parseLedger(commentBody: string): LedgerRead {
  const matches = [...commentBody.matchAll(ANY_VERSION)];
  if (matches.length === 0) {
    return { entries: [], malformed: false, quarantined: false, anomalies: [] };
  }

  const anomalies: Anomaly[] = [];
  if (matches.length > 1) {
    anomalies.push(
      anomaly('duplicate-ledger-delimiter', `found ${matches.length} ledger blocks, using the first`),
    );
  }

  const [, version, payload] = matches[0];
  if (Number(version) !== LEDGER_VERSION) {
    // A future format might mean something we would get wrong, and acting on a
    // wrong reuse decision costs an upload that cannot be taken back.
    anomalies.push(
      anomaly('ledger-block-quarantined', `ledger format v${version} is newer than v${LEDGER_VERSION}`),
    );
    return { entries: [], malformed: false, quarantined: true, anomalies };
  }

  try {
    const parsed = JSON.parse(payload) as { v?: number; entries?: unknown };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : null;
    if (!entries) throw new Error('entries missing');

    const kept: LedgerEntry[] = [];
    for (const entry of entries) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string'
      ) {
        kept.push([entry[0], entry[1]] as LedgerEntry);
      }
    }
    return { entries: kept, malformed: false, quarantined: false, anomalies };
  } catch {
    // Read as empty rather than as a failure: a damaged ledger costs one repeat
    // upload, whereas refusing to proceed would strand the run entirely.
    anomalies.push(anomaly('malformed-ledger', 'ledger payload did not parse; treated as empty'));
    return { entries: [], malformed: true, quarantined: false, anomalies };
  }
}

/**
 * Order is most-recently-used, newest first, and eviction takes from the tail.
 * FIFO would evict a file used in every single run once 64 other files had gone
 * past it, and re-uploading it is irreversible.
 */
export function serializeLedger(entries: readonly LedgerEntry[]): string {
  const capped = entries.slice(0, LEDGER_CAP);
  return `${OPEN}${JSON.stringify({ v: LEDGER_VERSION, entries: capped })}${CLOSE}`;
}

/** Puts `digest` at the head, replacing any existing record of it. */
export function touchEntry(
  entries: readonly LedgerEntry[],
  digest: string,
  url: string,
): LedgerEntry[] {
  return [[digest, url] as LedgerEntry, ...entries.filter(([existing]) => existing !== digest)];
}

export function lookupEntry(entries: readonly LedgerEntry[], digest: string): string | undefined {
  return entries.find(([existing]) => existing === digest)?.[1];
}

export function hasLedgerBlock(commentBody: string): boolean {
  ANY_VERSION.lastIndex = 0;
  return ANY_VERSION.test(commentBody);
}

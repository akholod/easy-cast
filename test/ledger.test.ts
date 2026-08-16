import { describe, expect, it } from 'vitest';
import {
  LEDGER_CAP,
  hasLedgerBlock,
  lookupEntry,
  parseLedger,
  serializeLedger,
  touchEntry,
  type LedgerEntry,
} from '../src/comment/ledger.js';

const entries = (count: number): LedgerEntry[] =>
  Array.from({ length: count }, (_, i) => [`digest-${i}`, `https://example.invalid/${i}`] as LedgerEntry);

describe('round trip', () => {
  it('reads back exactly what it wrote', () => {
    const original = entries(3);
    expect(parseLedger(serializeLedger(original)).entries).toEqual(original);
  });

  it('survives being embedded in a comment body with other content', () => {
    const body = `<!-- easy-cast:v1:attach:k -->\ncaption\n![a](u)\n\n${serializeLedger(entries(2))}`;
    expect(parseLedger(body).entries).toEqual(entries(2));
  });

  it('finds no entries and reports nothing wrong when there is no block', () => {
    expect(parseLedger('just a comment')).toEqual({
      entries: [],
      malformed: false,
      quarantined: false,
      anomalies: [],
    });
    expect(hasLedgerBlock('just a comment')).toBe(false);
  });
});

describe('most-recently-used ordering', () => {
  // FIFO would evict a file used in every run once 64 others passed it, and
  // re-uploading is irreversible — so a hit must move the record to the head.
  it('moves a touched entry to the head instead of leaving it in place', () => {
    const start = entries(3);
    const touched = touchEntry(start, 'digest-2', 'https://example.invalid/2');
    expect(touched[0]).toEqual(['digest-2', 'https://example.invalid/2']);
    expect(touched).toHaveLength(3);
  });

  it('replaces rather than duplicates when the digest is already present', () => {
    const touched = touchEntry(entries(2), 'digest-0', 'https://example.invalid/new');
    expect(touched.filter(([d]) => d === 'digest-0')).toHaveLength(1);
    expect(touched[0][1]).toBe('https://example.invalid/new');
  });

  it('adds an unseen digest at the head', () => {
    expect(touchEntry(entries(1), 'fresh', 'u')[0]).toEqual(['fresh', 'u']);
  });

  it('looks up a stored url by digest', () => {
    expect(lookupEntry(entries(3), 'digest-1')).toBe('https://example.invalid/1');
    expect(lookupEntry(entries(3), 'absent')).toBeUndefined();
  });
});

describe('capacity', () => {
  it('keeps every entry up to the cap', () => {
    expect(parseLedger(serializeLedger(entries(LEDGER_CAP))).entries).toHaveLength(LEDGER_CAP);
  });

  it('evicts from the tail once a 65th entry arrives', () => {
    const overflowing = touchEntry(entries(LEDGER_CAP), 'newest', 'https://example.invalid/new');
    const stored = parseLedger(serializeLedger(overflowing)).entries;

    expect(stored).toHaveLength(LEDGER_CAP);
    expect(stored[0]).toEqual(['newest', 'https://example.invalid/new']);
    // The oldest record, not the newest, is the one that goes.
    expect(stored.some(([d]) => d === `digest-${LEDGER_CAP - 1}`)).toBe(false);
  });
});

describe('damaged and unfamiliar blocks', () => {
  it('reads a damaged payload as empty and says so, without throwing', () => {
    const result = parseLedger('<!-- easy-cast:ledger:v1 {not json} -->');
    expect(result.entries).toEqual([]);
    expect(result.malformed).toBe(true);
    expect(result.anomalies.map((a) => a.code)).toContain('malformed-ledger');
  });

  it('drops entries of the wrong shape rather than trusting them', () => {
    const body = '<!-- easy-cast:ledger:v1 {"v":1,"entries":[["ok","u"],["bad"],42]} -->';
    expect(parseLedger(body).entries).toEqual([['ok', 'u']]);
  });

  // D19: an unknown version is quarantined, never interpreted. Guessing at a
  // future format could produce a wrong reuse decision, and that costs an upload
  // that can never be withdrawn.
  it('quarantines a block from a newer format instead of interpreting it', () => {
    const result = parseLedger('<!-- easy-cast:ledger:v2 {"v":2,"entries":[["d","u"]]} -->');
    expect(result.entries).toEqual([]);
    expect(result.quarantined).toBe(true);
    expect(result.malformed).toBe(false);
    expect(result.anomalies.map((a) => a.code)).toContain('ledger-block-quarantined');
  });

  it('uses the first block and flags the duplicate when two are present', () => {
    const body = `${serializeLedger([['a', 'first']])}\n${serializeLedger([['b', 'second']])}`;
    const result = parseLedger(body);
    expect(result.entries).toEqual([['a', 'first']]);
    expect(result.anomalies.map((a) => a.code)).toContain('duplicate-ledger-delimiter');
  });
});

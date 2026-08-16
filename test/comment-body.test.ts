import { describe, expect, it } from 'vitest';
import {
  BODY_BUDGET_BYTES,
  composeBody,
  estimateBodyBytes,
  replaceLedgerBlock,
} from '../src/comment/body.js';
import { serializeLedger, parseLedger, type LedgerEntry } from '../src/comment/ledger.js';
import { defaultKey, findMarkers, hasOurMarker, marker, validateKey } from '../src/comment/marker.js';
import { renderBatch } from '../src/render.js';
import { EasyCastError } from '../src/errors.js';

describe('marker key grammar', () => {
  it.each(['a', 'attach-0badc0de', 'a.b_c-d', 'x'.repeat(64)])('accepts %s', (key) => {
    expect(validateKey(key)).toBe(key);
  });

  // These are the shapes that could terminate the HTML comment early or forge a
  // second marker, so the alphabet is restricted rather than escaped.
  it.each([
    ['empty', ''],
    ['leading dash', '-lead'],
    ['a space', 'has space'],
    ['a comment terminator', 'a-->b'],
    ['a newline', 'a\nb'],
    ['an angle bracket', 'a>b'],
    ['uppercase', 'Key'],
    ['too long', 'x'.repeat(65)],
  ])('rejects %s with exit 2 bad_key', (_label, key) => {
    try {
      validateKey(key);
      expect.unreachable('expected validateKey to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EasyCastError);
      expect((error as EasyCastError).reason).toBe('bad_key');
      expect((error as EasyCastError).outcome.exitCode).toBe(2);
    }
  });
});

describe('default key', () => {
  it('is derived from the source hashes, so it never depends on ffmpeg being present', () => {
    expect(defaultKey('attach', ['a', 'b'])).toBe(defaultKey('attach', ['a', 'b']));
  });

  it('does not depend on the order the files were given in', () => {
    expect(defaultKey('attach', ['a', 'b'])).toBe(defaultKey('attach', ['b', 'a']));
  });

  // A second attach of different files gets its own comment rather than silently
  // replacing evidence already posted.
  it('differs for a different set of files', () => {
    expect(defaultKey('attach', ['a', 'b'])).not.toBe(defaultKey('attach', ['a', 'c']));
  });

  it('always satisfies its own grammar', () => {
    expect(() => validateKey(defaultKey('attach', ['a']))).not.toThrow();
  });
});

describe('marker recognition', () => {
  it('finds our marker and reads its key back', () => {
    expect(findMarkers(marker('attach-abc'))).toEqual([
      { version: 1, kind: 'attach', key: 'attach-abc' },
    ]);
    expect(hasOurMarker(marker('attach-abc'), 'attach-abc')).toBe(true);
  });

  // D19: a marker from a newer format is not ours to rewrite. Misreading the
  // structure of someone else's comment is worse than posting a new one.
  it('does not claim a marker from an unknown format version', () => {
    const future = '<!-- easy-cast:v9:attach:attach-abc -->';
    expect(hasOurMarker(future, 'attach-abc')).toBe(false);
    expect(findMarkers(future)[0].version).toBe(9);
  });

  it('does not claim a marker belonging to a different key', () => {
    expect(hasOurMarker(marker('other'), 'attach-abc')).toBe(false);
  });
});

describe('compose path', () => {
  it('lays out marker, caption, attachments and ledger in that order', () => {
    const body = composeBody({
      marker: marker('k'),
      caption: 'before and after',
      rendered: ['![a.png](https://example.invalid/a)'],
      ledger: serializeLedger([['d', 'https://example.invalid/a']]),
    });

    expect(body.startsWith(marker('k'))).toBe(true);
    expect(body).toContain('before and after');
    expect(parseLedger(body).entries).toEqual([['d', 'https://example.invalid/a']]);
  });

  it('omits the caption block when there is none', () => {
    const body = composeBody({ marker: marker('k'), rendered: [], ledger: serializeLedger([]) });
    expect(body).toBe(`${marker('k')}\n\n${serializeLedger([])}`);
  });

  it('escapes a caption so it cannot introduce markup or a stray newline', () => {
    const body = composeBody({
      marker: marker('k'),
      caption: 'nasty ](x) \\ end',
      rendered: [],
      ledger: serializeLedger([]),
    });
    expect(body).not.toContain('](x)');
  });
});

describe('ledger-only path', () => {
  const foreign = 'a human wrote this\n\nand this';

  it('swaps only the delimited block and passes the rest through byte for byte', () => {
    const before = `${foreign}\n\n${serializeLedger([['old', 'u1']])}`;
    const { body } = replaceLedgerBlock(before, serializeLedger([['new', 'u2']]));

    expect(body).toContain(foreign);
    expect(parseLedger(body).entries).toEqual([['new', 'u2']]);
    expect(body.startsWith(foreign)).toBe(true);
  });

  it('appends a block when the body has none yet', () => {
    const { body } = replaceLedgerBlock(foreign, serializeLedger([['d', 'u']]));
    expect(body.startsWith(foreign)).toBe(true);
    expect(parseLedger(body).entries).toEqual([['d', 'u']]);
  });

  it('replaces the first block and flags the duplicate', () => {
    const two = `${serializeLedger([['a', 'u']])}\n${serializeLedger([['b', 'u']])}`;
    const { anomalies } = replaceLedgerBlock(two, serializeLedger([['c', 'u']]));
    expect(anomalies.map((a) => a.code)).toContain('duplicate-ledger-delimiter');
  });

});

describe('size budget', () => {
  // The URL is unknown until after the upload the budget is meant to gate, so the
  // estimate must never come in under the truth — being wrong low would let a body
  // blow past GitHub's limit once the irreversible uploads had already happened.
  it('is an upper bound on the real body across 20 generated cases', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const fileCount = (seed % 7) + 1;
      const ledgerCount = (seed * 3) % 70;
      const files = Array.from({ length: fileCount }, (_, i) => ({
        name: `shot-${'x'.repeat((seed * i) % 40)}-${i}.png`,
        category: 'image' as const,
      }));
      const caption = seed % 3 === 0 ? undefined : `caption ${'y'.repeat(seed * 2)}`;
      const key = 'attach-0badc0de';

      const entries: LedgerEntry[] = Array.from(
        { length: Math.min(ledgerCount, 64) },
        (_, i) => [`${'f'.repeat(64)}:profile-${i}`, `https://github.com/user-attachments/assets/${'0'.repeat(36)}`],
      );

      const actual = composeBody({
        marker: marker(key),
        caption,
        rendered: [
          renderBatch(
            files.map((file, i) => ({
              ...file,
              url: `https://github.com/user-attachments/assets/${'0'.repeat(36)}-${i}`,
            })),
          ),
        ],
        ledger: serializeLedger(entries),
      });

      const estimate = estimateBodyBytes({
        marker: marker(key),
        caption,
        files,
        ledgerEntryCount: entries.length,
      });

      expect(estimate).toBeGreaterThanOrEqual(Buffer.byteLength(actual));
    }
  });

  it('leaves headroom below the limit GitHub actually enforces', () => {
    expect(BODY_BUDGET_BYTES).toBeLessThan(65_536);
  });

  it('grows with the number of attachments and with the ledger', () => {
    const base = { marker: marker('k'), files: [], ledgerEntryCount: 0 };
    const withFile = estimateBodyBytes({
      ...base,
      files: [{ name: 'a.png', category: 'image' as const }],
    });
    expect(withFile).toBeGreaterThan(estimateBodyBytes(base));
    expect(estimateBodyBytes({ ...base, ledgerEntryCount: 10 })).toBeGreaterThan(
      estimateBodyBytes(base),
    );
  });

  it('stops growing past the ledger cap, because the ledger itself does', () => {
    const base = { marker: marker('k'), files: [] };
    expect(estimateBodyBytes({ ...base, ledgerEntryCount: 200 })).toBe(
      estimateBodyBytes({ ...base, ledgerEntryCount: 64 }),
    );
  });
});

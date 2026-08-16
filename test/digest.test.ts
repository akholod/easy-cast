import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSource, sha256Hex } from '../src/media/snapshot.js';
import { computeDigest, computeSourceHash } from '../src/media/digest.js';

let dir: string;
const file = (name: string, content: string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'easy-cast-digest-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Canonical vector: sha256 of the empty input, so a change in the hashing
// construction fails loudly rather than merely producing a different-but-stable value.
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('source hash', () => {
  it('matches the canonical sha256 of the bytes', () => {
    expect(computeSourceHash(captureSource(file('empty.png', '')))).toBe(EMPTY_SHA256);
  });

  it('is identical for byte-identical files with different names', () => {
    const a = computeSourceHash(captureSource(file('a.png', 'same bytes')));
    const b = computeSourceHash(captureSource(file('b.png', 'same bytes')));
    expect(a).toBe(b);
  });

  it('does not depend on the conversion profile', () => {
    const snapshot = captureSource(file('clip.webm', 'video bytes'));
    expect(computeSourceHash(snapshot)).toBe(sha256Hex(snapshot.bytes));
  });
});

describe('digest', () => {
  it('combines the source bytes with the profile actually applied', () => {
    const snapshot = captureSource(file('clip2.webm', 'video bytes'));
    expect(computeDigest(snapshot, 'h264-crf30')).toBe(`${sha256Hex(snapshot.bytes)}:h264-crf30`);
  });

  // The bug this guards: computing the digest before conversion recorded WebM
  // bytes under the mp4 profile's id, so a later run with ffmpeg present reused
  // the WebM URL where mp4 was intended.
  it('differs when conversion degraded, for the very same bytes', () => {
    const snapshot = captureSource(file('clip3.webm', 'video bytes'));
    expect(computeDigest(snapshot, 'none')).not.toBe(computeDigest(snapshot, 'h264-crf30'));
  });
});

describe('source snapshot', () => {
  it('captures the bytes once and reports their length', () => {
    const snapshot = captureSource(file('shot.png', 'hello world'));
    expect(snapshot.bytes.toString()).toBe('hello world');
    expect(snapshot.byteLength).toBe(11);
  });

  // TOCTOU: everything downstream must read from the captured buffer, never from
  // the path again — an upload cannot be withdrawn if the file changed underneath.
  it('is unaffected by the file changing after capture', () => {
    const path = file('mutable.png', 'original');
    const snapshot = captureSource(path);
    const before = computeSourceHash(snapshot);

    writeFileSync(path, 'tampered');
    utimesSync(path, new Date(), new Date());

    expect(snapshot.bytes.toString()).toBe('original');
    expect(computeSourceHash(snapshot)).toBe(before);
    expect(computeSourceHash(captureSource(path))).not.toBe(before);
  });

  it('records identity metadata so a caller can detect the file moving', () => {
    const snapshot = captureSource(file('ident.png', 'x'));
    expect(snapshot.inode).toBeGreaterThan(0);
    expect(snapshot.mtimeMs).toBeGreaterThan(0);
  });
});

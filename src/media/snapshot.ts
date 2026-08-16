import { createHash } from 'node:crypto';
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

/**
 * A source file, read exactly once.
 *
 * Everything downstream — the source hash, the plan token, the conversion input
 * and the uploaded body — is derived from these bytes and never from a second
 * read of the path. Re-reading would open a window where the plan is computed
 * over one set of bytes and a different set is uploaded, and an upload cannot be
 * taken back (D16).
 */
export interface SourceSnapshot {
  readonly path: string;
  readonly bytes: Buffer;
  readonly byteLength: number;
  /** Recorded so a caller can tell whether the file moved under us since capture. */
  readonly inode: number;
  readonly mtimeMs: number;
}

export function captureSource(path: string): SourceSnapshot {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, bytes, offset, stat.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return {
      path,
      bytes: offset === stat.size ? bytes : bytes.subarray(0, offset),
      byteLength: offset,
      inode: Number(stat.ino),
      mtimeMs: stat.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

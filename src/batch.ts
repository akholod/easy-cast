import { basename } from 'node:path';
import { badArgs, unsupportedExtension } from './errors.js';
import { computeSourceHash } from './media/digest.js';
import { classifyExtension, checkSize } from './media/mime.js';
import { captureSource, type SourceSnapshot } from './media/snapshot.js';
import type { UploadedFileReport } from './output.js';

/**
 * What `attach` and `upload` agree on about a batch of files.
 *
 * The two commands differ in everything after the bytes leave — one writes a
 * comment and deduplicates, the other prints URLs and does neither. They must not
 * differ in what they accept, in what order they upload it, or in how they name
 * the worst failure, so those rules live here once rather than twice.
 */

export interface PreparedFile {
  readonly snapshot: SourceSnapshot;
  readonly sourceHash: string;
  readonly name: string;
  readonly contentType: string;
  readonly category: 'image' | 'video';
  readonly sizeVerdict: 'ok' | 'warn';
  /**
   * Every input path that resolved to these bytes, first occurrence first.
   *
   * Usually one. Two entries mean the caller named the same content twice under
   * different paths — a copy of a screenshot, say. It is uploaded once, but a
   * report still has to be able to place *both* references, so the mapping from
   * path to result cannot be built from the canonical path alone.
   */
  readonly paths: readonly string[];
}

/**
 * Reads every file exactly once and refuses the whole batch if any of them is
 * unusable.
 *
 * Validating everything before the first upload is what makes "the third file was
 * bad, so nothing was uploaded" true. Validating lazily would leave two permanent
 * attachments behind before discovering the problem.
 */
export function prepare(files: readonly string[]): PreparedFile[] {
  const prepared: PreparedFile[] = [];
  const byHash = new Map<string, string[]>();

  for (const path of files) {
    const snapshot = captureSource(path);
    const sourceHash = computeSourceHash(snapshot);
    // First occurrence wins, matching the plan token's own de-duplication, so the
    // same file named twice is uploaded once rather than twice. The later path is
    // still remembered: something may need to refer to the result by that name.
    const already = byHash.get(sourceHash);
    if (already) {
      already.push(path);
      continue;
    }
    const paths = [path];
    byHash.set(sourceHash, paths);

    const name = basename(path);
    const kind = classifyExtension(name);
    if (!kind) {
      throw unsupportedExtension(
        `${name} is not a file type GitHub accepts as an attachment. Nothing was uploaded.`,
      );
    }

    const size = checkSize(snapshot.byteLength, kind);
    if (size.level === 'reject') {
      throw badArgs(`${name}: ${size.message}. Nothing was uploaded.`);
    }

    prepared.push({
      snapshot,
      sourceHash,
      name,
      contentType: kind.contentType,
      category: kind.category,
      sizeVerdict: size.level,
      // The array, not a copy: later duplicates push into it as they are found.
      paths,
    });
  }

  if (prepared.length === 0) throw badArgs('no files to attach');
  return prepared;
}

/**
 * Conversion produced mp4 bytes, so the name has to say mp4 too: the endpoint
 * validates the declared type against the file name, and one observed 422
 * complained about exactly that mismatch.
 */
export const asMp4 = (name: string): string => `${name.replace(/\.[^.]+$/, '')}.mp4`;

export const base = (file: PreparedFile, digest: string) => ({
  name: file.name,
  sourceHash: file.sourceHash,
  digest,
});

export type FailureReason =
  | 'endpoint_unavailable'
  | 'no_access_or_not_found'
  | 'rejected_by_endpoint'
  | 'network_unreachable';

/** Worst first. Order is severity, not file order. */
const SEVERITY: readonly FailureReason[] = [
  'endpoint_unavailable',
  'no_access_or_not_found',
  'rejected_by_endpoint',
  'network_unreachable',
];

/**
 * The most serious reason in the batch, not the first one encountered.
 *
 * Taking the first would let a batch whose opening failure was a transient
 * network error report `network_unreachable` — and therefore "retry" — even
 * though a later file had been permanently refused. The answer must not depend on
 * the order the files happened to be listed in.
 */
export function worstFailureReason(reports: readonly UploadedFileReport[]): FailureReason {
  const seen = new Set(reports.map((report) => report.failure?.reason));
  return SEVERITY.find((reason) => seen.has(reason)) ?? 'network_unreachable';
}

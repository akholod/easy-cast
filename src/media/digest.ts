import { sha256Hex, type SourceSnapshot } from './snapshot.js';

/**
 * Two different identities, deliberately kept apart.
 *
 * `sourceHash` names the bytes the user pointed at. It is available before any
 * conversion runs, which is what makes it usable for the default `--key` and for
 * the plan token — both of those must not change just because ffmpeg happens to
 * be missing on this machine.
 *
 * `digest` names what was actually uploaded: the same bytes *plus* the profile
 * that was actually applied. Computing it before conversion was a real bug in an
 * earlier design — a degraded run would have recorded WebM bytes under the mp4
 * profile's id, and the next run on a machine with ffmpeg would have silently
 * reused the WebM URL where mp4 was intended.
 */
export function computeSourceHash(snapshot: SourceSnapshot): string {
  return sha256Hex(snapshot.bytes);
}

/** Must only be called with the profile id that conversion actually applied. */
export function computeDigest(snapshot: SourceSnapshot, effectiveProfileId: string): string {
  return `${sha256Hex(snapshot.bytes)}:${effectiveProfileId}`;
}

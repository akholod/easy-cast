import { createHash } from 'node:crypto';
import { badKey } from '../errors.js';

/**
 * The marker is how the tool recognises its own comment on a later run. It is
 * the whole of level-one idempotency: lose the ability to find the comment and
 * every repeat run posts a new one and re-uploads attachments that can never be
 * deleted.
 */

export const MARKER_VERSION = 1;

/**
 * One kind, and `report` shares it.
 *
 * The segment names the *family of comment* — one this tool owns, carrying
 * attachments and a ledger — not the command that produced it. A report writes
 * exactly that comment; only its visible arrangement differs. What keeps the two
 * from fighting over the same comment is the key, whose default is namespaced by
 * command (`attach-…` versus `report-…`).
 *
 * Splitting the kind would change a format already written into permanent
 * comments, to record something the key already records.
 */
export type MarkerKind = 'attach';

/**
 * Deliberately narrow. The key is interpolated into an HTML comment, so anything
 * able to contain `>`, a newline, or a quote could terminate the marker early and
 * let a crafted key hide or forge one.
 */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const marker = (key: string): string => `<!-- easy-cast:v${MARKER_VERSION}:attach:${key} -->`;

const ANY_MARKER = /<!-- easy-cast:v(\d+):([a-z]+):([^\s>]*) -->/g;

export interface ParsedMarker {
  readonly version: number;
  readonly kind: string;
  readonly key: string;
}

export function validateKey(key: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw badKey(
      `--key must match ${KEY_PATTERN.source}; got ${JSON.stringify(key)}. ` +
        'The key is embedded in an HTML comment, so its alphabet is restricted on purpose.',
    );
  }
  return key;
}

/**
 * Derived from the source bytes, not from the converted output, so the same call
 * addresses the same comment whether or not ffmpeg happens to exist here.
 *
 * Including the file set means a second `attach` of *different* files gets its own
 * comment rather than silently replacing the evidence already posted. Passing an
 * explicit `--key` is how a caller asks to replace instead.
 */
export function defaultKey(command: 'upload' | 'attach' | 'report', sourceHashes: readonly string[]): string {
  const digest = createHash('sha256').update([...sourceHashes].sort().join('\n')).digest('hex');
  return `${command}-${digest.slice(0, 8)}`;
}

export function findMarkers(body: string): ParsedMarker[] {
  return [...body.matchAll(ANY_MARKER)].map(([, version, kind, key]) => ({
    version: Number(version),
    kind,
    key,
  }));
}

/**
 * A marker from a format we do not know is not treated as ours (D19). Rewriting a
 * comment whose structure we might misread is worse than posting a new one.
 */
function isOurMarker(parsed: ParsedMarker, key: string): boolean {
  return parsed.version === MARKER_VERSION && parsed.kind === 'attach' && parsed.key === key;
}

export function hasOurMarker(body: string, key: string): boolean {
  return findMarkers(body).some((parsed) => isOurMarker(parsed, key));
}

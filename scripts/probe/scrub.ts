import { redact } from '../../src/secret/redact.js';

/**
 * Everything written to `fixtures/endpoint/observations.jsonl` goes through here.
 *
 * This package is published publicly, so those fixtures reach the npm tarball and
 * GitHub. A secret recorded in an observation is a secret published.
 *
 * Scrubbing is **structural**, by key, not only by pattern over each string. An
 * earlier version walked the record value by value and applied a regex that
 * expected `key: value` together — which meant it never matched anything, because
 * by then the key and the value were separate strings. Request ids sat in the
 * committed fixture as a result. Anything sensitive because of *where it sits*
 * has to be redacted by its position, not by what it looks like.
 */

const ASSET_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Redacted wherever they appear as a key, whatever the value looks like. */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'set-cookie',
  'cookie',
  'x-github-request-id',
  'x-github-delivery',
  'x-request-id',
  'etag',
]);

export const REDACTED = '[redacted]';

/**
 * A request id can also appear inside a response body, where it is a value in
 * free text rather than a key in the record. The structural pass above cannot see
 * that one, so both rules exist: by key for headers, by pattern for prose.
 */
const REQUEST_ID_IN_TEXT = /("?(?:x-github-)?request[_-]?id"?\s*[:=]\s*"?)([^",\s}]+)/gi;

/** Pattern-based rules, applied to every string wherever it sits. */
export function scrubText(text: string): string {
  return redact(text).replace(REQUEST_ID_IN_TEXT, `$1${REDACTED}`).replace(ASSET_UUID, REDACTED);
}

export function scrubObservation<T>(record: T): T {
  return walk(record) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) =>
        SENSITIVE_KEYS.has(key.toLowerCase()) ? [key, REDACTED] : [key, walk(inner)],
      ),
    );
  }
  return value;
}

/** The serialised form, so no caller can reach the file without passing through here. */
export const serializeObservation = (record: unknown): string =>
  `${JSON.stringify(scrubObservation(record))}\n`;

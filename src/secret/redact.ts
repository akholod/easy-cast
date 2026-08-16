/**
 * The single redactor.
 *
 * An uploaded attachment cannot be deleted and a leaked token cannot be taken
 * back, so a secret that reaches stdout, stderr, JSON or a debug log is the worst
 * failure this tool has. Everything that gets printed passes through here — and
 * through nothing else, because a second redactor is a second place to forget a
 * pattern.
 */

const MASK = '[redacted]';

/** Classic, OAuth, user, server and refresh tokens, plus fine-grained PATs. */
const GITHUB_TOKEN = /\bgh[posru]_[A-Za-z0-9_]{16,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g;

/**
 * Header lines and JSON-ish key/value pairs alike. The quoting that was found is
 * re-emitted so that redacting a serialized JSON document leaves it parseable —
 * `--json` promises exactly one valid object on stdout whatever else happens.
 */
const SECRET_HEADER = /((?:authorization|set-cookie)"?\s*[:=]\s*)("?)[^"\r\n]*\2/gi;

/** Signed URLs: GitHub asset links carry `?jwt=`, their storage redirects `X-Amz-*`. */
const SECRET_QUERY = /([?&](?:jwt|token|sig|X-Amz-[A-Za-z0-9-]*)=)[^&\s"'<>)\\]*/gi;

export function redact(text: string): string {
  return text
    .replace(GITHUB_TOKEN, MASK)
    .replace(SECRET_HEADER, `$1$2${MASK}$2`)
    .replace(SECRET_QUERY, `$1${MASK}`);
}

/**
 * Redacts the values, not the serialized document.
 *
 * Running {@link redact} over already-serialized JSON can eat an escaped quote
 * inside a string and leave output that no longer parses — which would break the
 * one-valid-object promise in exactly the situation that promise exists for.
 * Redacting before serialization has no such failure mode: `JSON.stringify` then
 * escapes whatever is left.
 */
export const redactValues = <T>(value: T): T => mapStringsDeep(value, redact);

/**
 * Shared by the probe's observation scrubber, which needs the same traversal with
 * a stricter leaf function. One traversal, so a container type that one copy
 * handled and the other forgot cannot exist.
 */
export function mapStringsDeep<T>(value: T, fn: (text: string) => string): T {
  return walk(value, fn) as T;
}

function walk(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, fn));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner, fn)]));
  }
  return value;
}

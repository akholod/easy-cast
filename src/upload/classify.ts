import { redact } from '../secret/redact.js';
import type { UploadOutcome } from './port.js';

/**
 * Turns a response into an outcome.
 *
 * Total by construction: anything not matched below is `endpoint_unavailable`,
 * meaning the state of the remote side is unknown and must never be retried. An
 * upload cannot be withdrawn, so an unrecognised answer is the one case where
 * guessing is most expensive.
 *
 * Every row here was produced by a real request — see docs/endpoint-semantics.md
 * and fixtures/endpoint/classification.json.
 */

export const CLASSIFICATION_VERSION = 2;
export const CLASSIFICATION_PROVENANCE =
  'stage 0, 2026-08-16 and 2026-08-17, akholod/easy-cast-probe and akholod/easy-cast-probe-public';

interface Rejection {
  readonly field?: string;
  readonly message?: string;
}

export function classifyUploadResponse(
  status: number,
  _headers: Record<string, string | string[]>,
  body: string,
): UploadOutcome {
  if (status === 201) {
    const url = extractUrl(body);
    // A 201 whose body we cannot read is not a success we can act on: we would
    // have created an attachment and lost its only identifier. The URL must also
    // look like the one the endpoint actually returns — accepting any string
    // would let a changed response shape through as a success.
    if (url) return { ok: true, url };
    return unavailable(status, body, 'the endpoint answered 201 but no usable url could be read from the body');
  }

  // Status alone is not enough. The table was built from bodies as well as codes,
  // and a familiar code carrying an unfamiliar body means the endpoint has changed
  // under us — which is exactly the case that must not be reported confidently.
  if (status === 404 && !looksLikeNotFound(body)) return unavailable(status, body);
  if (status === 422 && !looksLikeRejection(body)) return unavailable(status, body);

  if (status === 404) {
    // Three unrelated causes produce a byte-identical response: a wrong
    // repository_id, a repository we can read but not push to, and an omitted
    // repository_id. Naming one would be a guess dressed as a diagnosis.
    return {
      ok: false,
      code: 1,
      reason: 'no_access_or_not_found',
      state: 'known',
      retryable: false,
      message:
        'the endpoint answered 404. That means one of: this token cannot push to the repository, ' +
        'the repository does not exist, or the repository id is wrong. The endpoint gives the same ' +
        'answer to all three, so this cannot be narrowed down from here.',
    };
  }

  // 422 only. A 400 was seen during exploratory work but never recorded, so it is
  // not a row in the table and falls to the default — asserting a classification
  // no observation supports is the habit stage 0 existed to break.
  if (status === 422) {
    return {
      ok: false,
      code: 1,
      reason: 'rejected_by_endpoint',
      state: 'known',
      retryable: false,
      message: describeRejection(status, body),
    };
  }

  return unavailable(status, body);
}

/**
 * The exact shape stage 0 recorded, down to the UUID layout. A looser pattern let
 * `assets/--------` through as a success, which would mean reporting an upload we
 * could never find again.
 */
const ASSET_URL =
  /^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractUrl(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { url?: unknown };
    return typeof parsed.url === 'string' && ASSET_URL.test(parsed.url) ? parsed.url : undefined;
  } catch {
    return undefined;
  }
}

/** Exactly the body stage 0 recorded, not merely one that mentions the phrase. */
const looksLikeNotFound = (body: string): boolean => readMessage(body) === 'Not Found';

/**
 * The recorded rejection shape, and only that.
 *
 * Accepting any non-empty `message` was too generous: a `422 {"message":"Rate
 * limited"}` would have been reported as "the endpoint refused this file", sending
 * the caller to fix a file that was never the problem. A 422 that does not look
 * like the validation failure stage 0 saw is an unknown.
 */
const REJECTION_FIELDS = new Set(['content_type', 'name', 'size']);

function looksLikeRejection(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; errors?: unknown };
    if (!Array.isArray(parsed.errors) || parsed.errors.length === 0) return false;
    return (parsed.errors as Rejection[]).some(
      (error) => typeof error?.field === 'string' && REJECTION_FIELDS.has(error.field),
    );
  } catch {
    return false;
  }
}

function readMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A 422 body can carry more than one reason at once — a `.png` declared as
 * `application/octet-stream` returns both "not an allowed content type" and
 * "extension does not match". Reporting whichever matched first would send the
 * caller to fix the wrong thing, so all of them are reported.
 */
function describeRejection(status: number, body: string): string {
  const reasons = new Set<string>();
  try {
    const parsed = JSON.parse(body) as { message?: unknown; errors?: unknown };
    if (Array.isArray(parsed.errors)) {
      for (const error of parsed.errors as Rejection[]) {
        if (typeof error?.message === 'string') reasons.add(error.message);
      }
    }
    if (reasons.size === 0 && typeof parsed.message === 'string') reasons.add(parsed.message);
  } catch {
    // Not JSON; the raw excerpt below is the only evidence there is.
  }

  const detail = reasons.size > 0 ? [...reasons].map(plainText).join('; ') : redact(body).slice(0, 300);
  return `the endpoint refused the file (HTTP ${status}): ${detail}`;
}

/**
 * The endpoint's messages are written for its web UI, not for a caller of an API.
 * The observed size rejection reads:
 *
 *   size Yowza that's a big file. <span class='drag-and-drop-error-info'>
 *   <span class='btn-link'>Try again</span> with a file size less than 10MB.</span>
 *
 * Passing that through verbatim hands an agent markup and a button label to
 * interpret. The wording is kept exactly as sent — only the tags go, because they
 * describe a page nobody here is looking at. The raw body is still recorded
 * unaltered in the observation log; this affects the message, not the evidence.
 */
const plainText = (message: string): string =>
  message
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function unavailable(status: number, body: string, extra?: string): UploadOutcome {
  return {
    ok: false,
    code: 5,
    reason: 'endpoint_unavailable',
    state: 'unknown',
    retryable: false,
    message:
      `${extra ?? `the endpoint answered ${status}, which is not a response this tool knows how to read`}. ` +
      'It may or may not have accepted the file, so it will not be retried automatically. ' +
      `Response excerpt: ${redact(body).slice(0, 300)}`,
  };
}

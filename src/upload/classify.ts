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

export const CLASSIFICATION_VERSION = 1;
export const CLASSIFICATION_PROVENANCE =
  'stage 0, 2026-08-16, akholod/easy-cast-probe and akholod/easy-cast-probe-public';

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
    if (url) return { ok: true, url };
    // A 201 whose body we cannot read is not a success we can act on: we would
    // have created an attachment and lost its only identifier.
    return unavailable(status, body, 'the endpoint answered 201 but no url could be read from the body');
  }

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

  if (status === 422 || status === 400) {
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

function extractUrl(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { url?: unknown };
    return typeof parsed.url === 'string' && parsed.url !== '' ? parsed.url : undefined;
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

  const detail = reasons.size > 0 ? [...reasons].join('; ') : redact(body).slice(0, 300);
  return `the endpoint refused the file (HTTP ${status}): ${detail}`;
}

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

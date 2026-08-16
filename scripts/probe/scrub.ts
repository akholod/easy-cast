import { mapStringsDeep, redact } from '../../src/secret/redact.js';

/**
 * Everything written to `fixtures/endpoint/observations.jsonl` goes through here.
 *
 * This package is published publicly, so those fixtures reach the npm tarball and
 * GitHub. A secret recorded in an observation is a secret published, and unlike an
 * attachment it would at least be removable — but only after it had been fetched
 * by anyone who cared to look.
 *
 * This is a wrapper over `redact()`, never a second redactor. One implementation
 * that everything funnels through is the only version of this that stays correct;
 * two would drift, and the copy nobody remembered would be the one that leaked.
 */

const ASSET_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const REQUEST_ID = /("?x-github-request-id"?\s*[:=]\s*"?)([^",\s}]+)/gi;
const DELIVERY_ID = /("?x-github-delivery"?\s*[:=]\s*"?)([^",\s}]+)/gi;

export const REDACTED = '[redacted]';

/**
 * A request id is not a credential, but it ties an observation to a specific
 * account's traffic — and these files are meant to describe an endpoint, not to
 * publish a log of who called it.
 */
export function scrubText(text: string): string {
  return redact(text)
    .replace(REQUEST_ID, `$1${REDACTED}`)
    .replace(DELIVERY_ID, `$1${REDACTED}`)
    .replace(ASSET_UUID, REDACTED);
}

/** Applied to every string anywhere in the record, at any depth. */
export const scrubObservation = <T>(record: T): T => mapStringsDeep(record, scrubText);

/** The serialised form, so no caller can reach the file without passing through here. */
export const serializeObservation = (record: unknown): string =>
  `${JSON.stringify(scrubObservation(record))}\n`;

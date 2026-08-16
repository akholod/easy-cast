import { createHash } from 'node:crypto';

/**
 * The plan token binds a real run to the plan a `--dry-run` computed for it.
 *
 * What it guarantees: the bytes that leave, the target they go to, and the
 * conversion policy applied to them are exactly those of the fingerprint the
 * presented token was computed for. A mismatch stops the run before anything
 * irreversible happens.
 *
 * What it does NOT guarantee, and must never be described as guaranteeing:
 * that `--dry-run` was ever executed, or that a human looked at the plan.
 * `computePlanToken` is deterministic, so a caller can compute the token itself.
 * That limit is deliberate and documented — pretending otherwise would be a
 * safety claim the tool cannot honour.
 *
 * The dedup intent (`upload` versus `reuse`) is deliberately NOT part of the
 * fingerprint: it depends on remote ledger state that the tool does not control,
 * and binding to it made the handshake diverge for video, whose conversion
 * profile is unknown at plan time.
 */

export const PLAN_TOKEN_VERSION = 'v1';

export interface PlanScope {
  readonly command: 'upload' | 'attach';
  readonly owner: string;
  readonly repo: string;
  /** Absent for `upload`, which has no issue or pull request. */
  readonly kind?: 'pr' | 'issue';
  readonly number?: number;
  /** Absent for `upload`, which never writes a comment and so has no key. */
  readonly key?: string;
  readonly convertPolicy: 'auto' | 'none';
}

export interface PlanFingerprint {
  readonly scope: PlanScope;
  /** In argv order, duplicates removed by first occurrence. Order is significant. */
  readonly sourceHashes: readonly string[];
}

export type ChangedDimension =
  | 'files'
  | 'order'
  | 'target'
  | 'key'
  | 'convert-policy'
  | 'token-version'
  | 'unknown';

export interface PlanContext {
  readonly changed: readonly ChangedDimension[];
  /** The token this run would accept, so the caller can recover without guessing. */
  readonly expected: string;
}

export type PlanVerification = { ok: true } | { ok: false; planContext: PlanContext };

/** Removes duplicates by first occurrence, matching the pipeline's batch rule. */
export function dedupeByFirstOccurrence(hashes: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const hash of hashes) {
    if (seen.has(hash)) continue;
    seen.add(hash);
    kept.push(hash);
  }
  return kept;
}

/**
 * Length-prefixed so field boundaries are unambiguous. Plain concatenation would
 * let a repo named `a/b` and an owner named `a` with repo `b` produce the same
 * bytes.
 */
export function canonicalPayload(fingerprint: PlanFingerprint): Buffer {
  const { scope } = fingerprint;
  const fields: string[] = [
    `easy-cast/plan/${PLAN_TOKEN_VERSION}`,
    scope.command,
    scope.owner,
    scope.repo,
    scope.kind ?? '',
    scope.number === undefined ? '' : String(scope.number),
    scope.key ?? '',
    scope.convertPolicy,
    String(fingerprint.sourceHashes.length),
    ...fingerprint.sourceHashes,
  ];

  const chunks: Buffer[] = [];
  for (const field of fields) {
    const value = Buffer.from(field, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.byteLength, 0);
    chunks.push(length, value);
  }
  return Buffer.concat(chunks);
}

export function computePlanToken(fingerprint: PlanFingerprint): string {
  const hash = createHash('sha256').update(canonicalPayload(fingerprint)).digest('hex');
  return `${PLAN_TOKEN_VERSION}.${hash}`;
}

function sameTarget(a: PlanScope, b: PlanScope): boolean {
  return (
    a.command === b.command &&
    a.owner === b.owner &&
    a.repo === b.repo &&
    a.kind === b.kind &&
    a.number === b.number
  );
}

function diff(previous: PlanFingerprint, actual: PlanFingerprint): ChangedDimension[] {
  const changed: ChangedDimension[] = [];
  if (!sameTarget(previous.scope, actual.scope)) changed.push('target');
  if (previous.scope.key !== actual.scope.key) changed.push('key');
  if (previous.scope.convertPolicy !== actual.scope.convertPolicy) changed.push('convert-policy');

  const before = previous.sourceHashes;
  const after = actual.sourceHashes;
  const sameSet =
    before.length === after.length && [...before].sort().join() === [...after].sort().join();
  if (!sameSet) changed.push('files');
  else if (before.join() !== after.join()) changed.push('order');

  return changed;
}

/**
 * `previous` is the fingerprint the caller's token was issued for, when it is
 * known — it lets the failure name which dimension moved instead of just saying
 * "mismatch". Without it the answer is honestly `unknown`.
 */
export function verifyPlanToken(
  provided: string | undefined,
  actual: PlanFingerprint,
  previous?: PlanFingerprint,
): PlanVerification {
  const expected = computePlanToken(actual);
  if (provided === expected) return { ok: true };

  // An unfamiliar version is quarantined rather than interpreted: a token from a
  // future format might mean something we would get wrong (D19).
  const version = provided?.split('.', 1)[0];
  if (provided !== undefined && version !== PLAN_TOKEN_VERSION) {
    return { ok: false, planContext: { changed: ['token-version'], expected } };
  }

  if (previous && computePlanToken(previous) === provided) {
    const changed = diff(previous, actual);
    return { ok: false, planContext: { changed: changed.length ? changed : ['unknown'], expected } };
  }

  return { ok: false, planContext: { changed: ['unknown'], expected } };
}

import { type Reason, type OutcomeSpec, outcomeFor } from './exit-codes.js';

/**
 * Every failure path ends in one of these. Carrying the reason rather than an
 * exit code keeps the `(exitCode, reason)` contract intact all the way from the
 * module that detected the problem to the JSON printed at the top level.
 */
export class EasyCastError extends Error {
  readonly reason: Reason;
  readonly outcome: OutcomeSpec;
  /** Extra machine-readable context for the JSON output, already redacted. */
  readonly context: Readonly<Record<string, unknown>>;

  constructor(reason: Reason, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'EasyCastError';
    this.reason = reason;
    this.outcome = outcomeFor(reason);
    this.context = context;
  }
}

export const badArgs = (message: string, context?: Record<string, unknown>) =>
  new EasyCastError('bad_args', message, context);

export const badKey = (message: string) => new EasyCastError('bad_key', message);

export const unsupportedExtension = (message: string) =>
  new EasyCastError('unsupported_extension', message);

export const targetNotFound = (message: string, context?: Record<string, unknown>) =>
  new EasyCastError('target_not_found', message, context);

export const refusedPublic = (message: string) => new EasyCastError('refused_public', message);

export const journalNotWritable = (message: string) =>
  new EasyCastError('journal_not_writable', message);

export const identityMismatch = (message: string) => new EasyCastError('identity_mismatch', message);

export const tokenNotFound = (message: string) => new EasyCastError('token_not_found', message);

export const repoNotInferable = (message: string) => new EasyCastError('repo_not_inferable', message);

export const repoAmbiguous = (message: string, context?: Record<string, unknown>) =>
  new EasyCastError('repo_ambiguous', message, context);

export const bodyBudgetExceeded = (message: string, context?: Record<string, unknown>) =>
  new EasyCastError('body_budget_exceeded', message, context);

export const ledgerCapacityExceeded = (message: string, context?: Record<string, unknown>) =>
  new EasyCastError('ledger_capacity_exceeded', message, context);

export const planMismatch = (message: string, context?: Record<string, unknown>) =>
  new EasyCastError('plan_mismatch', message, context);

export const planMissing = (message: string) => new EasyCastError('plan_missing', message);

/**
 * Anything that escapes as a non-{@link EasyCastError} is a bug in this tool, and
 * the honest thing to report is that the outcome is unknown — we cannot claim the
 * remote side was left untouched when we do not know where we stopped.
 */
export function toEasyCastError(thrown: unknown): EasyCastError {
  if (thrown instanceof EasyCastError) return thrown;
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return new EasyCastError('internal_error', message);
}

/**
 * The outcome contract.
 *
 * The primary consumer of this CLI is an agent, not a person, so the pair
 * `(exitCode, reason)` — not the exit code alone — is what determines what to do
 * next. A bare code 1 cannot distinguish "the network was down, retry" from
 * "the endpoint refused this file, fix the arguments", and code 4 cannot
 * distinguish a partial upload that is safe to repeat from one that is not.
 * Every pair below therefore carries its own `nextAction`.
 */

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Whether the state of the remote side is known after this run. */
export type OutcomeState = 'known' | 'unknown' | 'mixed';

export type NextAction =
  | 'done'
  | 'fix-args'
  | 'fix-environment'
  | 'ask-user'
  | 'retry'
  | 'report-to-human'
  | 'request-plan';

export type Reason =
  | 'ok'
  | 'dry_run'
  | 'recover_report'
  | 'network_unreachable'
  | 'no_access_or_not_found'
  | 'rejected_by_endpoint'
  | 'internal_error'
  | 'bad_args'
  | 'bad_key'
  | 'unsupported_extension'
  | 'body_budget_exceeded'
  | 'ledger_capacity_exceeded'
  | 'repo_not_inferable'
  | 'repo_ambiguous'
  | 'journal_not_writable'
  | 'identity_mismatch'
  | 'token_not_found'
  | 'target_not_found'
  | 'partial_upload_retryable'
  | 'partial_upload_blocked'
  | 'unresolved_backlog'
  | 'endpoint_unavailable'
  | 'refused_public'
  | 'plan_mismatch'
  | 'plan_missing';

export interface OutcomeSpec {
  readonly exitCode: ExitCode;
  readonly reason: Reason;
  readonly ok: boolean;
  readonly state: OutcomeState;
  /** Whether repeating the whole invocation unchanged is safe. */
  readonly retryable: boolean;
  readonly nextAction: NextAction;
}

/**
 * `retryable` on a partial upload is decided per run by {@link foldPartialUpload},
 * not by this table — both code-4 upload rows are listed with the value that
 * their reason already implies.
 */
export const OUTCOMES: readonly OutcomeSpec[] = [
  { exitCode: 0, reason: 'ok', ok: true, state: 'known', retryable: false, nextAction: 'done' },
  // A dry run succeeded at what it was asked to do — produce a plan — so it exits 0
  // and keeps `dry-run && real-run` working. It is not the end of the job, and
  // `nextAction` is what says so.
  { exitCode: 0, reason: 'dry_run', ok: true, state: 'known', retryable: false, nextAction: 'request-plan' },
  { exitCode: 0, reason: 'recover_report', ok: true, state: 'known', retryable: false, nextAction: 'done' },

  { exitCode: 1, reason: 'network_unreachable', ok: false, state: 'known', retryable: true, nextAction: 'retry' },
  { exitCode: 1, reason: 'no_access_or_not_found', ok: false, state: 'known', retryable: false, nextAction: 'ask-user' },
  { exitCode: 1, reason: 'rejected_by_endpoint', ok: false, state: 'known', retryable: false, nextAction: 'fix-args' },
  { exitCode: 1, reason: 'internal_error', ok: false, state: 'unknown', retryable: false, nextAction: 'report-to-human' },

  { exitCode: 2, reason: 'bad_args', ok: false, state: 'known', retryable: false, nextAction: 'fix-args' },
  { exitCode: 2, reason: 'bad_key', ok: false, state: 'known', retryable: false, nextAction: 'fix-args' },
  { exitCode: 2, reason: 'unsupported_extension', ok: false, state: 'known', retryable: false, nextAction: 'fix-args' },
  { exitCode: 2, reason: 'body_budget_exceeded', ok: false, state: 'known', retryable: false, nextAction: 'fix-args' },
  { exitCode: 2, reason: 'ledger_capacity_exceeded', ok: false, state: 'known', retryable: false, nextAction: 'fix-args' },
  { exitCode: 2, reason: 'repo_not_inferable', ok: false, state: 'known', retryable: false, nextAction: 'fix-args' },
  { exitCode: 2, reason: 'repo_ambiguous', ok: false, state: 'known', retryable: false, nextAction: 'fix-args' },
  // Not the arguments' fault: the environment has to change, so telling an agent
  // to "fix the call" would send it in circles.
  { exitCode: 2, reason: 'journal_not_writable', ok: false, state: 'known', retryable: false, nextAction: 'fix-environment' },
  { exitCode: 2, reason: 'identity_mismatch', ok: false, state: 'known', retryable: false, nextAction: 'fix-environment' },
  // Distinct from `no_access_or_not_found`, which means GitHub refused a token we
  // had. Here there is no credential at all, and the fix is `gh auth login` or
  // GH_TOKEN — not a question for the user and not a retry.
  { exitCode: 2, reason: 'token_not_found', ok: false, state: 'known', retryable: false, nextAction: 'fix-environment' },

  { exitCode: 3, reason: 'target_not_found', ok: false, state: 'known', retryable: false, nextAction: 'ask-user' },

  // Repeating is safe: the repair step re-syncs the comment from the journal and
  // already-uploaded files are reused rather than uploaded again.
  { exitCode: 4, reason: 'partial_upload_retryable', ok: false, state: 'mixed', retryable: true, nextAction: 'retry' },
  { exitCode: 4, reason: 'partial_upload_blocked', ok: false, state: 'mixed', retryable: false, nextAction: 'report-to-human' },
  { exitCode: 4, reason: 'unresolved_backlog', ok: false, state: 'known', retryable: false, nextAction: 'report-to-human' },

  // The bytes may or may not have been accepted. Repeating could create a second
  // attachment that can never be deleted, so this never retries.
  { exitCode: 5, reason: 'endpoint_unavailable', ok: false, state: 'unknown', retryable: false, nextAction: 'report-to-human' },

  { exitCode: 6, reason: 'refused_public', ok: false, state: 'known', retryable: false, nextAction: 'ask-user' },

  { exitCode: 7, reason: 'plan_mismatch', ok: false, state: 'known', retryable: false, nextAction: 'request-plan' },
  { exitCode: 7, reason: 'plan_missing', ok: false, state: 'known', retryable: false, nextAction: 'request-plan' },
];

const BY_REASON = new Map<Reason, OutcomeSpec>(OUTCOMES.map((spec) => [spec.reason, spec]));

export function outcomeFor(reason: Reason): OutcomeSpec {
  const spec = BY_REASON.get(reason);
  if (!spec) throw new Error(`No outcome registered for reason: ${reason}`);
  return spec;
}

/** One file's contribution to the run-level outcome. */
export interface FileOutcome {
  readonly succeeded: boolean;
  readonly state: 'known' | 'unknown';
  readonly retryable: boolean;
}

/**
 * Which flavour of partial upload this is.
 *
 * Repeating is only safe when every failure is transport-level and the remote
 * definitely never received the bytes. A single unknown outcome means a repeat
 * could duplicate an attachment that cannot be deleted, so the run is blocked
 * and handed to a person.
 */
export function foldPartialUpload(
  files: readonly FileOutcome[],
): 'partial_upload_retryable' | 'partial_upload_blocked' {
  const failures = files.filter((file) => !file.succeeded);
  const allSafeToRepeat = failures.every((file) => file.state === 'known' && file.retryable);
  return allSafeToRepeat ? 'partial_upload_retryable' : 'partial_upload_blocked';
}

export function foldState(files: readonly FileOutcome[]): OutcomeState {
  const anySucceeded = files.some((file) => file.succeeded);
  const anyFailed = files.some((file) => !file.succeeded);
  if (anySucceeded && anyFailed) return 'mixed';
  if (!anySucceeded && files.some((file) => file.state === 'unknown')) return 'unknown';
  return 'known';
}


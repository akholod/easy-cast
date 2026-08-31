import type { Anomaly } from './anomalies.js';
import { outcomeFor, type ExitCode, type NextAction, type OutcomeState, type Reason } from './exit-codes.js';
import type { Scope } from './journal.js';

/**
 * The machine-readable result.
 *
 * An agent decides what to do next from this object alone, so two properties are
 * load-bearing: `reason` is always present (the pair with `exitCode` is what
 * determines `nextAction`), and stdout carries exactly one valid JSON object no
 * matter how the run ended — including an unhandled throw.
 */

export const SCHEMA = 'easy-cast/v1' as const;

export type UploadStatus = 'uploaded' | 'reused' | 'skipped' | 'failed';
export type PlannedAction = 'would-upload' | 'would-reuse' | 'unknown';

export interface UploadedFileReport {
  readonly name: string;
  readonly sourceHash: string;
  readonly digest: string;
  readonly status: UploadStatus;
  readonly plannedAction?: PlannedAction;
  readonly url?: string;
  readonly state: 'known' | 'unknown';
  readonly retryable: boolean;
  /** Source size and what the size check made of it, so a plan can be judged. */
  readonly sizeBytes?: number;
  readonly sizeVerdict?: 'ok' | 'warn';
  readonly failure?: { readonly reason: string; readonly message: string };
}

export interface RecoveryReport {
  readonly journalPersisted: boolean;
  readonly commentLedgerPersisted: boolean;
  readonly repaired: boolean;
  readonly pending: readonly { readonly scope: Scope; readonly digest: string; readonly url: string }[];
  readonly journalPath: string;
}

export interface TargetReport {
  readonly owner: string;
  readonly repo: string;
  readonly visibility: string;
  readonly repoSource: 'flag' | 'origin' | 'sole-remote';
  readonly kind?: 'pr' | 'issue';
  readonly number?: number;
}

/**
 * `harvest`, `compose` and `render` are local and non-mutating — they read files
 * and write a document — but they answer on the same contract as everything else,
 * because a caller that has to special-case three commands will special-case them
 * wrongly.
 */
export type CommandName =
  | 'upload'
  | 'attach'
  | 'recover'
  | 'report'
  | 'harvest'
  | 'compose'
  | 'render';

export interface CliJsonOutput {
  readonly schema: typeof SCHEMA;
  readonly command: CommandName;
  readonly ok: boolean;
  readonly exitCode: ExitCode;
  readonly reason: Reason;
  readonly state: OutcomeState;
  readonly retryable: boolean;
  readonly nextAction: NextAction;
  /** What this run actually created — a fact, unlike the constant below. */
  readonly assetsCreated: number;
  /**
   * Constant on purpose. It carries no information about this run; it is the
   * unconditional disclosure that P2 requires on every result, for a caller that
   * never read the docs.
   */
  readonly uploadsAreIrreversible: true;
  readonly planToken?: string;
  readonly planContext?: { readonly changed: readonly string[]; readonly expected: string };
  readonly message?: string;
  readonly uploaded: readonly UploadedFileReport[];
  readonly recovery?: RecoveryReport;
  readonly target?: TargetReport;
  readonly branch?: string;
  readonly comment?: {
    readonly id: number;
    readonly url: string;
    readonly created: boolean;
    readonly ledgerOnly: boolean;
  };
  readonly anomalies?: readonly Anomaly[];
  readonly dryRun?: boolean;
  /**
   * Advisories an agent should act on but which are not failures — chiefly that a
   * fresh attachment URL answers 404 until something quotes it. Without being
   * told, an agent "verifies" its own upload, gets a 404, and loops.
   */
  readonly notes?: readonly string[];
  readonly environment?: { readonly ffmpegAvailable: boolean };
  /**
   * A document the command produced: `compose`'s comment body, `harvest`'s spec.
   *
   * Separate from `message`, which explains an outcome. Putting a composed
   * markdown body in `message` would make an agent parse an explanation to find
   * a deliverable, and would leave a human reading "every URL above is a
   * placeholder" above the URLs it was talking about.
   */
  readonly body?: string;
}

/**
 * Said on every successful attach, because the alternative is a reload loop.
 *
 * Established by stage 0: the canonical asset URL answers 404 to a direct GET in
 * every case tested, cited or not. What actually serves the image is a short-lived
 * signed URL that GitHub substitutes when it renders the comment.
 */
export const URL_NOT_LIVE_UNTIL_QUOTED =
  'The attachment URL above answers 404 if you fetch it directly — that is normal and permanent, ' +
  'not a failure. GitHub serves the image through a short-lived signed URL it substitutes when ' +
  'rendering the comment. Do not re-upload: a second upload cannot be undone.';

/**
 * Said on every `upload`, because it is the whole difference from `attach` and
 * nothing in the output would otherwise show it.
 *
 * `attach` is safe to re-run: the journal and the comment ledger make a repeat
 * reuse what already exists. `upload` has neither, so a repeat is a second
 * permanent asset. A caller that assumes the two commands share `attach`'s
 * idempotency finds out only after the bytes are unrecallable.
 */
export const UPLOAD_RECORDS_NOTHING =
  'upload keeps no record: no journal entry, no comment ledger, and no deduplication of any kind. ' +
  'Running it again on the same file uploads it again, and neither copy can ever be deleted. ' +
  'Keep the URL — it is the only thing that survives this command.';

/**
 * Stage 0 established that the asset is scoped to the uploading user, not to the
 * repository. `upload` therefore has no `--allow-public` gate: there is nothing
 * for it to gate, because `upload` quotes the URL nowhere (ADR 022).
 */
export const UPLOAD_EXPOSURE_FOLLOWS_QUOTING =
  'Who can read this file is decided by wherever you paste the URL — not by the repository it was ' +
  'uploaded against. GitHub serves the bytes through a short-lived signed URL scoped to the ' +
  'uploading account, so anyone who can see the URL in rendered markdown can fetch them. That is ' +
  'why upload has no public-repository gate: there is nothing for it to gate.';

export interface OutputDraft {
  readonly command: CommandName;
  readonly reason: Reason;
  readonly message?: string;
  readonly uploaded?: readonly UploadedFileReport[];
  readonly assetsCreated?: number;
  readonly planToken?: string;
  readonly planContext?: { readonly changed: readonly string[]; readonly expected: string };
  readonly recovery?: RecoveryReport;
  readonly target?: TargetReport;
  readonly branch?: string;
  readonly comment?: CliJsonOutput['comment'];
  readonly anomalies?: readonly Anomaly[];
  readonly dryRun?: boolean;
  readonly notes?: readonly string[];
  readonly environment?: { readonly ffmpegAvailable: boolean };
  readonly body?: string;
  /**
   * `state` may be folded per run, because a batch genuinely can be mixed.
   * `retryable` deliberately has NO override: it is decided by the (code, reason)
   * table alone, so nothing can report a blocked run that also claims to be safe
   * to repeat.
   */
  readonly state?: OutcomeState;
}

export function buildOutput(draft: OutputDraft): CliJsonOutput {
  const spec = outcomeFor(draft.reason);
  return {
    schema: SCHEMA,
    command: draft.command,
    ok: spec.ok,
    exitCode: spec.exitCode,
    reason: draft.reason,
    state: draft.state ?? spec.state,
    retryable: spec.retryable,
    nextAction: spec.nextAction,
    assetsCreated: draft.assetsCreated ?? 0,
    uploadsAreIrreversible: true,
    ...(draft.planToken ? { planToken: draft.planToken } : {}),
    ...(draft.planContext ? { planContext: draft.planContext } : {}),
    ...(draft.message ? { message: draft.message } : {}),
    uploaded: draft.uploaded ?? [],
    ...(draft.recovery ? { recovery: draft.recovery } : {}),
    ...(draft.target ? { target: draft.target } : {}),
    ...(draft.branch ? { branch: draft.branch } : {}),
    ...(draft.comment ? { comment: draft.comment } : {}),
    ...(draft.anomalies?.length ? { anomalies: draft.anomalies } : {}),
    ...(draft.dryRun ? { dryRun: true } : {}),
    ...(draft.notes?.length ? { notes: draft.notes } : {}),
    ...(draft.environment ? { environment: draft.environment } : {}),
    ...(draft.body ? { body: draft.body } : {}),
  };
}

export const renderJson = (output: CliJsonOutput): string => JSON.stringify(output, null, 2);

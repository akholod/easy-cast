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

export interface CliJsonOutput {
  readonly schema: typeof SCHEMA;
  readonly command: 'upload' | 'attach' | 'recover';
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
}

/**
 * Said on every successful attach, because the alternative is a reload loop.
 *
 * Hedged deliberately: this was observed once, and stage 0 has not run, so it is
 * not yet established behaviour. The instruction it implies — do not re-upload —
 * is safe whether or not the observation generalises.
 */
export const URL_NOT_LIVE_UNTIL_QUOTED =
  'A fresh attachment URL is expected to answer 404 until something quotes it; the comment above ' +
  'is what activates it. (Observed once, not yet established — stage 0 has not run.) Either way: ' +
  'do not re-upload, and do not treat a 404 here as a failure.';

export interface OutputDraft {
  readonly command: 'upload' | 'attach' | 'recover';
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
  };
}

export const renderJson = (output: CliJsonOutput): string => JSON.stringify(output, null, 2);

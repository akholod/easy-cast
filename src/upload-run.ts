import { readFile, rm } from 'node:fs/promises';
import type { Anomaly } from './anomalies.js';
import { asMp4, base, prepare, worstFailureReason, type PreparedFile } from './batch.js';
import { planMismatch, planMissing } from './errors.js';
import { foldPartialUpload, foldState, type FileOutcome } from './exit-codes.js';
import type { RepoVisibility } from './github/api.js';
import { computeDigest } from './media/digest.js';
import type { ConversionResult } from './media/convert.js';
import type { SourceSnapshot } from './media/snapshot.js';
import {
  buildOutput,
  UPLOAD_EXPOSURE_FOLLOWS_QUOTING,
  UPLOAD_RECORDS_NOTHING,
  URL_NOT_LIVE_UNTIL_QUOTED,
  type CliJsonOutput,
  type UploadedFileReport,
} from './output.js';
import { computePlanToken, verifyPlanToken, type PlanFingerprint, type PlanScope } from './plan-token.js';
import type { RepoSource } from './target/infer-repo.js';
import type { UploadPort } from './upload/port.js';

/**
 * `upload` — bytes to the endpoint, a URL back, and nothing else.
 *
 * It is deliberately not `attach` minus a step. Three things `attach` does are
 * absent here, and each absence is a decision rather than an omission:
 *
 * - **No comment**, so no marker, no ledger, and no key.
 * - **No journal.** The journal exists to make an unwritten comment recoverable;
 *   with no comment there is nothing to recover *to*, and a record that could
 *   never be synced would sit in `recover` forever as a backlog nobody can clear.
 * - **No deduplication**, which follows from the two above. A repeat uploads
 *   again, permanently. `UPLOAD_RECORDS_NOTHING` says so on every run.
 *
 * And one gate is absent: `--allow-public`. Exposure follows where the URL is
 * quoted, and `upload` quotes it nowhere, so gating on the repository's
 * visibility would protect nothing while sounding like it did (ADR 022).
 *
 * What it keeps from `attach`, because those are properties of the batch rather
 * than of the destination: whole-batch validation before the first byte moves,
 * first-occurrence de-duplication of the argument list, video-only conversion,
 * the plan handshake, and severity-ordered failure reporting.
 */

export interface UploadRequest {
  readonly command: 'upload';
  readonly files: readonly string[];
  readonly dryRun: boolean;
  readonly noConvert: boolean;
  readonly confirmPlan?: string;
}

export interface UploadRepo {
  readonly owner: string;
  readonly repo: string;
  readonly repoSource: RepoSource;
  readonly visibility: RepoVisibility;
  /** The wire parameter. Only `src/upload/` may treat it as one (P5). */
  readonly repositoryId: number;
  readonly anomalies: readonly Anomaly[];
}

export interface UploadDeps {
  readonly uploads: UploadPort;
  readonly resolveRepo: () => Promise<UploadRepo>;
  /** Video only, exactly as in `attach`: an image run through the video profile
   * would upload mp4 bytes under an image content type. */
  readonly convert: (snapshot: SourceSnapshot, noConvert: boolean) => Promise<ConversionResult>;
  readonly resolveUploadToken: () => Promise<{ token: string }>;
  readonly tmpPaths: () => readonly string[];
  readonly ffmpegAvailable: () => boolean;
}

export async function runUpload(request: UploadRequest, deps: UploadDeps): Promise<CliJsonOutput> {
  try {
    // ---- Non-mutating pre-flight. ----
    const prepared = prepare(request.files);
    const sourceHashes = prepared.map((file) => file.sourceHash);

    const repo = await deps.resolveRepo();
    const anomalies: Anomaly[] = [...repo.anomalies];

    const scope: PlanScope = {
      command: 'upload',
      owner: repo.owner,
      repo: repo.repo,
      // No kind, number or key: there is no issue, no pull request and no comment.
      convertPolicy: request.noConvert ? 'none' : 'auto',
    };
    const fingerprint: PlanFingerprint = { scope, sourceHashes };

    if (request.dryRun) return planOutput(repo, prepared, fingerprint, anomalies, deps);

    if (!request.confirmPlan) {
      throw planMissing(
        'a real upload needs --confirm-plan=<token>. Run the same command with --dry-run --json to obtain one.',
      );
    }
    const verified = verifyPlanToken(request.confirmPlan, fingerprint);
    if (!verified.ok) {
      throw planMismatch('the plan has changed since that token was issued; nothing was uploaded.', {
        changed: [...verified.planContext.changed],
        expected: verified.planContext.expected,
      });
    }

    // ---- Conversion. ffmpeg inherits nothing from this process (allowEnv: []). ----
    const converted: ConversionResult[] = [];
    for (const file of prepared) {
      converted.push(
        file.category === 'video'
          ? await deps.convert(file.snapshot, request.noConvert)
          : { path: file.snapshot.path, converted: false, effectiveProfileId: 'none' },
      );
    }

    const { token } = await deps.resolveUploadToken();
    const wireTarget = { owner: repo.owner, repo: repo.repo, repositoryId: repo.repositoryId };

    // ---- Uploads. Nothing is read before them and nothing is written after. ----
    const reports: UploadedFileReport[] = [];
    const outcomes: FileOutcome[] = [];
    let assetsCreated = 0;

    for (const [index, file] of prepared.entries()) {
      // Computed for the report only. Nothing here consults it: `upload` does not
      // deduplicate. It is emitted so a caller that wants its own dedup has the
      // same identity `attach` would have used, rather than having to guess it.
      const digest = computeDigest(file.snapshot, converted[index].effectiveProfileId);
      const bytes = converted[index].converted
        ? await readFile(converted[index].path)
        : file.snapshot.bytes;

      const outcome = await deps.uploads.upload(
        converted[index].converted
          ? { fileName: asMp4(file.name), contentType: 'video/mp4', category: file.category, bytes }
          : { fileName: file.name, contentType: file.contentType, category: file.category, bytes },
        wireTarget,
        token,
      );

      if (outcome.ok) {
        assetsCreated += 1;
        reports.push({ ...base(file, digest), status: 'uploaded', url: outcome.url, state: 'known', retryable: false });
        outcomes.push({ succeeded: true, state: 'known', retryable: false });
        continue;
      }

      reports.push({
        ...base(file, digest),
        status: 'failed',
        state: outcome.state,
        retryable: outcome.retryable,
        failure: { reason: outcome.reason, message: outcome.message },
      });
      outcomes.push({ succeeded: false, state: outcome.state, retryable: outcome.retryable });
    }

    const anyFailed = outcomes.some((outcome) => !outcome.succeeded);
    const anySucceeded = outcomes.some((outcome) => outcome.succeeded);
    // There is no comment to write, so unlike `attach` a run that uploaded
    // everything is simply done — `partial_upload_blocked` cannot arise from a
    // failed write here, only from a failed upload.
    const reason = anyFailed
      ? anySucceeded
        ? foldPartialUpload(outcomes)
        : worstFailureReason(reports)
      : 'ok';

    return buildOutput({
      command: 'upload',
      reason,
      assetsCreated,
      uploaded: reports,
      target: targetReport(repo),
      state: foldState(outcomes),
      notes: notes(assetsCreated > 0),
      anomalies,
    });
  } finally {
    await Promise.all(deps.tmpPaths().map((path) => rm(path, { force: true }).catch(() => {})));
  }
}

/**
 * The two facts that distinguish `upload` from `attach` are stated on every run,
 * not only on the successful ones: a caller reading a failure still has to know
 * that a repeat is not free.
 */
const notes = (uploaded: boolean): string[] =>
  uploaded
    ? [URL_NOT_LIVE_UNTIL_QUOTED, UPLOAD_EXPOSURE_FOLLOWS_QUOTING, UPLOAD_RECORDS_NOTHING]
    : [UPLOAD_EXPOSURE_FOLLOWS_QUOTING, UPLOAD_RECORDS_NOTHING];

const targetReport = (repo: UploadRepo) => ({
  owner: repo.owner,
  repo: repo.repo,
  visibility: repo.visibility,
  repoSource: repo.repoSource,
  // No kind and no number, on purpose: `upload` posts nowhere, and reporting a
  // target it did not touch would invite a caller to look for a comment.
});

function planOutput(
  repo: UploadRepo,
  prepared: readonly PreparedFile[],
  fingerprint: PlanFingerprint,
  anomalies: readonly Anomaly[],
  deps: UploadDeps,
): CliJsonOutput {
  return buildOutput({
    command: 'upload',
    reason: 'dry_run',
    dryRun: true,
    planToken: computePlanToken(fingerprint),
    target: targetReport(repo),
    uploaded: prepared.map((file) => ({
      name: file.name,
      sourceHash: file.sourceHash,
      digest: '',
      status: 'skipped' as const,
      // Always `would-upload`, never `unknown`. In `attach` a video's action is
      // unknown at plan time because the conversion profile decides the ledger
      // key and therefore upload-versus-reuse. Here nothing is ever reused, so
      // the profile changes the bytes but not the answer.
      plannedAction: 'would-upload' as const,
      state: 'known' as const,
      retryable: false,
      sizeBytes: file.snapshot.byteLength,
      sizeVerdict: file.sizeVerdict,
    })),
    // Only when the batch contains video: the human plan renders this as "video
    // will be converted to mp4", which under an all-images plan is false.
    ...(prepared.some((file) => file.category === 'video')
      ? { environment: { ffmpegAvailable: deps.ffmpegAvailable() } }
      : {}),
    notes: notes(false),
    anomalies,
  });
}

import { readFile, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Anomaly } from './anomalies.js';
import {
  bodyBudgetExceeded,
  ledgerCapacityExceeded,
  planMismatch,
  planMissing,
  refusedPublic,
  unsupportedExtension,
  badArgs,
  EasyCastError,
} from './errors.js';
import { foldPartialUpload, foldState, type FileOutcome } from './exit-codes.js';
import type { GitHubApi } from './github/api.js';
import { assetRecorded, ledgerSynced, type Journal, type Scope } from './journal.js';
import { computeDigest, computeSourceHash } from './media/digest.js';
import { classifyExtension, checkSize } from './media/mime.js';
import { captureSource, type SourceSnapshot } from './media/snapshot.js';
import type { ConversionResult } from './media/convert.js';
import {
  BODY_BUDGET_BYTES,
  composeBody,
  estimateBodyBytes,
  replaceLedgerBlock,
} from './comment/body.js';
import { LEDGER_CAP, lookupEntry, parseLedger, serializeLedger, touchEntry } from './comment/ledger.js';
import { defaultKey, marker, validateKey } from './comment/marker.js';
import { findOwnComment, upsertComment } from './comment/upsert.js';
import {
  buildOutput,
  URL_NOT_LIVE_UNTIL_QUOTED,
  type CliJsonOutput,
  type UploadedFileReport,
} from './output.js';
import { computePlanToken, verifyPlanToken, type PlanFingerprint, type PlanScope } from './plan-token.js';
import { renderBatch } from './render.js';
import type { ResolvedTarget } from './target/resolve.js';
import type { UploadPort } from './upload/port.js';

export interface PipelineRequest {
  readonly command: 'attach';
  readonly files: readonly string[];
  readonly caption?: string;
  readonly key?: string;
  readonly dryRun: boolean;
  readonly noConvert: boolean;
  readonly allowPublic: boolean;
  readonly confirmPlan?: string;
}

export interface PipelineDeps {
  readonly api: GitHubApi;
  readonly journal: Journal;
  readonly uploads: UploadPort;
  readonly resolveTarget: () => Promise<ResolvedTarget>;
  /**
   * Video only. The credential is kept away from the child by the environment
   * allowlist in `spawnScrubbed` (ffmpeg gets `allowEnv: []`), not by call order.
   */
  readonly convert: (snapshot: SourceSnapshot, noConvert: boolean) => Promise<ConversionResult>;
  readonly resolveUploadToken: () => Promise<{ token: string; login: string }>;
  readonly assertIdentity: (uploadLogin: string, commentLogin: string) => void;
  readonly now: () => string;
  readonly tmpPaths: () => readonly string[];
  readonly ffmpegAvailable: () => boolean;
}

interface PreparedFile {
  readonly snapshot: SourceSnapshot;
  readonly sourceHash: string;
  readonly name: string;
  readonly contentType: string;
  readonly category: 'image' | 'video';
  readonly sizeVerdict: 'ok' | 'warn';
}

const scopeOf = (target: ResolvedTarget, key: string): Scope => ({
  owner: target.owner,
  repo: target.repo,
  kind: target.kind,
  number: target.number,
  key,
});

/**
 * Reads every file exactly once and refuses the whole batch if any of them is
 * unusable.
 *
 * Validating everything before the first upload is what makes "the third file was
 * bad, so nothing was uploaded" true. Validating lazily would leave two permanent
 * attachments behind before discovering the problem.
 */
function prepare(files: readonly string[]): PreparedFile[] {
  const prepared: PreparedFile[] = [];
  const seen = new Set<string>();

  for (const path of files) {
    const snapshot = captureSource(path);
    const sourceHash = computeSourceHash(snapshot);
    // First occurrence wins, matching the plan token's own de-duplication, so the
    // same file named twice is uploaded once rather than twice.
    if (seen.has(sourceHash)) continue;
    seen.add(sourceHash);

    const name = basename(path);
    const kind = classifyExtension(name);
    if (!kind) {
      throw unsupportedExtension(
        `${name} is not a file type GitHub accepts as an attachment. Nothing was uploaded.`,
      );
    }

    const size = checkSize(snapshot.byteLength, kind);
    if (size.level === 'reject') {
      throw badArgs(`${name}: ${size.message}. Nothing was uploaded.`);
    }

    prepared.push({
      snapshot,
      sourceHash,
      name,
      contentType: kind.contentType,
      category: kind.category,
      sizeVerdict: size.level,
    });
  }

  if (prepared.length === 0) throw badArgs('no files to attach');
  return prepared;
}

export async function runAttach(
  request: PipelineRequest,
  deps: PipelineDeps,
): Promise<CliJsonOutput> {
  const anomalies: Anomaly[] = [];

  try {
    // ---- Non-mutating pre-flight. Nothing here changes anything, anywhere. ----
    const prepared = prepare(request.files);
    const sourceHashes = prepared.map((file) => file.sourceHash);
    const key = request.key ? validateKey(request.key) : defaultKey('attach', sourceHashes);

    const target = await deps.resolveTarget();
    anomalies.push(...target.anomalies);

    if (target.visibility === 'public' && !request.allowPublic) {
      // Before a single byte moves: an upload to a public repository cannot be
      // withdrawn, so the consent has to be collected while refusing is still free.
      throw refusedPublic(
        `${target.owner}/${target.repo} is public and an uploaded attachment can never be deleted. ` +
          'Re-run with --allow-public once you are certain the file is safe to publish.',
      );
    }

    const scope: PlanScope = {
      command: 'attach',
      owner: target.owner,
      repo: target.repo,
      kind: target.kind,
      number: target.number,
      key,
      convertPolicy: request.noConvert ? 'none' : 'auto',
    };
    const fingerprint: PlanFingerprint = { scope, sourceHashes };

    deps.journal.ensureWritable();

    if (prepared.length > LEDGER_CAP) {
      // Evicting inside a batch would throw away records this very run just
      // created, so an over-large batch is refused instead.
      throw ledgerCapacityExceeded(
        `${prepared.length} files exceeds the ${LEDGER_CAP}-entry ledger a comment can carry. ` +
          'Split the batch. Nothing was uploaded.',
      );
    }

    const estimated = estimateBodyBytes({
      marker: marker(key),
      caption: request.caption,
      files: prepared.map((file) => ({ name: file.name, category: file.category })),
      ledgerEntryCount: prepared.length,
    });
    if (estimated > BODY_BUDGET_BYTES) {
      throw bodyBudgetExceeded(
        `the comment would be about ${estimated} bytes, over the ${BODY_BUDGET_BYTES} budget. ` +
          'Use fewer files or a shorter caption. Nothing was uploaded.',
      );
    }

    if (request.dryRun) {
      // No repair, no conversion, no upload, no write. The plan is the product.
      return planOutput(request, target, prepared, fingerprint, anomalies, deps);
    }

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

    // ---- Conversion. ffmpeg is spawned with an empty environment, which is what
    // keeps the credential away from it — the call order is not the guarantee. ----
    // Only video is converted. Running an image through the video profile would
    // upload mp4 bytes under its original name and image content type — a file
    // that is not what it says it is, and that cannot be taken back.
    const converted: ConversionResult[] = [];
    for (const file of prepared) {
      converted.push(
        file.category === 'video'
          ? await deps.convert(file.snapshot, request.noConvert)
          : { path: file.snapshot.path, converted: false, effectiveProfileId: 'none' },
      );
    }

    const digests = prepared.map((file, index) => computeDigest(file.snapshot, converted[index].effectiveProfileId));

    const { token, login: uploadLogin } = await deps.resolveUploadToken();
    deps.assertIdentity(uploadLogin, await deps.api.getViewerLogin());

    // ---- Repair, the first step that writes anything (D17). ----
    const runScope = scopeOf(target, key);
    const repaired = await repair(runScope, deps, uploadLogin, anomalies);

    // ---- Uploads. ----
    const existing = await findOwnComment(deps.api, target.owner, target.repo, target.number, key, uploadLogin);
    anomalies.push(...existing.anomalies);
    const ledgerRead = parseLedger(existing.chosen?.body ?? '');
    anomalies.push(...ledgerRead.anomalies);
    let ledger = ledgerRead.entries;

    const reports: UploadedFileReport[] = [];
    const outcomes: FileOutcome[] = [];
    const rendered: { url: string; category: 'image' | 'video'; name: string }[] = [];
    let assetsCreated = 0;

    for (const [index, file] of prepared.entries()) {
      const digest = digests[index];
      const known = lookupEntry(ledger, digest) ?? deps.journal.lookupScoped(digest, runScope);

      if (known) {
        ledger = touchEntry(ledger, digest, known);
        rendered.push({ url: known, category: file.category, name: file.name });
        reports.push({ ...base(file, digest), status: 'reused', url: known, state: 'known', retryable: false });
        outcomes.push({ succeeded: true, state: 'known', retryable: false });
        continue;
      }

      const bytes = converted[index].converted ? await readFile(converted[index].path) : file.snapshot.bytes;
      const outcome = await deps.uploads.upload(
        // When conversion actually ran, the bytes are mp4 and must be declared as
        // mp4. The endpoint validates the declared type against the file name, and
        // one observed 422 complained about exactly that mismatch.
        converted[index].converted
          ? { fileName: asMp4(file.name), contentType: 'video/mp4', category: file.category, bytes }
          : { fileName: file.name, contentType: file.contentType, category: file.category, bytes },
        { owner: target.owner, repo: target.repo },
        token,
      );

      if (outcome.ok) {
        // Recorded locally before anything is written to GitHub. If the comment
        // write fails after this, the URL is still recoverable instead of being
        // an orphaned attachment nobody can find.
        deps.journal.appendEvent(assetRecorded(digest, outcome.url, runScope, deps.now()));
        assetsCreated += 1;
        ledger = touchEntry(ledger, digest, outcome.url);
        rendered.push({ url: outcome.url, category: file.category, name: file.name });
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

    return await write({
      request,
      deps,
      target,
      key,
      runScope,
      login: uploadLogin,
      existingBody: existing.chosen?.body,
      ledger,
      rendered,
      reports,
      outcomes,
      assetsCreated,
      repaired,
      anomalies,
    });
  } finally {
    // Every temporary file, on every path, including the ones that threw.
    await Promise.all(deps.tmpPaths().map((path) => rm(path, { force: true }).catch(() => {})));
  }
}

const asMp4 = (name: string): string => `${name.replace(/\.[^.]+$/, '')}.mp4`;

type FailureReason =
  | 'endpoint_unavailable'
  | 'no_access_or_not_found'
  | 'rejected_by_endpoint'
  | 'network_unreachable';

/** Worst first. Order is severity, not file order. */
const SEVERITY: readonly FailureReason[] = [
  'endpoint_unavailable',
  'no_access_or_not_found',
  'rejected_by_endpoint',
  'network_unreachable',
];

/**
 * The most serious reason in the batch, not the first one encountered.
 *
 * Taking the first would let a batch whose opening failure was a transient
 * network error report `network_unreachable` — and therefore "retry" — even
 * though a later file had been permanently refused. The answer must not depend on
 * the order the files happened to be listed in.
 */
function worstFailureReason(reports: readonly UploadedFileReport[]): FailureReason {
  const seen = new Set(reports.map((report) => report.failure?.reason));
  return SEVERITY.find((reason) => seen.has(reason)) ?? 'network_unreachable';
}

const base = (file: PreparedFile, digest: string) => ({
  name: file.name,
  sourceHash: file.sourceHash,
  digest,
});


/**
 * Writes any URL that was recorded locally but never made it into a comment.
 *
 * This runs before new uploads rather than blocking them: an earlier design made
 * an unresolved backlog a hard refusal, which meant a target could be locked out
 * permanently even though re-running the same command is exactly what fixes it.
 */
async function repair(
  scope: Scope,
  deps: PipelineDeps,
  login: string,
  anomalies: Anomaly[],
): Promise<boolean> {
  const { pending, anomalies: foldAnomalies } = deps.journal.foldPending();
  anomalies.push(...foldAnomalies);

  const mine = pending.filter(
    (record) =>
      record.scope.owner === scope.owner &&
      record.scope.repo === scope.repo &&
      record.scope.kind === scope.kind &&
      record.scope.number === scope.number &&
      record.scope.key === scope.key,
  );
  if (mine.length === 0) return false;

  const found = await findOwnComment(deps.api, scope.owner, scope.repo, scope.number, scope.key, login);
  const read = parseLedger(found.chosen?.body ?? '');
  let entries = read.entries;
  for (const record of mine) entries = touchEntry(entries, record.d, record.u);

  anomalies.push(...found.anomalies, ...read.anomalies);

  const body = found.chosen
    ? replaceLedgerBlock(found.chosen.body, serializeLedger(entries)).body
    : composeBody({ marker: marker(scope.key), rendered: [], ledger: serializeLedger(entries) });

  try {
    await upsertComment(deps.api, scope.owner, scope.repo, scope.number, scope.key, login, body);
  } catch (error) {
    // Repair is the mechanism that clears a backlog, so when it is the thing that
    // fails the run must say so in its own terms — and must not go on to add more
    // irreversible uploads on top of a backlog it could not resolve.
    throw new EasyCastError(
      'unresolved_backlog',
      `${mine.length} uploaded file(s) are recorded locally but could not be written into the comment: ` +
        `${error instanceof Error ? error.message : String(error)}. No new files were uploaded.`,
      { owner: scope.owner, repo: scope.repo, number: scope.number },
    );
  }

  for (const record of mine) deps.journal.appendEvent(ledgerSynced(record.d, scope, deps.now()));
  return true;
}

function planOutput(
  request: PipelineRequest,
  target: ResolvedTarget,
  prepared: readonly PreparedFile[],
  fingerprint: PlanFingerprint,
  anomalies: readonly Anomaly[],
  deps: PipelineDeps,
): CliJsonOutput {
  const { pending } = deps.journal.foldPending();
  return buildOutput({
    command: 'attach',
    reason: 'dry_run',
    dryRun: true,
    planToken: computePlanToken(fingerprint),
    target: targetReport(target),
    uploaded: prepared.map((file) => ({
      name: file.name,
      sourceHash: file.sourceHash,
      digest: '',
      status: 'skipped' as const,
      // Conversion has not run, so for video the profile — and therefore the
      // ledger key — is genuinely not known yet. Saying so beats a guess.
      plannedAction: file.category === 'video' && !request.noConvert ? ('unknown' as const) : ('would-upload' as const),
      state: 'known' as const,
      retryable: false,
      sizeBytes: file.snapshot.byteLength,
      sizeVerdict: file.sizeVerdict,
    })),
    // Whether video will actually be converted is a property of this machine, and
    // it changes what ends up uploaded. A plan that hides it is not a plan.
    environment: { ffmpegAvailable: deps.ffmpegAvailable() },
    recovery: {
      journalPersisted: true,
      commentLedgerPersisted: pending.length === 0,
      repaired: false,
      pending: pending.map((record) => ({ scope: record.scope, digest: record.d, url: record.u })),
      journalPath: deps.journal.path,
    },
    anomalies,
  });
}

const targetReport = (target: ResolvedTarget) => ({
  owner: target.owner,
  repo: target.repo,
  visibility: target.visibility,
  repoSource: target.repoSource,
  kind: target.kind,
  number: target.number,
});

async function write(context: {
  request: PipelineRequest;
  deps: PipelineDeps;
  target: ResolvedTarget;
  key: string;
  runScope: Scope;
  login: string;
  existingBody?: string;
  ledger: readonly (readonly [string, string])[];
  rendered: { url: string; category: 'image' | 'video'; name: string }[];
  reports: UploadedFileReport[];
  outcomes: FileOutcome[];
  assetsCreated: number;
  repaired: boolean;
  anomalies: Anomaly[];
}): Promise<CliJsonOutput> {
  const { deps, target, key, runScope, login, reports, outcomes, anomalies } = context;
  const anyFailed = outcomes.some((outcome) => !outcome.succeeded);
  const anySucceeded = outcomes.some((outcome) => outcome.succeeded);
  const ledgerBlock = serializeLedger([...context.ledger]);

  let commentReport: CliJsonOutput['comment'];
  let commentLedgerPersisted = false;

  try {
    if (anyFailed && anySucceeded) {
      // Partial failure: the visible content stays exactly as it was, but the
      // URLs still get recorded. An HTML comment renders as nothing, so a reviewer
      // sees no half-finished evidence.
      if (context.existingBody !== undefined) {
        const replaced = replaceLedgerBlock(context.existingBody, ledgerBlock);
        anomalies.push(...replaced.anomalies);
        const result = await upsertComment(deps.api, target.owner, target.repo, target.number, key, login, replaced.body);
        anomalies.push(...result.anomalies);
        commentReport = { ...result.result, ledgerOnly: true };
        commentLedgerPersisted = true;
      }
    } else if (!anyFailed) {
      const body = composeBody({
        marker: marker(key),
        caption: context.request.caption,
        rendered: [renderBatch(context.rendered)],
        ledger: ledgerBlock,
      });
      const result = await upsertComment(deps.api, target.owner, target.repo, target.number, key, login, body);
      anomalies.push(...result.anomalies);
      commentReport = { ...result.result, ledgerOnly: false };
      commentLedgerPersisted = true;
    }

    if (commentLedgerPersisted) {
      for (const report of reports) {
        if (report.status === 'uploaded' || report.status === 'reused') {
          deps.journal.appendEvent(ledgerSynced(report.digest, runScope, deps.now()));
        }
      }
    }
  } catch (error) {
    // The uploads already happened and cannot be taken back, so a failure here is
    // reported rather than thrown: the URLs are in the journal and the next run of
    // the same command repairs the comment.
    anomalies.push({
      code: 'plan-divergence',
      detail: `comment write failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const { pending } = deps.journal.foldPending();

  // Reporting success here would be a lie with a cost: assets exist that no
  // comment references, and a caller told "done" never runs the repair that would
  // fix it. A run only succeeds if the write it was for actually happened.
  const wroteWhatItShould = commentLedgerPersisted || (!anySucceeded && !anyFailed);
  const reason = anyFailed
    ? anySucceeded
      ? foldPartialUpload(outcomes)
      : worstFailureReason(reports)
    : wroteWhatItShould
      ? 'ok'
      : 'partial_upload_blocked';

  return buildOutput({
    command: 'attach',
    reason,
    assetsCreated: context.assetsCreated,
    uploaded: reports,
    target: targetReport(target),
    comment: commentReport,
    // Told on every run that actually posted something: an agent that does not
    // know this "verifies" its own upload, gets a 404, and loops on re-uploads.
    notes: commentReport ? [URL_NOT_LIVE_UNTIL_QUOTED] : undefined,
    state: foldState(outcomes),
    // `retryable` is deliberately left to the (code, reason) table rather than
    // folded here a second time. A second fold could disagree with the reason it
    // sits next to — reporting `partial_upload_blocked` alongside `retryable:true`
    // was exactly that bug.
    recovery: {
      journalPersisted: true,
      commentLedgerPersisted,
      repaired: context.repaired,
      pending: pending.map((record) => ({ scope: record.scope, digest: record.d, url: record.u })),
      journalPath: deps.journal.path,
    },
    anomalies,
  });
}

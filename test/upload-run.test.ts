import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runUpload, type UploadDeps, type UploadRequest } from '../src/upload-run.js';
import { computePlanToken, dedupeByFirstOccurrence, type PlanFingerprint } from '../src/plan-token.js';
import { computeSourceHash } from '../src/media/digest.js';
import { captureSource } from '../src/media/snapshot.js';
import { UPLOAD_EXPOSURE_FOLLOWS_QUOTING, UPLOAD_RECORDS_NOTHING, URL_NOT_LIVE_UNTIL_QUOTED } from '../src/output.js';
import type { UploadItem, UploadOutcome, UploadPort } from '../src/upload/port.js';

/**
 * `upload` is not `attach` minus a step, and these tests exist to keep it that
 * way: no comment, no journal, no ledger, no deduplication, no visibility gate.
 * Each of those absences is asserted, because each of them would be an easy and
 * expensive thing to "fix" by accident.
 */

let dir: string;
let trace: string[];

const file = (name: string, content: string): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

const okUpload = (url: string): UploadOutcome => ({ ok: true, url });
const failUnknown = (): UploadOutcome => ({
  ok: false,
  code: 5,
  reason: 'endpoint_unavailable',
  state: 'unknown',
  retryable: false,
  message: 'no answer',
});
const failNetwork = (): UploadOutcome => ({
  ok: false,
  code: 1,
  reason: 'network_unreachable',
  state: 'known',
  retryable: true,
  message: 'dns',
});
const failRejected = (): UploadOutcome => ({
  ok: false,
  code: 1,
  reason: 'rejected_by_endpoint',
  state: 'known',
  retryable: false,
  message: '422',
});

interface Harness {
  deps: UploadDeps;
  uploadCount: () => number;
  items: () => UploadItem[];
}

function harness(
  options: {
    outcomes?: UploadOutcome[];
    visibility?: 'public' | 'private';
    convertTo?: string;
    tmp?: string[];
    ffmpeg?: boolean;
  } = {},
): Harness {
  let uploads = 0;
  const items: UploadItem[] = [];

  const port: UploadPort = {
    upload: async (item) => {
      trace.push('upload');
      items.push(item);
      const outcome = options.outcomes?.[uploads] ?? okUpload(`https://example.invalid/a/${uploads}`);
      uploads += 1;
      return outcome;
    },
  };

  return {
    uploadCount: () => uploads,
    items: () => items,
    deps: {
      uploads: port,
      resolveRepo: async () => {
        trace.push('resolve-repo');
        return {
          owner: 'akholod',
          repo: 'easy-cast',
          repoSource: 'origin',
          visibility: options.visibility ?? 'private',
          repositoryId: 1336107651,
          anomalies: [],
        };
      },
      convert: async (snapshot) => {
        trace.push('convert');
        return options.convertTo
          ? { path: options.convertTo, converted: true, effectiveProfileId: 'h264-mp4' }
          : { path: snapshot.path, converted: false, effectiveProfileId: 'none' };
      },
      resolveUploadToken: async () => {
        trace.push('resolve-token');
        return { token: 'gho_fake' };
      },
      tmpPaths: () => options.tmp ?? [],
      ffmpegAvailable: () => options.ffmpeg ?? true,
    },
  };
}

const request = (files: string[], over: Partial<UploadRequest> = {}): UploadRequest => ({
  command: 'upload',
  files,
  dryRun: false,
  noConvert: true,
  ...over,
});

const tokenFor = (files: string[], over: Partial<PlanFingerprint['scope']> = {}): string => {
  const hashes = dedupeByFirstOccurrence(files.map((path) => computeSourceHash(captureSource(path))));
  return computePlanToken({
    scope: { command: 'upload', owner: 'akholod', repo: 'easy-cast', convertPolicy: 'none', ...over },
    sourceHashes: hashes,
  });
};

const run = (files: string[], over: Partial<UploadRequest> = {}, h = harness()) =>
  runUpload(request(files, { confirmPlan: tokenFor(files), ...over }), h.deps);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easy-cast-upload-'));
  trace = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('upload', () => {
  it('uploads every file and hands back the URLs', async () => {
    const h = harness();
    const output = await runUpload(
      request([file('a.png', 'one'), file('b.png', 'two')], {
        confirmPlan: tokenFor([join(dir, 'a.png'), join(dir, 'b.png')]),
      }),
      h.deps,
    );

    expect(output.exitCode).toBe(0);
    expect(output.reason).toBe('ok');
    expect(output.command).toBe('upload');
    expect(output.assetsCreated).toBe(2);
    expect(output.uploaded.map((report) => report.url)).toEqual([
      'https://example.invalid/a/0',
      'https://example.invalid/a/1',
    ]);
    expect(output.uploaded.every((report) => report.status === 'uploaded')).toBe(true);
  });

  it('writes no comment and reports no recovery, because it has neither', async () => {
    const output = await run([file('a.png', 'one')]);
    expect(output.comment).toBeUndefined();
    expect(output.recovery).toBeUndefined();
  });

  it('names the repository it uploaded against but no issue or pull request', async () => {
    const output = await run([file('a.png', 'one')]);
    expect(output.target).toEqual({
      owner: 'akholod',
      repo: 'easy-cast',
      visibility: 'private',
      repoSource: 'origin',
    });
    expect(output.target?.number).toBeUndefined();
    expect(output.target?.kind).toBeUndefined();
  });

  // The whole reason `upload` is dangerous in a way `attach` is not.
  it('uploads the same bytes again on a second run, because it deduplicates nothing', async () => {
    const path = file('a.png', 'one');
    const h = harness();

    await runUpload(request([path], { confirmPlan: tokenFor([path]) }), h.deps);
    await runUpload(request([path], { confirmPlan: tokenFor([path]) }), h.deps);

    expect(h.uploadCount()).toBe(2);
  });

  it('says on every run that it recorded nothing and that exposure follows the URL', async () => {
    const output = await run([file('a.png', 'one')]);
    expect(output.notes).toContain(UPLOAD_RECORDS_NOTHING);
    expect(output.notes).toContain(UPLOAD_EXPOSURE_FOLLOWS_QUOTING);
    expect(output.notes).toContain(URL_NOT_LIVE_UNTIL_QUOTED);
  });

  it('drops the 404-is-normal advisory when nothing was uploaded, and keeps the other two', async () => {
    const output = await run([file('a.png', 'one')], {}, harness({ outcomes: [failNetwork()] }));
    expect(output.notes).not.toContain(URL_NOT_LIVE_UNTIL_QUOTED);
    expect(output.notes).toContain(UPLOAD_RECORDS_NOTHING);
    expect(output.notes).toContain(UPLOAD_EXPOSURE_FOLLOWS_QUOTING);
  });

  // ADR 022: the asset is scoped to the uploading account, not the repository, and
  // `upload` quotes the URL nowhere — so a gate here would protect nothing while
  // reading as though it did.
  it('has no public-repository gate: a public target uploads without --allow-public', async () => {
    const h = harness({ visibility: 'public' });
    const output = await runUpload(
      request([file('a.png', 'one')], { confirmPlan: tokenFor([join(dir, 'a.png')]) }),
      h.deps,
    );

    expect(output.exitCode).toBe(0);
    expect(h.uploadCount()).toBe(1);
  });

  it('reports the digest it would have deduplicated on, without using it', async () => {
    const output = await run([file('a.png', 'one')]);
    expect(output.uploaded[0].digest).toMatch(/^[0-9a-f]{64}:none$/);
  });
});

describe('upload: the plan handshake', () => {
  it('refuses to upload without a token', async () => {
    const h = harness();
    await expect(runUpload(request([file('a.png', 'one')]), h.deps)).rejects.toMatchObject({
      reason: 'plan_missing',
    });
    expect(h.uploadCount()).toBe(0);
  });

  it('refuses a token computed for another repository, and uploads nothing', async () => {
    const path = file('a.png', 'one');
    const h = harness();
    await expect(
      runUpload(request([path], { confirmPlan: tokenFor([path], { repo: 'somewhere-else' }) }), h.deps),
    ).rejects.toMatchObject({ reason: 'plan_mismatch' });
    expect(h.uploadCount()).toBe(0);
  });

  it('refuses an attach token, because the command is part of the plan', async () => {
    const path = file('a.png', 'one');
    const attachToken = computePlanToken({
      scope: { command: 'attach', owner: 'akholod', repo: 'easy-cast', convertPolicy: 'none' },
      sourceHashes: [computeSourceHash(captureSource(path))],
    });
    const h = harness();
    await expect(
      runUpload(request([path], { confirmPlan: attachToken }), h.deps),
    ).rejects.toMatchObject({ reason: 'plan_mismatch' });
    expect(h.uploadCount()).toBe(0);
  });

  it('plans without uploading, and prints a token that the real run accepts', async () => {
    const path = file('a.png', 'one');
    const h = harness();
    const plan = await runUpload(request([path], { dryRun: true }), h.deps);

    expect(plan.exitCode).toBe(0);
    expect(plan.reason).toBe('dry_run');
    expect(plan.dryRun).toBe(true);
    expect(h.uploadCount()).toBe(0);

    const real = await runUpload(request([path], { confirmPlan: plan.planToken }), h.deps);
    expect(real.reason).toBe('ok');
    expect(h.uploadCount()).toBe(1);
  });

  // In `attach` a video's planned action is `unknown`, because the conversion
  // profile decides the ledger key and therefore upload-versus-reuse. Nothing is
  // ever reused here, so the answer is knowable at plan time.
  it('plans video as would-upload rather than unknown, because nothing is ever reused', async () => {
    const plan = await runUpload(
      request([file('clip.mp4', 'video')], { dryRun: true, noConvert: false }),
      harness().deps,
    );
    expect(plan.uploaded[0].plannedAction).toBe('would-upload');
  });

  it('reports whether ffmpeg is available, since it changes what would be uploaded', async () => {
    const plan = await runUpload(
      request([file('clip.mp4', 'video')], { dryRun: true }),
      harness({ ffmpeg: false }).deps,
    );
    expect(plan.environment).toEqual({ ffmpegAvailable: false });
  });

  it('says nothing about ffmpeg when the batch has no video for it to convert', async () => {
    const plan = await runUpload(request([file('a.png', 'one')], { dryRun: true }), harness().deps);
    expect(plan.environment).toBeUndefined();
  });
});

describe('upload: the batch', () => {
  it('refuses the whole batch when one file is unusable, before any upload', async () => {
    const h = harness();
    await expect(
      runUpload(request([file('a.png', 'one'), file('notes.txt', 'two')]), h.deps),
    ).rejects.toMatchObject({ reason: 'unsupported_extension' });
    expect(h.uploadCount()).toBe(0);
  });

  it('uploads a file named twice only once', async () => {
    const path = file('a.png', 'one');
    const h = harness();
    await runUpload(request([path, path], { confirmPlan: tokenFor([path, path]) }), h.deps);
    expect(h.uploadCount()).toBe(1);
  });

  it('converts video and leaves images alone', async () => {
    const converted = join(dir, 'converted.mp4');
    writeFileSync(converted, 'mp4-bytes');
    const h = harness({ convertTo: converted });

    await runUpload(
      request([file('shot.png', 'png'), file('clip.mov', 'mov')], {
        noConvert: false,
        confirmPlan: tokenFor([join(dir, 'shot.png'), join(dir, 'clip.mov')], { convertPolicy: 'auto' }),
      }),
      h.deps,
    );

    expect(trace.filter((step) => step === 'convert')).toHaveLength(1);
    expect(h.items()[0]).toMatchObject({ fileName: 'shot.png', contentType: 'image/png' });
    // Converted bytes are mp4, so they must be declared as mp4 — the endpoint
    // validates the declared type against the file name.
    expect(h.items()[1]).toMatchObject({ fileName: 'clip.mp4', contentType: 'video/mp4' });
    expect(h.items()[1].bytes.toString()).toBe('mp4-bytes');
  });

  it('removes every temporary file it made, including when the run failed', async () => {
    const temp = file('tmp.mp4', 'scratch');
    const h = harness({ tmp: [temp], outcomes: [failUnknown()] });
    await runUpload(request([file('a.png', 'one')], { confirmPlan: tokenFor([join(dir, 'a.png')]) }), h.deps);
    expect(existsSync(temp)).toBe(false);
  });
});

describe('upload: failures', () => {
  it('is a retryable partial upload when every failure is known not to have landed', async () => {
    const output = await run(
      [file('a.png', 'one'), file('b.png', 'two')],
      { confirmPlan: tokenFor([join(dir, 'a.png'), join(dir, 'b.png')]) },
      harness({ outcomes: [okUpload('https://example.invalid/a/0'), failNetwork()] }),
    );

    expect(output.exitCode).toBe(4);
    expect(output.reason).toBe('partial_upload_retryable');
    expect(output.state).toBe('mixed');
    expect(output.assetsCreated).toBe(1);
  });

  it('is a blocked partial upload as soon as one outcome is unknown', async () => {
    const output = await run(
      [file('a.png', 'one'), file('b.png', 'two')],
      { confirmPlan: tokenFor([join(dir, 'a.png'), join(dir, 'b.png')]) },
      harness({ outcomes: [okUpload('https://example.invalid/a/0'), failUnknown()] }),
    );

    expect(output.exitCode).toBe(4);
    expect(output.reason).toBe('partial_upload_blocked');
    expect(output.retryable).toBe(false);
  });

  // The answer must not depend on the order the files happened to be listed in.
  it('names the most serious failure, not the first one', async () => {
    const output = await run(
      [file('a.png', 'one'), file('b.png', 'two')],
      { confirmPlan: tokenFor([join(dir, 'a.png'), join(dir, 'b.png')]) },
      harness({ outcomes: [failNetwork(), failRejected()] }),
    );

    expect(output.reason).toBe('rejected_by_endpoint');
    expect(output.assetsCreated).toBe(0);
  });

  it('never claims a repeat is safe while the remote state is unknown', async () => {
    const output = await run([file('a.png', 'one')], {}, harness({ outcomes: [failUnknown()] }));
    expect(output.exitCode).toBe(5);
    expect(output.state).toBe('unknown');
    expect(output.retryable).toBe(false);
  });
});

/**
 * Structural, not behavioural: `upload` must have nothing to record with. A
 * journal entry it could never sync would sit in `recover` forever as a backlog
 * nobody can clear, so the absence is enforced here rather than left to review.
 */
describe('upload keeps no local state, structurally', () => {
  const root = resolve(import.meta.dirname, '..');
  const source = readFileSync(resolve(root, 'src/upload-run.ts'), 'utf8');

  it('does not import the journal, the ledger or the comment modules', () => {
    for (const forbidden of ['journal.js', 'ledger.js', 'marker.js', 'upsert.js', 'body.js']) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('still finds those imports in the pipeline, so the check is not vacuous', () => {
    const pipeline = readFileSync(resolve(root, 'src/pipeline.ts'), 'utf8');
    expect(pipeline).toContain('journal.js');
    expect(pipeline).toContain('ledger.js');
  });
});

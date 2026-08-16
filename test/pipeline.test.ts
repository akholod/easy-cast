import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAttach, type PipelineDeps, type PipelineRequest } from '../src/pipeline.js';
import { createJournal, assetRecorded, type Journal, type Scope } from '../src/journal.js';
import { computePlanToken, dedupeByFirstOccurrence, type PlanFingerprint } from '../src/plan-token.js';
import { computeSourceHash } from '../src/media/digest.js';
import { captureSource } from '../src/media/snapshot.js';
import { defaultKey, marker } from '../src/comment/marker.js';
import { serializeLedger } from '../src/comment/ledger.js';
import type { GitHubApi, OwnComment } from '../src/github/api.js';
import type { ResolvedTarget } from '../src/target/resolve.js';
import type { UploadOutcome, UploadPort } from '../src/upload/port.js';
import { EasyCastError } from '../src/errors.js';

let dir: string;
let journal: Journal;
let trace: string[];

const target: ResolvedTarget = {
  owner: 'akholod',
  repo: 'easy-cast',
  kind: 'pr',
  number: 42,
  visibility: 'private',
  htmlUrl: 'https://github.com/akholod/easy-cast/pull/42',
  repoSource: 'origin',
  anomalies: [],
};

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

interface Harness {
  deps: PipelineDeps;
  comments: OwnComment[];
  uploadCount: () => number;
}

function harness(
  options: {
    outcomes?: UploadOutcome[];
    comments?: OwnComment[];
    visibility?: 'public' | 'private';
    failWrite?: boolean;
    tmp?: string[];
  } = {},
): Harness {
  const comments = options.comments ?? [];
  let uploads = 0;

  const api: GitHubApi = {
    getViewerLogin: async () => 'akholod',
    getRepo: async () => ({ id: 1, visibility: options.visibility ?? 'private' }),
    findPullForBranch: async () => ({ number: 42 }),
    getIssueOrPull: async () => ({ htmlUrl: target.htmlUrl, kind: 'pr' }),
    listComments: async function* () {
      for (const item of comments) yield item;
    },
    createComment: async (_o, _r, _n, body) => {
      trace.push('write');
      if (options.failWrite) throw new Error('502 from GitHub');
      comments.push({
        id: 900,
        url: 'https://example.invalid/c/900',
        body,
        createdAt: '2026-08-16T00:00:00Z',
        authorLogin: 'akholod',
      });
      return { id: 900, url: 'https://example.invalid/c/900' };
    },
    updateComment: async (_o, _r, id, body) => {
      trace.push('write');
      if (options.failWrite) throw new Error('502 from GitHub');
      const found = comments.find((c) => c.id === id);
      if (found) comments[comments.indexOf(found)] = { ...found, body };
      return { id, url: `https://example.invalid/c/${id}` };
    },
  };

  const uploadsPort: UploadPort = {
    upload: async () => {
      trace.push('upload');
      const outcome = options.outcomes?.[uploads] ?? okUpload(`https://example.invalid/a/${uploads}`);
      uploads += 1;
      return outcome;
    },
  };

  return {
    comments,
    uploadCount: () => uploads,
    deps: {
      api,
      journal,
      uploads: uploadsPort,
      resolveTarget: async () => {
        trace.push('resolve-target');
        return { ...target, visibility: options.visibility ?? 'private' };
      },
      convert: async (snapshot) => {
        trace.push('convert');
        return { path: snapshot.path, converted: false, effectiveProfileId: 'none' };
      },
      resolveUploadToken: async () => {
        trace.push('resolve-token');
        return { token: 'gho_fake', login: 'akholod' };
      },
      assertIdentity: () => trace.push('identity'),
      uploadTarget: async () => ({ owner: 'akholod', repo: 'easy-cast', repositoryId: 1336107651 }),
      now: () => '2026-08-16T00:00:00Z',
      tmpPaths: () => options.tmp ?? [],
      ffmpegAvailable: () => true,
    },
  };
}

const request = (files: string[], over: Partial<PipelineRequest> = {}): PipelineRequest => ({
  command: 'attach',
  files,
  dryRun: false,
  noConvert: true,
  allowPublic: false,
  ...over,
});

const tokenFor = (files: string[], over: Partial<PlanFingerprint['scope']> = {}): string => {
  // Deduplicated, exactly as the pipeline does it — a file named twice is one
  // entry in the plan, so the token must be computed over the same set.
  const hashes = dedupeByFirstOccurrence(files.map((path) => computeSourceHash(captureSource(path))));
  return computePlanToken({
    scope: {
      command: 'attach',
      owner: 'akholod',
      repo: 'easy-cast',
      kind: 'pr',
      number: 42,
      key: defaultKey('attach', hashes),
      convertPolicy: 'none',
      ...over,
    },
    sourceHashes: hashes,
  });
};

const run = (files: string[], over: Partial<PipelineRequest> = {}, h = harness()) =>
  runAttach(request(files, { confirmPlan: tokenFor(files), ...over }), h.deps);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easy-cast-pipeline-'));
  journal = createJournal(join(dir, 'state'));
  trace = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ordering', () => {
  // The whole safety story depends on this sequence. Uploading before the gates
  // would make every gate advisory.
  it('runs pre-flight, then repair, then uploads, then the write', async () => {
    const a = file('a.png', 'aaa');
    journal.appendEvent(
      assetRecorded('stale:none', 'https://example.invalid/old', {
        owner: 'akholod',
        repo: 'easy-cast',
        kind: 'pr',
        number: 42,
        key: defaultKey('attach', [computeSourceHash(captureSource(a))]),
      } satisfies Scope, 't'),
    );

    await run([a]);

    expect(trace.filter((step) => step !== 'identity')).toEqual([
      'resolve-target',
      'resolve-token',
      'write', // the repair write, before any upload
      'upload',
      'write',
    ]);
  });

  // A video, so conversion actually happens — with an image the assertion would
  // hold vacuously because `convert` is never reached at all.
  it('converts before the upload token is ever resolved', async () => {
    const clip = file('clip.webm', 'vvv');
    await runAttach(
      request([clip], { noConvert: false, confirmPlan: tokenFor([clip], { convertPolicy: 'auto' }) }),
      harness().deps,
    );
    expect(trace).toContain('convert');
    expect(trace.indexOf('convert')).toBeLessThan(trace.indexOf('resolve-token'));
  });
});

describe('pre-flight refusals leave nothing behind', () => {
  it('refuses a public repository without --allow-public, before any upload', async () => {
    const h = harness({ visibility: 'public' });
    const a = file('a.png', 'aaa');
    await expect(runAttach(request([a], { confirmPlan: tokenFor([a]) }), h.deps)).rejects.toMatchObject({
      reason: 'refused_public',
    });
    expect(h.uploadCount()).toBe(0);
  });

  // Validating everything up front is what makes "the third file was bad, so
  // nothing was uploaded" true rather than aspirational.
  it('uploads nothing at all when the third of five files is unusable', async () => {
    const h = harness();
    const files = [
      file('1.png', '1'),
      file('2.png', '2'),
      file('3.exe', '3'),
      file('4.png', '4'),
      file('5.png', '5'),
    ];
    try {
      await runAttach(request(files, { confirmPlan: 'irrelevant' }), h.deps);
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect((error as EasyCastError).reason).toBe('unsupported_extension');
      expect((error as EasyCastError).outcome.exitCode).toBe(2);
    }
    expect(h.uploadCount()).toBe(0);
    expect(trace).not.toContain('upload');
  });

  it('refuses a batch too large for the ledger before uploading any of it', async () => {
    const h = harness();
    const files = Array.from({ length: 65 }, (_, i) => file(`f${i}.png`, `content-${i}`));
    await expect(runAttach(request(files, { confirmPlan: 'x' }), h.deps)).rejects.toMatchObject({
      reason: 'ledger_capacity_exceeded',
    });
    expect(h.uploadCount()).toBe(0);
  });

  it('refuses without a plan token, and uploads nothing', async () => {
    const h = harness();
    const a = file('a.png', 'aaa');
    await expect(runAttach(request([a]), h.deps)).rejects.toMatchObject({ reason: 'plan_missing' });
    expect(h.uploadCount()).toBe(0);
  });

  it('refuses a token that was issued for a different file set', async () => {
    const h = harness();
    const a = file('a.png', 'aaa');
    const other = file('b.png', 'bbb');
    await expect(
      runAttach(request([a], { confirmPlan: tokenFor([other]) }), h.deps),
    ).rejects.toMatchObject({ reason: 'plan_mismatch' });
    expect(h.uploadCount()).toBe(0);
  });
});

describe('dry run', () => {
  it('does no repair, no conversion, no upload and no write', async () => {
    const h = harness();
    const a = file('a.png', 'aaa');
    journal.appendEvent(
      assetRecorded('pending:none', 'https://example.invalid/p', {
        owner: 'akholod',
        repo: 'easy-cast',
        kind: 'pr',
        number: 42,
        key: defaultKey('attach', [computeSourceHash(captureSource(a))]),
      } satisfies Scope, 't'),
    );

    const output = await runAttach(request([a], { dryRun: true }), h.deps);

    expect(trace).toEqual(['resolve-target']);
    expect(h.uploadCount()).toBe(0);
    expect(output.exitCode).toBe(0);
    expect(output.reason).toBe('dry_run');
    expect(output.nextAction).toBe('request-plan');
    expect(output.planToken).toBe(tokenFor([a]));
    // The backlog is shown, not acted on — repair belongs to a real run.
    expect(output.recovery?.pending).toHaveLength(1);
  });

  it('reports the plan for a video as unknown, because conversion has not run', async () => {
    const output = await runAttach(
      request([file('clip.webm', 'vvv')], { dryRun: true, noConvert: false }),
      harness().deps,
    );
    expect(output.uploaded[0].plannedAction).toBe('unknown');
  });

  it('always returns the target, which is what shows the inferred repository', async () => {
    const output = await runAttach(request([file('a.png', 'aaa')], { dryRun: true }), harness().deps);
    expect(output.target).toMatchObject({ owner: 'akholod', repo: 'easy-cast', repoSource: 'origin' });
  });

  // A plan that hides the size or whether conversion will even happen is not a
  // plan anyone can judge before consenting to something irreversible.
  it('states each file’s size and verdict, and whether ffmpeg is available here', async () => {
    const output = await runAttach(request([file('a.png', 'aaa')], { dryRun: true }), harness().deps);
    expect(output.uploaded[0].sizeBytes).toBe(3);
    expect(output.uploaded[0].sizeVerdict).toBe('ok');
    expect(output.environment).toEqual({ ffmpegAvailable: true });
  });
});

describe('conversion is only ever applied to video', () => {
  // Running an image through the video profile would upload mp4 bytes under its
  // original name and image content type — a file that is not what it claims, and
  // that cannot be taken back.
  it('never converts an image', async () => {
    const seen: string[] = [];
    const h = harness();
    const deps = {
      ...h.deps,
      convert: async (snapshot: { path: string }) => {
        seen.push(snapshot.path);
        return { path: snapshot.path, converted: false, effectiveProfileId: 'none' };
      },
    };
    const png = file('a.png', 'aaa');
    await runAttach(request([png], { noConvert: false, confirmPlan: tokenFor([png], { convertPolicy: 'auto' }) }), deps);
    expect(seen).toEqual([]);
  });

  it('declares converted bytes as mp4, under an mp4 name', async () => {
    const items: { fileName: string; contentType: string }[] = [];
    const h = harness();
    const clip = file('clip.webm', 'vvv');
    const deps = {
      ...h.deps,
      convert: async (snapshot: { path: string }) => ({
        path: snapshot.path,
        converted: true,
        effectiveProfileId: 'h264',
      }),
      uploads: {
        upload: async (item: { fileName: string; contentType: string }) => {
          items.push({ fileName: item.fileName, contentType: item.contentType });
          return okUpload('https://example.invalid/a/0');
        },
      },
    };
    await runAttach(
      request([clip], { noConvert: false, confirmPlan: tokenFor([clip], { convertPolicy: 'auto' }) }),
      deps,
    );
    expect(items).toEqual([{ fileName: 'clip.mp4', contentType: 'video/mp4' }]);
  });
});

describe('a run only succeeds if the write it was for actually happened', () => {
  // Reporting success would be a lie with a cost: assets exist that no comment
  // references, and a caller told "done" never runs the repair that fixes it.
  it('does not report exit 0 when every upload landed but the comment write failed', async () => {
    const h = harness({ failWrite: true });
    const a = file('a.png', 'aaa');
    const output = await runAttach(request([a], { confirmPlan: tokenFor([a]) }), h.deps);

    expect(output.reason).toBe('partial_upload_blocked');
    expect(output.exitCode).toBe(4);
    expect(output.ok).toBe(false);
    expect(output.nextAction).toBe('report-to-human');
    // The specific contradiction that hid here: reporting a blocked run while
    // still advertising it as safe to repeat.
    expect(output.retryable).toBe(false);
    expect(output.recovery?.commentLedgerPersisted).toBe(false);
  });

  it('keeps the real reason when every upload failed, instead of flattening it to a network error', async () => {
    const h = harness({ outcomes: [failUnknown()] });
    const a = file('a.png', 'aaa');
    const output = await runAttach(request([a], { confirmPlan: tokenFor([a]) }), h.deps);
    expect(output.reason).toBe('endpoint_unavailable');
    expect(output.retryable).toBe(false);
  });

  // Taking the first failure would let the order the files happened to be listed
  // in decide whether the caller is told to retry.
  it('reports the worst failure in the batch, not whichever came first', async () => {
    const h = harness({ outcomes: [failNetwork(), failUnknown()] });
    const files = [file('a.png', 'aaa'), file('b.png', 'bbb')];
    const output = await runAttach(request(files, { confirmPlan: tokenFor(files) }), h.deps);

    expect(output.reason).toBe('endpoint_unavailable');
    expect(output.retryable).toBe(false);
    expect(output.nextAction).toBe('report-to-human');
  });

  // reason and retryable are read together by an agent; disagreeing is worse than
  // either being wrong alone.
  it('never contradicts itself between reason, retryable and nextAction', async () => {
    for (const outcomes of [[failNetwork()], [failUnknown()], [okUpload('u'), failNetwork()]]) {
      const files = outcomes.map((_, i) => file(`f${i}-${outcomes.length}.png`, `c${i}`));
      const output = await runAttach(
        request(files, { confirmPlan: tokenFor(files) }),
        harness({ outcomes }).deps,
      );
      if (output.nextAction === 'retry') expect(output.retryable).toBe(true);
      if (output.retryable === false) expect(output.nextAction).not.toBe('retry');
      if (output.state === 'unknown') expect(output.retryable).toBe(false);
    }
  });
});

describe('advisories', () => {
  // Without this an agent "verifies" its own upload, gets the expected 404, and
  // loops on re-uploads — each one permanent.
  it('warns that the URL stays 404 until something quotes it, once a comment exists', async () => {
    const output = await run([file('a.png', 'aaa')]);
    // Established by stage 0: the canonical URL answers 404 to a direct GET in
    // every case, cited or not. The image is served through a signed URL that
    // GitHub substitutes at render time.
    expect(output.notes?.join(' ')).toMatch(/answers 404 if you fetch it directly/);
    expect(output.notes?.join(' ')).toMatch(/Do not re-upload/);
  });

  it('says nothing of the sort when no comment was written', async () => {
    const h = harness({ failWrite: true });
    const a = file('a.png', 'aaa');
    const output = await runAttach(request([a], { confirmPlan: tokenFor([a]) }), h.deps);
    expect(output.notes).toBeUndefined();
  });
});

describe('batch behaviour', () => {
  it('uploads a repeated file once, keeping the first occurrence', async () => {
    const a = file('a.png', 'same');
    const b = file('b.png', 'same');
    const h = harness();
    const output = await runAttach(
      request([a, b], { confirmPlan: tokenFor([a, b]) }),
      h.deps,
    );
    expect(h.uploadCount()).toBe(1);
    expect(output.uploaded).toHaveLength(1);
    expect(output.uploaded[0].name).toBe('a.png');
  });

  it('creates nothing when every file is already in the ledger', async () => {
    const a = file('a.png', 'aaa');
    const key = defaultKey('attach', [computeSourceHash(captureSource(a))]);
    const digest = `${computeSourceHash(captureSource(a))}:none`;
    const h = harness({
      comments: [
        {
          id: 5,
          url: 'https://example.invalid/c/5',
          body: `${marker(key)}\n\n${serializeLedger([[digest, 'https://example.invalid/known']])}`,
          createdAt: '2026-08-16T00:00:00Z',
          authorLogin: 'akholod',
        },
      ],
    });

    const output = await runAttach(request([a], { confirmPlan: tokenFor([a]) }), h.deps);
    expect(h.uploadCount()).toBe(0);
    expect(output.assetsCreated).toBe(0);
    expect(output.exitCode).toBe(0);
    expect(output.uploaded[0].status).toBe('reused');
  });
});

describe('partial failure', () => {
  it('records what landed, leaves visible content alone, and stays retryable when every failure was transport', async () => {
    const h = harness({ outcomes: [okUpload('https://example.invalid/a/0'), failNetwork()] });
    const files = [file('a.png', 'aaa'), file('b.png', 'bbb')];
    const output = await runAttach(request(files, { confirmPlan: tokenFor(files) }), h.deps);

    expect(output.exitCode).toBe(4);
    expect(output.reason).toBe('partial_upload_retryable');
    expect(output.nextAction).toBe('retry');
    expect(output.assetsCreated).toBe(1);
  });

  // One unknown outcome means a repeat could duplicate an attachment that can
  // never be removed, so the run must stop being retryable.
  it('blocks a retry when any outcome is unknown', async () => {
    const h = harness({ outcomes: [okUpload('https://example.invalid/a/0'), failUnknown()] });
    const files = [file('a.png', 'aaa'), file('b.png', 'bbb')];
    const output = await runAttach(request(files, { confirmPlan: tokenFor(files) }), h.deps);

    expect(output.reason).toBe('partial_upload_blocked');
    expect(output.nextAction).toBe('report-to-human');
    expect(output.retryable).toBe(false);
  });
});

describe('a comment write that fails after the uploads', () => {
  it('reports the loss instead of throwing, and keeps the URL recoverable', async () => {
    const h = harness({ failWrite: true });
    const a = file('a.png', 'aaa');
    const output = await runAttach(request([a], { confirmPlan: tokenFor([a]) }), h.deps);

    expect(output.assetsCreated).toBe(1);
    expect(output.recovery?.commentLedgerPersisted).toBe(false);
    expect(output.recovery?.pending).toHaveLength(1);
    expect(journal.foldPending().pending[0].u).toBe('https://example.invalid/a/0');
  });
});

describe('temporary files', () => {
  it('removes them on the success path', async () => {
    const stale = file('tmp-ok.mp4', 'x');
    await run([file('a.png', 'aaa')], {}, harness({ tmp: [stale] }));
    expect(existsSync(stale)).toBe(false);
  });

  it('removes them on the failure path too', async () => {
    const stale = file('tmp-fail.mp4', 'x');
    const h = harness({ visibility: 'public', tmp: [stale] });
    const a = file('a.png', 'aaa');
    await expect(runAttach(request([a], { confirmPlan: tokenFor([a]) }), h.deps)).rejects.toThrow();
    expect(existsSync(stale)).toBe(false);
  });
});

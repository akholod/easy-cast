import { describe, expect, it } from 'vitest';
import { findOwnComment, upsertComment } from '../src/comment/upsert.js';
import { marker } from '../src/comment/marker.js';
import { resolveTarget } from '../src/target/resolve.js';
import { parseTarget } from '../src/target/parse.js';
import type { GitHubApi, OwnComment, RepoVisibility } from '../src/github/api.js';
import type { GitReader } from '../src/target/infer-repo.js';
import { EasyCastError } from '../src/errors.js';

const comment = (over: Partial<OwnComment> & { id: number }): OwnComment => ({
  url: `https://example.invalid/c/${over.id}`,
  body: '',
  createdAt: '2026-08-16T00:00:00Z',
  authorLogin: 'akholod',
  ...over,
});

interface FakeOptions {
  comments?: OwnComment[];
  visibility?: RepoVisibility;
  repoExists?: boolean;
  target?: { htmlUrl: string; kind: 'pr' | 'issue' } | undefined;
  pullForBranch?: { number: number } | undefined;
}

const calls: { updated: number[]; created: string[] } = { updated: [], created: [] };

function fakeApi(options: FakeOptions = {}): GitHubApi {
  const comments = options.comments ?? [];
  return {
    getViewerLogin: async () => 'akholod',
    getRepo: async () =>
      options.repoExists === false ? undefined : { id: 1, visibility: options.visibility ?? 'private' },
    findPullForBranch: async () => options.pullForBranch,
    getIssueOrPull: async () =>
      options.target === undefined && 'target' in options
        ? undefined
        : (options.target ?? { htmlUrl: 'https://example.invalid/pr/42', kind: 'pr' as const }),
    listComments: async function* () {
      for (const item of comments) yield item;
    },
    createComment: async (_o, _r, _n, body) => {
      calls.created.push(body);
      return { id: 999, url: 'https://example.invalid/c/999' };
    },
    updateComment: async (_o, _r, id) => {
      calls.updated.push(id);
      return { id, url: `https://example.invalid/c/${id}` };
    },
  };
}

const git = (): GitReader => ({
  topLevel: () => '/repo',
  remotes: () => [{ name: 'origin', pushUrls: ['https://github.com/akholod/easy-cast.git'] }],
});

const deps = (api: GitHubApi, branch: string | undefined = 'feature') => ({
  api,
  git: git(),
  cwd: '/repo',
  currentBranch: async () => branch,
});

describe('finding our own comment', () => {
  it('finds the one carrying our marker', async () => {
    const api = fakeApi({
      comments: [comment({ id: 1, body: 'unrelated' }), comment({ id: 2, body: marker('k') })],
    });
    const found = await findOwnComment(api, 'o', 'r', 1, 'k', 'akholod');
    expect(found.chosen?.id).toBe(2);
  });

  // Rewriting somebody else's comment because it happens to carry a matching
  // marker would be the worst thing this tool could do to a pull request.
  it('ignores a matching marker written by somebody else', async () => {
    const api = fakeApi({
      comments: [comment({ id: 3, body: marker('k'), authorLogin: 'someone-else' })],
    });
    expect((await findOwnComment(api, 'o', 'r', 1, 'k', 'akholod')).chosen).toBeUndefined();
  });

  it('ignores a comment carrying a different key', async () => {
    const api = fakeApi({ comments: [comment({ id: 4, body: marker('other') })] });
    expect((await findOwnComment(api, 'o', 'r', 1, 'k', 'akholod')).chosen).toBeUndefined();
  });

  it('takes the oldest when several carry the marker, and leaves the rest alone', async () => {
    const api = fakeApi({
      comments: [
        comment({ id: 20, body: marker('k'), createdAt: '2026-08-16T02:00:00Z' }),
        comment({ id: 10, body: marker('k'), createdAt: '2026-08-16T01:00:00Z' }),
      ],
    });
    const found = await findOwnComment(api, 'o', 'r', 1, 'k', 'akholod');
    expect(found.chosen?.id).toBe(10);
    expect(found.duplicates.map((c) => c.id)).toEqual([20]);
    expect(found.anomalies.map((a) => a.code)).toEqual(['duplicate-markers']);
  });

  it('matches the login case-insensitively', async () => {
    const api = fakeApi({ comments: [comment({ id: 5, body: marker('k'), authorLogin: 'AkHolod' })] });
    expect((await findOwnComment(api, 'o', 'r', 1, 'k', 'akholod')).chosen?.id).toBe(5);
  });
});

describe('upsert', () => {
  it('updates the existing comment rather than adding another', async () => {
    calls.updated = [];
    const api = fakeApi({ comments: [comment({ id: 7, body: marker('k') })] });
    const { result } = await upsertComment(api, 'o', 'r', 1, 'k', 'akholod', 'new body');
    expect(result).toMatchObject({ id: 7, created: false });
    expect(calls.updated).toEqual([7]);
  });

  it('creates one when none of ours is there', async () => {
    calls.created = [];
    const { result } = await upsertComment(fakeApi(), 'o', 'r', 1, 'k', 'akholod', 'fresh body');
    expect(result).toMatchObject({ id: 999, created: true });
    expect(calls.created).toEqual(['fresh body']);
  });
});

describe('target resolution', () => {
  it('resolves an explicit pull request and reports visibility without acting on it', async () => {
    const resolved = await resolveTarget(parseTarget('pr:42'), undefined, deps(fakeApi({ visibility: 'public' })));
    expect(resolved).toMatchObject({
      owner: 'akholod',
      repo: 'easy-cast',
      kind: 'pr',
      number: 42,
      visibility: 'public',
      repoSource: 'origin',
    });
  });

  it('derives the pull request from the current branch', async () => {
    const resolved = await resolveTarget(
      parseTarget('pr'),
      undefined,
      deps(fakeApi({ pullForBranch: { number: 7 } })),
    );
    expect(resolved.number).toBe(7);
  });

  // Exit 3 and nothing else: the tool never opens a pull request on its own and
  // never quietly retargets to a neighbouring number.
  it('refuses with exit 3 when the branch has no pull request, naming the branch', async () => {
    try {
      await resolveTarget(parseTarget('pr'), undefined, deps(fakeApi({ pullForBranch: undefined })));
      expect.unreachable('expected a target_not_found failure');
    } catch (error) {
      expect((error as EasyCastError).reason).toBe('target_not_found');
      expect((error as EasyCastError).outcome.exitCode).toBe(3);
      expect((error as EasyCastError).context.branch).toBe('feature');
    }
  });

  it('refuses with exit 3 on a detached HEAD instead of guessing', async () => {
    await expect(
      resolveTarget(parseTarget('pr'), undefined, deps(fakeApi(), undefined)),
    ).rejects.toMatchObject({ reason: 'target_not_found' });
  });

  it('refuses with exit 3 when the issue does not exist', async () => {
    await expect(
      resolveTarget(parseTarget('issue:5'), undefined, deps(fakeApi({ target: undefined }))),
    ).rejects.toMatchObject({ reason: 'target_not_found' });
  });

  // A 404 cannot tell "does not exist" from "not visible to this token", so the
  // message must not claim either one.
  it('stays disjunctive when the repository itself is not visible', async () => {
    try {
      await resolveTarget(parseTarget('pr:1'), undefined, deps(fakeApi({ repoExists: false })));
      expect.unreachable('expected a target_not_found failure');
    } catch (error) {
      expect((error as EasyCastError).message).toContain('either does not exist or');
    }
  });

  // Being handed an issue when a pull request was asked for is not a near miss to
  // smooth over — the attachment would land somewhere the caller never named, and
  // it could not be taken back.
  it('refuses when the number turns out to be the other kind of thing', async () => {
    const asIssue = fakeApi({ target: { htmlUrl: 'https://example.invalid/i/42', kind: 'issue' } });
    await expect(resolveTarget(parseTarget('pr:42'), undefined, deps(asIssue))).rejects.toMatchObject({
      reason: 'target_not_found',
    });

    const asPull = fakeApi({ target: { htmlUrl: 'https://example.invalid/pr/42', kind: 'pr' } });
    await expect(resolveTarget(parseTarget('issue:42'), undefined, deps(asPull))).rejects.toMatchObject({
      reason: 'target_not_found',
    });
  });

  it('still accepts a pull request found from the branch, which names no kind', async () => {
    const resolved = await resolveTarget(
      parseTarget('pr'),
      undefined,
      deps(fakeApi({ pullForBranch: { number: 7 }, target: { htmlUrl: 'x', kind: 'pr' } })),
    );
    expect(resolved.kind).toBe('pr');
  });

  it('honours an explicit --repo over the git remote', async () => {
    const resolved = await resolveTarget(parseTarget('pr:1'), 'someone/thing', deps(fakeApi()));
    expect(resolved).toMatchObject({ owner: 'someone', repo: 'thing', repoSource: 'flag' });
  });
});

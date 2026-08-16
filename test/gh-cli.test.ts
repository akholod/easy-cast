import { describe, expect, it } from 'vitest';
import { createGhApi, type GhApiDeps } from '../src/github/gh-cli.js';
import type { OwnComment } from '../src/github/api.js';
import type { SpawnScrubbedOptions, SpawnScrubbedResult } from '../src/secret/spawn.js';
import { ghAllowEnv } from '../src/secret/token.js';
import { redact } from '../src/secret/redact.js';
import { EasyCastError } from '../src/errors.js';

/**
 * No network and no real `gh`: every case here is a canned answer keyed on the
 * argv the implementation chose, which is also what makes the argv itself
 * observable.
 */

const FAKE = 'ghp_FAKETOKENFAKETOKENFAKETOKENFAKE0123';
const MARKER = '<!-- easy-cast:v1 key=shot -->';

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnScrubbedOptions;
}

type Respond = (args: readonly string[]) => Partial<SpawnScrubbedResult>;

const fakeGh = (respond: Respond) => {
  const calls: Call[] = [];
  const spawn: GhApiDeps['spawn'] = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: '', stderr: '', exitCode: 0, ...respond(args) };
  };
  return { calls, spawn };
};

const apiWith = (respond: Respond, source: 'gh' | 'GH_TOKEN' = 'gh') => {
  const gh = fakeGh(respond);
  return { gh, api: createGhApi({ spawn: gh.spawn, allowEnv: ghAllowEnv(source) }) };
};

const ok = (payload: unknown): Partial<SpawnScrubbedResult> => ({ stdout: JSON.stringify(payload) });

const httpError = (status: number, message: string): Partial<SpawnScrubbedResult> => ({
  exitCode: 1,
  stderr: `gh: ${message} (HTTP ${status})\n`,
});

const endpointOf = (args: readonly string[]): string => args[1] ?? '';

const comment = (id: number, body: string) => ({
  id,
  html_url: `https://github.com/akholod/easy-cast/issues/7#issuecomment-${id}`,
  body,
  created_at: '2026-01-01T00:00:00Z',
  user: { login: 'akholod' },
});

describe('getViewerLogin', () => {
  it('asks gh for the login of the account it is running as', async () => {
    const { gh, api } = apiWith(() => ({ stdout: 'akholod\n' }));
    expect(await api.getViewerLogin()).toBe('akholod');
    expect(gh.calls[0]?.args).toEqual(['api', 'user', '--jq', '.login']);
  });
});

describe('getRepo', () => {
  it('reports the id and the visibility', async () => {
    const { gh, api } = apiWith(() => ok({ id: 42, visibility: 'private', private: true }));
    expect(await api.getRepo('akholod', 'easy-cast')).toEqual({ id: 42, visibility: 'private' });
    expect(endpointOf(gh.calls[0]?.args ?? [])).toBe('repos/akholod/easy-cast');
  });

  it('returns undefined on a 404 rather than throwing, so the caller can say "no access or not found"', async () => {
    const { api } = apiWith(() => httpError(404, 'Not Found'));
    expect(await api.getRepo('akholod', 'nope')).toBeUndefined();
  });

  it('refuses an unrecognised visibility instead of guessing the public gate', async () => {
    const { api } = apiWith(() => ok({ id: 42, visibility: 'secret-new-tier' }));
    await expect(api.getRepo('akholod', 'easy-cast')).rejects.toThrow(EasyCastError);
  });
});

describe('findPullForBranch', () => {
  it('returns the number of the open pull request for the branch', async () => {
    const { gh, api } = apiWith(() => ok([{ number: 7 }, { number: 9 }]));
    expect(await api.findPullForBranch('akholod', 'easy-cast', 'feat/paginate')).toEqual({ number: 7 });
    // A branch name is a path segment of its own; unencoded it would forge the query.
    expect(endpointOf(gh.calls[0]?.args ?? [])).toBe(
      'repos/akholod/easy-cast/pulls?state=open&head=akholod:feat%2Fpaginate',
    );
  });

  it('returns undefined when the branch has no open pull request', async () => {
    const { api } = apiWith(() => ok([]));
    expect(await api.findPullForBranch('akholod', 'easy-cast', 'main')).toBeUndefined();
  });
});

describe('getIssueOrPull', () => {
  it('reads a pull request through the issues endpoint and calls it a pr', async () => {
    const { gh, api } = apiWith(() =>
      ok({ html_url: 'https://github.com/akholod/easy-cast/pull/7', pull_request: { url: 'x' } }),
    );
    expect(await api.getIssueOrPull('akholod', 'easy-cast', 7)).toEqual({
      htmlUrl: 'https://github.com/akholod/easy-cast/pull/7',
      kind: 'pr',
    });
    expect(endpointOf(gh.calls[0]?.args ?? [])).toBe('repos/akholod/easy-cast/issues/7');
  });

  it('calls a payload without the pull_request key an issue', async () => {
    const { api } = apiWith(() => ok({ html_url: 'https://github.com/akholod/easy-cast/issues/7' }));
    expect(await api.getIssueOrPull('akholod', 'easy-cast', 7)).toMatchObject({ kind: 'issue' });
  });

  it('returns undefined on a 404 rather than throwing, so the caller can raise exit 3', async () => {
    const { api } = apiWith(() => httpError(404, 'Not Found'));
    expect(await api.getIssueOrPull('akholod', 'easy-cast', 999)).toBeUndefined();
  });
});

describe('listComments paginates', () => {
  const pageOf = (args: readonly string[]): number => {
    const match = /[?&]page=(\d+)/.exec(endpointOf(args));
    return match === null ? 1 : Number(match[1]);
  };

  /** Two full pages of other people's chatter, our marker on the third. */
  const threePages: Respond = (args) => {
    const page = pageOf(args);
    if (page < 3) {
      return ok(Array.from({ length: 100 }, (_, i) => comment(page * 1000 + i, 'looks good to me')));
    }
    return ok([comment(3001, 'one more thing'), comment(3002, `${MARKER}\n| shot | url |`)]);
  };

  const collect = async (iterable: AsyncIterable<OwnComment>): Promise<OwnComment[]> => {
    const seen: OwnComment[] = [];
    for await (const item of iterable) seen.push(item);
    return seen;
  };

  it('finds a marker that sits on the third page', async () => {
    const { gh, api } = apiWith(threePages);
    const all = await collect(api.listComments('akholod', 'easy-cast', 7));
    const own = all.filter((item) => item.body.includes(MARKER));

    expect(own).toHaveLength(1);
    expect(own[0]?.id).toBe(3002);
    expect(all).toHaveLength(202);
    expect(gh.calls).toHaveLength(3);
  });

  it('asks for the largest page gh will serve, one page at a time', async () => {
    const { gh, api } = apiWith(threePages);
    await collect(api.listComments('akholod', 'easy-cast', 7));
    expect(gh.calls.map((call) => endpointOf(call.args))).toEqual([
      'repos/akholod/easy-cast/issues/7/comments?per_page=100&page=1',
      'repos/akholod/easy-cast/issues/7/comments?per_page=100&page=2',
      'repos/akholod/easy-cast/issues/7/comments?per_page=100&page=3',
    ]);
  });

  it('maps a comment onto the fields the marker search needs', async () => {
    const { api } = apiWith(() => ok([comment(11, MARKER)]));
    const [only] = await collect(api.listComments('akholod', 'easy-cast', 7));
    expect(only).toEqual({
      id: 11,
      url: 'https://github.com/akholod/easy-cast/issues/7#issuecomment-11',
      body: MARKER,
      createdAt: '2026-01-01T00:00:00Z',
      authorLogin: 'akholod',
    });
  });

  it('stops at a short page instead of asking for one more', async () => {
    const { gh, api } = apiWith(() => ok([comment(1, 'hi'), comment(2, 'there')]));
    expect(await collect(api.listComments('akholod', 'easy-cast', 7))).toHaveLength(2);
    expect(gh.calls).toHaveLength(1);
  });

  it('terminates on an empty page rather than looping forever', async () => {
    const { gh, api } = apiWith(() => ok([]));
    expect(await collect(api.listComments('akholod', 'easy-cast', 7))).toEqual([]);
    expect(gh.calls).toHaveLength(1);
  });
});

describe('createComment and updateComment', () => {
  it('posts a new comment and reports where it landed', async () => {
    const { gh, api } = apiWith(() => ok(comment(55, 'body')));
    expect(await api.createComment('akholod', 'easy-cast', 7, 'hello')).toEqual({
      id: 55,
      url: 'https://github.com/akholod/easy-cast/issues/7#issuecomment-55',
    });
    expect(gh.calls[0]?.args).toEqual([
      'api',
      'repos/akholod/easy-cast/issues/7/comments',
      '--method',
      'POST',
      '--input',
      '-',
    ]);
    expect(gh.calls[0]?.options.stdin).toBe(JSON.stringify({ body: 'hello' }));
  });

  // argv is world-readable through /proc for as long as the child lives, a body
  // runs to tens of kilobytes, and one carrying a signed URL would be refused
  // outright by the argv guard in spawnScrubbed.
  it('sends the body over stdin, never in argv', async () => {
    const { gh, api } = apiWith(() => ok(comment(55, 'body')));
    const body = `![shot](https://github.com/user-attachments/assets/${'a'.repeat(36)})`;
    await api.createComment('akholod', 'easy-cast', 7, body);

    expect(gh.calls[0]?.args.join(' ')).not.toContain(body);
    expect(gh.calls[0]?.options.stdin).toContain(body);
  });

  it('patches an existing comment by its id', async () => {
    const { gh, api } = apiWith(() => ok(comment(55, 'body')));
    expect(await api.updateComment('akholod', 'easy-cast', 55, 'hello again')).toMatchObject({ id: 55 });
    expect(gh.calls[0]?.args).toEqual([
      'api',
      'repos/akholod/easy-cast/issues/comments/55',
      '--method',
      'PATCH',
      '--input',
      '-',
    ]);
    expect(gh.calls[0]?.options.stdin).toBe(JSON.stringify({ body: 'hello again' }));
  });
});

describe('gh runs under the identity that uploads (D13)', () => {
  const exerciseEverything = async (source: 'gh' | 'GH_TOKEN') => {
    const { gh, api } = apiWith((args) => {
      if (endpointOf(args) === 'user') return { stdout: 'akholod\n' };
      if (endpointOf(args).includes('/pulls?')) return ok([]);
      if (endpointOf(args).includes('/comments?')) return ok([]);
      if (endpointOf(args).includes('/issues/7/comments')) return ok(comment(1, 'x'));
      if (endpointOf(args).includes('/issues/comments/')) return ok(comment(1, 'x'));
      if (endpointOf(args).includes('/issues/')) return ok({ html_url: 'u' });
      return ok({ id: 1, visibility: 'private' });
    }, source);

    await api.getViewerLogin();
    await api.getRepo('akholod', 'easy-cast');
    await api.findPullForBranch('akholod', 'easy-cast', 'main');
    await api.getIssueOrPull('akholod', 'easy-cast', 7);
    for await (const _ of api.listComments('akholod', 'easy-cast', 7)) void _;
    await api.createComment('akholod', 'easy-cast', 7, 'hello');
    await api.updateComment('akholod', 'easy-cast', 55, 'hello');
    return gh.calls;
  };

  it.each(['gh' as const, 'GH_TOKEN' as const])(
    'passes every call the allowlist for source %s and nothing else',
    async (source) => {
      const calls = await exerciseEverything(source);
      expect(calls).toHaveLength(7);
      for (const call of calls) {
        expect(call.command).toBe('gh');
        expect(call.options.allowEnv).toEqual(ghAllowEnv(source));
        expect(call.options.allowEnv).not.toContain('GITHUB_TOKEN');
      }
    },
  );

  it('never puts a token in argv', async () => {
    const calls = await exerciseEverything('GH_TOKEN');
    for (const call of calls) {
      const argv = [call.command, ...call.args].join(' ');
      expect(argv).not.toContain(FAKE);
      // Anything the redactor would have masked had no business being in argv.
      expect(redact(argv)).toBe(argv);
    }
  });
});

describe('a failing gh', () => {
  it.each([
    [401, 'Bad credentials', 'no_access_or_not_found'],
    [403, 'Forbidden', 'no_access_or_not_found'],
    [404, 'Not Found', 'target_not_found'],
    [500, 'Internal Server Error', 'internal_error'],
  ])('turns HTTP %i into reason %s', async (status, message, reason) => {
    const { api } = apiWith(() => httpError(status as number, message as string));
    await expect(api.createComment('akholod', 'easy-cast', 7, 'hello')).rejects.toMatchObject({
      reason,
    });
  });

  it('names the endpoint that failed and keeps a token out of the message', async () => {
    const { api } = apiWith(() => ({
      exitCode: 1,
      stderr: `gh: Bad credentials (HTTP 401) calling https://api.github.com/user?token=${FAKE}\n`,
    }));
    const thrown = await api.getViewerLogin().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(EasyCastError);
    expect((thrown as EasyCastError).message).toContain('gh api user');
    expect((thrown as EasyCastError).message).not.toContain(FAKE);
  });

  it('reports an unknown outcome when gh never ran at all', async () => {
    const { api } = apiWith(() => ({ exitCode: 127, stderr: 'spawn gh ENOENT' }));
    await expect(api.getViewerLogin()).rejects.toMatchObject({ reason: 'internal_error' });
  });

  it('does not pass off non-JSON output as a payload', async () => {
    const { api } = apiWith(() => ({ stdout: '<html>502 Bad Gateway</html>' }));
    await expect(api.getRepo('akholod', 'easy-cast')).rejects.toMatchObject({
      reason: 'internal_error',
    });
  });
});

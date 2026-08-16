import { describe, expect, it } from 'vitest';
import { parseTarget } from '../src/target/parse.js';
import {
  inferRepo,
  parseRemoteUrl,
  resolveRepo,
  type GitReader,
  type GitRemote,
} from '../src/target/infer-repo.js';
import { EasyCastError } from '../src/errors.js';

const reader = (remotes: GitRemote[], topLevel: string | undefined = '/repo'): GitReader => ({
  topLevel: () => topLevel,
  remotes: () => remotes,
});

const remote = (name: string, ...pushUrls: string[]): GitRemote => ({ name, pushUrls });
const gh = (path: string) => `https://github.com/${path}.git`;

const expectFailure = (run: () => unknown, reason: string) => {
  try {
    run();
    expect.unreachable(`expected a failure with reason ${reason}`);
  } catch (error) {
    expect(error).toBeInstanceOf(EasyCastError);
    expect((error as EasyCastError).reason).toBe(reason);
    expect((error as EasyCastError).outcome.exitCode).toBe(2);
  }
};

describe('target parsing', () => {
  it('accepts the three valid forms', () => {
    expect(parseTarget('pr')).toEqual({ kind: 'pr-from-branch' });
    expect(parseTarget('pr:42')).toEqual({ kind: 'pr', number: 42 });
    expect(parseTarget('issue:7')).toEqual({ kind: 'issue', number: 7 });
  });

  // The ten forms the plan requires to be refused rather than coerced — this
  // addresses a target that is about to receive irreversible content.
  it.each([
    ['empty', ''],
    ['pr with no number', 'pr:'],
    ['zero', 'pr:0'],
    ['negative', 'pr:-1'],
    ['not a number', 'pr:abc'],
    ['fractional', 'pr:1.5'],
    ['wrong case', 'PR:1'],
    ['issue with no number', 'issue'],
    ['an unsupported addressing form', 'comment:5'],
    ['two targets at once', 'pr:1 issue:2'],
  ])('refuses %s', (_label, raw) => {
    expectFailure(() => parseTarget(raw), 'bad_args');
  });
});

describe('remote url parsing', () => {
  it.each([
    ['https', 'https://github.com/akholod/easy-cast.git'],
    ['https without .git', 'https://github.com/akholod/easy-cast'],
    ['ssh scp form', 'git@github.com:akholod/easy-cast.git'],
    ['ssh url form', 'ssh://git@github.com/akholod/easy-cast.git'],
    ['ssh url with port', 'ssh://git@github.com:22/akholod/easy-cast.git'],
    ['trailing slash', 'https://github.com/akholod/easy-cast/'],
  ])('reads owner and repo from the %s form', (_label, url) => {
    expect(parseRemoteUrl(url)).toMatchObject({ owner: 'akholod', repo: 'easy-cast' });
  });

  it('strips embedded credentials instead of carrying them along', () => {
    const parsed = parseRemoteUrl('https://someone:ghp_SECRETSECRETSECRET@github.com/akholod/easy-cast.git');
    expect(parsed).toMatchObject({ owner: 'akholod', repo: 'easy-cast', host: 'github.com' });
    expect(JSON.stringify(parsed)).not.toContain('ghp_');
    expect(JSON.stringify(parsed)).not.toContain('someone');
  });

  it('returns nothing for a url with no owner/repo pair', () => {
    expect(parseRemoteUrl('https://github.com/')).toBeUndefined();
    expect(parseRemoteUrl('')).toBeUndefined();
  });
});

describe('repository inference', () => {
  it('prefers origin, because that is what we push to and comment on', () => {
    const result = inferRepo('/repo', reader([remote('upstream', gh('other/thing')), remote('origin', gh('akholod/easy-cast'))]));
    expect(result).toMatchObject({ owner: 'akholod', repo: 'easy-cast', source: 'origin' });
  });

  it('takes the only GitHub remote when there is no origin', () => {
    const result = inferRepo('/repo', reader([remote('fork', gh('akholod/easy-cast'))]));
    expect(result).toMatchObject({ owner: 'akholod', repo: 'easy-cast', source: 'sole-remote' });
  });

  // The case an earlier revision left uncovered: origin exists but is not on
  // GitHub, while another remote is.
  it('skips a non-GitHub origin and uses the GitHub remote behind it', () => {
    const result = inferRepo(
      '/repo',
      reader([remote('origin', 'git@gitlab.com:someone/thing.git'), remote('gh', gh('akholod/easy-cast'))]),
    );
    expect(result).toMatchObject({ owner: 'akholod', repo: 'easy-cast', source: 'sole-remote' });
  });

  it('refuses to choose between several GitHub remotes with no origin', () => {
    expectFailure(
      () => inferRepo('/repo', reader([remote('a', gh('x/one')), remote('b', gh('y/two'))])),
      'repo_ambiguous',
    );
  });

  it('refuses when there is no work tree at all', () => {
    expectFailure(() => inferRepo('/repo', reader([], undefined)), 'repo_not_inferable');
  });

  it('refuses when no remote points at github.com', () => {
    expectFailure(
      () => inferRepo('/repo', reader([remote('origin', 'git@gitlab.com:someone/thing.git')])),
      'repo_not_inferable',
    );
  });

  // GitHub Enterprise is out of scope for the MVP, and guessing at it would be a
  // hypothesis dressed as a fact.
  it('does not infer from a GitHub Enterprise host', () => {
    expectFailure(
      () => inferRepo('/repo', reader([remote('origin', 'https://github.acme.corp/akholod/easy-cast.git')])),
      'repo_not_inferable',
    );
  });

  it('uses the first push url and flags the extras', () => {
    const result = inferRepo(
      '/repo',
      reader([remote('origin', gh('akholod/easy-cast'), gh('mirror/copy'))]),
    );
    expect(result.owner).toBe('akholod');
    expect(result.anomalies.map((a) => a.code)).toContain('multiple-push-urls');
  });

  it('resolves against the work tree root, so a subdirectory behaves the same', () => {
    const seen: string[] = [];
    const git: GitReader = {
      topLevel: () => '/repo',
      remotes: (cwd) => {
        seen.push(cwd);
        return [remote('origin', gh('akholod/easy-cast'))];
      },
    };
    inferRepo('/repo/src/deep/nested', git);
    expect(seen).toEqual(['/repo']);
  });
});

describe('--repo override', () => {
  it('wins without reading git at all', () => {
    const git: GitReader = {
      topLevel: () => {
        throw new Error('git must not be consulted when --repo is given');
      },
      remotes: () => {
        throw new Error('git must not be consulted when --repo is given');
      },
    };
    expect(resolveRepo('someone/thing', '/anywhere', git)).toEqual({
      owner: 'someone',
      repo: 'thing',
      source: 'flag',
      anomalies: [],
    });
  });

  it('rejects a malformed --repo rather than half-reading it', () => {
    expectFailure(() => resolveRepo('not-a-repo', '/x', reader([])), 'repo_not_inferable');
  });

  it('falls back to inference when the flag is absent', () => {
    expect(resolveRepo(undefined, '/repo', reader([remote('origin', gh('a/b'))])).source).toBe('origin');
  });
});

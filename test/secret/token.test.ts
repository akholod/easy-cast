import { describe, expect, it } from 'vitest';
import {
  assertSameIdentity,
  ghAllowEnv,
  resolveToken,
  type TokenDeps,
} from '../../src/secret/token.js';
import type { SpawnScrubbedOptions, SpawnScrubbedResult } from '../../src/secret/spawn.js';
import { EasyCastError } from '../../src/errors.js';

const FROM_ENV = 'ghp_FAKETOKENFAKETOKENFAKETOKENFAKE0123';
const FROM_GH = 'gho_FAKETOKENFAKETOKENFAKETOKENFAKE4567';

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnScrubbedOptions;
}

const stubGh = (result: Partial<SpawnScrubbedResult>) => {
  const calls: Call[] = [];
  const spawn: NonNullable<TokenDeps['spawn']> = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: '', stderr: '', exitCode: 0, ...result };
  };
  return { calls, spawn };
};

describe('resolveToken', () => {
  it('prefers GH_TOKEN and does not run gh at all', async () => {
    const gh = stubGh({ stdout: FROM_GH });
    const resolved = await resolveToken({ env: { GH_TOKEN: FROM_ENV }, spawn: gh.spawn });
    expect(resolved).toEqual({ token: FROM_ENV, source: 'GH_TOKEN' });
    expect(gh.calls).toHaveLength(0);
  });

  it('falls back to `gh auth token`, trimming the trailing newline', async () => {
    const gh = stubGh({ stdout: `${FROM_GH}\n` });
    const resolved = await resolveToken({ env: {}, spawn: gh.spawn });
    expect(resolved).toEqual({ token: FROM_GH, source: 'gh' });
    expect(gh.calls[0]?.command).toBe('gh');
    expect(gh.calls[0]?.args).toEqual(['auth', 'token']);
  });

  it('asks gh with nothing but its config, keyring and PATH', async () => {
    const gh = stubGh({ stdout: FROM_GH });
    await resolveToken({ env: {}, spawn: gh.spawn });
    expect(gh.calls[0]?.options.allowEnv).toEqual(['HOME', 'XDG_CONFIG_HOME', 'PATH']);
  });

  it('never reads GITHUB_TOKEN, even as a last resort', async () => {
    const gh = stubGh({ exitCode: 1, stderr: 'not logged in' });
    const deps = { env: { GITHUB_TOKEN: FROM_ENV }, spawn: gh.spawn };
    await expect(resolveToken(deps)).rejects.toThrow(EasyCastError);
  });

  it('does not let GITHUB_TOKEN override the token gh reports', async () => {
    const gh = stubGh({ stdout: FROM_GH });
    const resolved = await resolveToken({ env: { GITHUB_TOKEN: FROM_ENV }, spawn: gh.spawn });
    expect(resolved).toEqual({ token: FROM_GH, source: 'gh' });
  });

  it.each([
    ['gh exits non-zero', { exitCode: 1, stdout: '' }],
    ['gh prints nothing', { exitCode: 0, stdout: '' }],
    ['gh prints only whitespace', { exitCode: 0, stdout: ' \n' }],
  ])('reports that no token was found when %s', async (_label, result) => {
    const gh = stubGh(result);
    // Not `no_access_or_not_found`, which means GitHub refused a token we had.
    // Having none at all is an environment problem with a concrete fix, so the
    // caller must be sent to fix the environment rather than to ask the user.
    await expect(resolveToken({ env: {}, spawn: gh.spawn })).rejects.toMatchObject({
      reason: 'token_not_found',
    });
  });

  it('sends the caller to fix the environment rather than to ask a user', async () => {
    const gh = stubGh({ exitCode: 1, stdout: '' });
    await expect(resolveToken({ env: {}, spawn: gh.spawn })).rejects.toMatchObject({
      outcome: { exitCode: 2, nextAction: 'fix-environment' },
    });
  });

  it('treats an empty GH_TOKEN as unset', async () => {
    const gh = stubGh({ stdout: FROM_GH });
    const resolved = await resolveToken({ env: { GH_TOKEN: '  ' }, spawn: gh.spawn });
    expect(resolved.source).toBe('gh');
  });

  it('keeps the token out of the message when there is none to be found', async () => {
    const gh = stubGh({ exitCode: 1, stderr: FROM_GH });
    const error = await resolveToken({ env: {}, spawn: gh.spawn }).catch((thrown: Error) => thrown);
    expect((error as Error).message).not.toContain(FROM_GH);
  });
});

describe('ghAllowEnv (D13)', () => {
  it('forwards GH_TOKEN when GH_TOKEN is the upload token', () => {
    expect(ghAllowEnv('GH_TOKEN')).toEqual(['HOME', 'XDG_CONFIG_HOME', 'PATH', 'GH_TOKEN']);
  });

  it('does not forward GH_TOKEN when gh itself is the source', () => {
    expect(ghAllowEnv('gh')).toEqual(['HOME', 'XDG_CONFIG_HOME', 'PATH']);
  });

  it.each(['GH_TOKEN' as const, 'gh' as const])('never names GITHUB_TOKEN (source %s)', (source) => {
    expect(ghAllowEnv(source)).not.toContain('GITHUB_TOKEN');
  });
});

describe('assertSameIdentity (D13)', () => {
  it('accepts the same login regardless of case', () => {
    expect(() => assertSameIdentity('Akholod', 'akholod', 'gh')).not.toThrow();
  });

  it('refuses the run with exit 2 identity_mismatch when the logins differ', () => {
    try {
      assertSameIdentity('akholod', 'someone-else', 'GH_TOKEN');
      expect.unreachable('a login mismatch must refuse the run');
    } catch (thrown) {
      const error = thrown as EasyCastError;
      expect(error.reason).toBe('identity_mismatch');
      expect(error.outcome.exitCode).toBe(2);
      expect(error.outcome.nextAction).toBe('fix-environment');
      expect(error.message).toContain('someone-else');
    }
  });

  it.each([
    ['the upload login', '', 'akholod'],
    ['the gh login', 'akholod', ''],
  ])('refuses rather than assume sameness when %s is unknown', (_label, upload, comment) => {
    expect(() => assertSameIdentity(upload, comment, 'gh')).toThrow(EasyCastError);
  });
});

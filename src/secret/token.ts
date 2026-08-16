import { identityMismatch, tokenNotFound } from '../errors.js';
import { spawnScrubbed } from './spawn.js';

/** Where the upload token came from. Both are the same identity by construction. */
export type TokenSource = 'GH_TOKEN' | 'gh';

export interface ResolvedToken {
  readonly token: string;
  readonly source: TokenSource;
}

/** `gh` needs its config, its keyring and a way to find its helpers. Nothing else. */
const GH_BASE_ALLOW_ENV = ['HOME', 'XDG_CONFIG_HOME', 'PATH'] as const;

export interface TokenDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn?: typeof spawnScrubbed;
}

/**
 * `GITHUB_TOKEN` is deliberately never read. It normally arrives from Actions,
 * CI is out of scope, and the upload endpoint's behaviour under an installation
 * token was never observed — silently picking up an unverified token is worse
 * than reporting that no token was found.
 */
export async function resolveToken({
  env = process.env,
  spawn = spawnScrubbed,
}: TokenDeps = {}): Promise<ResolvedToken> {
  const fromEnv = env.GH_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'GH_TOKEN' };

  const result = await spawn('gh', ['auth', 'token'], { allowEnv: [...GH_BASE_ALLOW_ENV] });
  const fromGh = result.exitCode === 0 ? result.stdout.trim() : '';
  if (fromGh) return { token: fromGh, source: 'gh' };

  // Not `no_access_or_not_found`: that means GitHub turned down a token we had.
  // Having none at all is an environment problem with a concrete fix, so it must
  // not send an agent off to ask the user or to retry.
  throw tokenNotFound(
    'No upload token. Set GH_TOKEN or run `gh auth login`; GITHUB_TOKEN is deliberately not read.',
  );
}

/**
 * Whatever authenticates the uploads has to authenticate `gh` too (D13): without
 * `GH_TOKEN` forwarded, `gh` falls back to its keyring account, and the search
 * for "our own" comment would quietly run under a different login.
 */
export function ghAllowEnv(source: TokenSource): string[] {
  return source === 'GH_TOKEN' ? [...GH_BASE_ALLOW_ENV, 'GH_TOKEN'] : [...GH_BASE_ALLOW_ENV];
}

/**
 * Refuses the run rather than uploading under one identity and commenting under
 * another — the attachment would be permanent and attributed to an account the
 * caller never named. An unknown login on either side counts as a mismatch:
 * sameness has to be proven, not assumed.
 */
export function assertSameIdentity(
  uploadLogin: string,
  commentLogin: string,
  source: TokenSource,
): void {
  const upload = uploadLogin.trim().toLowerCase();
  const comment = commentLogin.trim().toLowerCase();
  if (upload && comment && upload === comment) return;
  throw identityMismatch(
    `The upload token (${source}) acts as "${uploadLogin.trim() || 'unknown'}" but gh acts as ` +
      `"${commentLogin.trim() || 'unknown'}". Uploads and comments must be the same account.`,
  );
}

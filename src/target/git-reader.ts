import { spawnScrubbed } from '../secret/spawn.js';
import type { GitReader, GitRemote } from './infer-repo.js';

/**
 * Reads the local repository through `git` itself rather than by parsing
 * `.git/config`.
 *
 * That is deliberate: `url.<base>.insteadOf` and `pushInsteadOf` rewrites live in
 * config the tool would have to reimplement, and getting them wrong would resolve
 * to a different repository than the one the user actually pushes to — an
 * irreversible upload into the wrong place.
 */

/** `git` needs its config and the PATH; nothing else, and never a token. */
const GIT_ALLOW_ENV = ['HOME', 'XDG_CONFIG_HOME', 'PATH'] as const;

export interface GitReaderDeps {
  readonly spawn: typeof spawnScrubbed;
}

export async function readGit(cwd: string, deps: GitReaderDeps = { spawn: spawnScrubbed }): Promise<GitReader> {
  const git = async (args: string[]): Promise<{ ok: boolean; stdout: string }> => {
    const result = await deps.spawn('git', ['-C', cwd, ...args], { allowEnv: [...GIT_ALLOW_ENV] });
    return { ok: result.exitCode === 0, stdout: result.stdout.trim() };
  };

  // `--show-toplevel` fails in a bare repository, which is the answer we want:
  // there is no work tree, so there is nothing to infer a repository from.
  const topLevelResult = await git(['rev-parse', '--show-toplevel']);
  const topLevel = topLevelResult.ok && topLevelResult.stdout !== '' ? topLevelResult.stdout : undefined;

  const remotes: GitRemote[] = [];
  if (topLevel !== undefined) {
    const listed = await git(['remote']);
    for (const name of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      // Push URLs specifically: we comment on what we push to. `get-url` applies
      // the insteadOf rewrites for us.
      const urls = await git(['remote', 'get-url', '--push', '--all', name]);
      if (!urls.ok) continue;
      remotes.push({
        name,
        pushUrls: urls.stdout.split('\n').map((line) => line.trim()).filter(Boolean),
      });
    }
  }

  return {
    topLevel: () => topLevel,
    remotes: () => remotes,
  };
}

/** Current branch, or `undefined` on a detached HEAD. */
export async function currentBranch(
  cwd: string,
  deps: GitReaderDeps = { spawn: spawnScrubbed },
): Promise<string | undefined> {
  const result = await deps.spawn('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowEnv: [...GIT_ALLOW_ENV],
  });
  const branch = result.stdout.trim();
  return result.exitCode === 0 && branch !== '' ? branch : undefined;
}

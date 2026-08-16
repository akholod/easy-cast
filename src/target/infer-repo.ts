import { anomaly, type Anomaly } from '../anomalies.js';
import { repoAmbiguous, repoNotInferable } from '../errors.js';

/**
 * Where the repository comes from when `--repo` is absent.
 *
 * The user chose inference over an explicit flag, which makes the working
 * directory part of what the command means: run it from the wrong checkout and
 * the upload lands — irreversibly — in the wrong repository. Nothing here can
 * prevent that. What it can do is refuse to guess: every ambiguous case is an
 * error rather than a plausible-looking pick, and the resolved repository is
 * reported back so the mistake is visible in the same run.
 */

export type RepoSource = 'flag' | 'origin' | 'sole-remote';

export interface InferredRepo {
  readonly owner: string;
  readonly repo: string;
  readonly source: RepoSource;
  readonly anomalies: Anomaly[];
}

export interface GitRemote {
  readonly name: string;
  /** Push URLs specifically: we comment on what we push to, not what we fetch from. */
  readonly pushUrls: readonly string[];
}

export interface GitReader {
  /** `undefined` when this is not a work tree — a bare repository has nothing to infer from. */
  topLevel(cwd: string): string | undefined;
  /** Already has `insteadOf` / `pushInsteadOf` rewrites applied, as `git remote get-url` does. */
  remotes(cwd: string): readonly GitRemote[];
}

const ACCEPTED_HOSTS = new Set(['github.com', 'www.github.com']);

/**
 * A remote URL may carry credentials (`https://user:token@host/...`). Those are
 * secrets, so they are stripped here before the value is used, logged, or shown.
 */
export function parseRemoteUrl(url: string): { owner: string; repo: string; host: string } | undefined {
  const trimmed = url.trim();
  if (trimmed === '') return undefined;

  // scp-like form: [user@]host:owner/repo
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(trimmed);
  let host: string;
  let path: string;

  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    [, host, path] = scp;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  }

  const segments = path.replace(/^\/+/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (segments.length < 2) return undefined;

  const [owner, repo] = segments.slice(-2);
  return { owner, repo, host: host.toLowerCase() };
}

export function inferRepo(cwd: string, git: GitReader): InferredRepo {
  const anomalies: Anomaly[] = [];

  const topLevel = git.topLevel(cwd);
  if (topLevel === undefined) {
    throw repoNotInferable(
      'not inside a git work tree, so there is no remote to infer the repository from. Pass --repo owner/name.',
    );
  }

  const candidates: { name: string; owner: string; repo: string }[] = [];
  for (const remote of git.remotes(topLevel)) {
    if (remote.pushUrls.length > 1) {
      anomalies.push(
        anomaly('multiple-push-urls', `remote ${remote.name} has ${remote.pushUrls.length} push URLs; using the first`),
      );
    }
    const first = remote.pushUrls[0];
    if (first === undefined) continue;

    const parsed = parseRemoteUrl(first);
    // Filtering by host here is what makes the table below total: a non-GitHub
    // `origin` simply drops out, and a GitHub remote further down still wins.
    if (!parsed || !ACCEPTED_HOSTS.has(parsed.host)) continue;
    candidates.push({ name: remote.name, owner: parsed.owner, repo: parsed.repo });
  }

  const origin = candidates.find((candidate) => candidate.name === 'origin');
  if (origin) return { owner: origin.owner, repo: origin.repo, source: 'origin', anomalies };

  if (candidates.length === 1) {
    const [only] = candidates;
    return { owner: only.owner, repo: only.repo, source: 'sole-remote', anomalies };
  }

  if (candidates.length > 1) {
    throw repoAmbiguous(
      `several GitHub remotes and no origin: ${candidates
        .map((c) => `${c.name} -> ${c.owner}/${c.repo}`)
        .join(', ')}. Pass --repo owner/name.`,
      { candidates: candidates.map((c) => `${c.owner}/${c.repo}`) },
    );
  }

  throw repoNotInferable(
    'no github.com remote found (GitHub Enterprise hosts are out of scope). Pass --repo owner/name.',
  );
}

/** `--repo` always wins, and short-circuits before git is read at all. */
export function resolveRepo(repoFlag: string | undefined, cwd: string, git: GitReader): InferredRepo {
  if (repoFlag === undefined) return inferRepo(cwd, git);

  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repoFlag.trim());
  if (!match) throw repoNotInferable(`--repo must look like owner/name; got ${JSON.stringify(repoFlag)}`);
  return { owner: match[1], repo: match[2], source: 'flag', anomalies: [] };
}

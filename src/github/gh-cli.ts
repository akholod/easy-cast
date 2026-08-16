import { EasyCastError } from '../errors.js';
import type { Reason } from '../exit-codes.js';
import { redact } from '../secret/redact.js';
import type { spawnScrubbed, SpawnScrubbedResult } from '../secret/spawn.js';
import type { CommentRef, GitHubApi, OwnComment, RepoInfo, RepoVisibility } from './api.js';

/**
 * {@link GitHubApi} over the `gh` CLI (D7).
 *
 * `gh` is the only GitHub client here because it already holds the account the
 * user logged in with, and it is reached through `spawnScrubbed` alone, so the
 * environment it sees is the allowlist it was constructed with and nothing else.
 * Both are injected rather than imported so the whole pipeline can be exercised
 * without a network and without a real `gh` on PATH.
 */

export interface GhApiDeps {
  readonly spawn: typeof spawnScrubbed;
  /** From `ghAllowEnv(source)`: forwarding `GH_TOKEN` is what keeps `gh` on the identity that uploads (D13). */
  readonly allowEnv: readonly string[];
}

/** GitHub's maximum, which is what makes a short page mean "this was the last one". */
const PER_PAGE = 100;

interface RepoPayload {
  readonly id: number;
  readonly visibility: unknown;
}

interface PullPayload {
  readonly number: number;
}

interface IssuePayload {
  readonly html_url: string;
  /** Present only on pull requests: `/issues/{n}` serves both kinds. */
  readonly pull_request?: unknown;
}

interface CommentPayload {
  readonly id: number;
  readonly html_url: string;
  readonly body: string | null;
  readonly created_at: string;
  readonly user: { readonly login: string } | null;
}

/** Repository names come from the caller and branch names contain `/`. */
const seg = (value: string): string => encodeURIComponent(value);

/** `gh` echoes the status it got — `gh: Not Found (HTTP 404)` — on stderr. */
const httpStatus = (stderr: string): number | undefined => {
  const match = /\(HTTP (\d{3})\)/.exec(stderr);
  return match === null ? undefined : Number(match[1]);
};

const isNotFound = (result: SpawnScrubbedResult): boolean =>
  result.exitCode !== 0 && httpStatus(result.stderr) === 404;

function ghFailure(endpoint: string, result: SpawnScrubbedResult): EasyCastError {
  const status = httpStatus(result.stderr);
  // 404 and 401/403 are the failures whose cause is knowable from the outside.
  // Anything else — a 5xx, a killed child, no `gh` on PATH — leaves the remote
  // state unknown, and reporting that is more use to an agent than a guess.
  const reason: Reason =
    status === 404
      ? 'target_not_found'
      : status === 401 || status === 403
        ? 'no_access_or_not_found'
        : 'internal_error';

  // `gh` can echo the URL it called, and a URL can carry a token.
  const detail = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? '';
  return new EasyCastError(
    reason,
    redact(`gh api ${endpoint} failed (exit ${result.exitCode}): ${detail}`),
  );
}

function parseJson<T>(endpoint: string, stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    // Enough of the response to recognise it, not enough to paste a page of
    // HTML into an outcome an agent has to read.
    throw new EasyCastError(
      'internal_error',
      redact(`gh api ${endpoint} did not return JSON: ${stdout.trim().slice(0, 200)}`),
    );
  }
}

const VISIBILITIES: ReadonlySet<string> = new Set<RepoVisibility>(['public', 'private', 'internal']);

function asVisibility(value: unknown): RepoVisibility {
  if (typeof value === 'string' && VISIBILITIES.has(value)) return value as RepoVisibility;
  // Visibility decides the `--allow-public` gate, and a wrong guess in the
  // permissive direction is an irreversible upload the world can read.
  throw new EasyCastError(
    'internal_error',
    redact(`gh reported an unknown repository visibility: ${JSON.stringify(value)}`),
  );
}

const toOwnComment = (payload: CommentPayload): OwnComment => ({
  id: payload.id,
  url: payload.html_url,
  body: payload.body ?? '',
  createdAt: payload.created_at,
  // A comment whose author is gone has no login. Leaving it empty keeps it from
  // ever matching ours instead of inventing an owner for it.
  authorLogin: payload.user?.login ?? '',
});

export function createGhApi({ spawn, allowEnv }: GhApiDeps): GitHubApi {
  const options = { allowEnv: [...allowEnv] };

  const invoke = (
    endpoint: string,
    extra: readonly string[] = [],
    stdin?: string,
  ): Promise<SpawnScrubbedResult> =>
    spawn('gh', ['api', endpoint, ...extra], stdin === undefined ? options : { ...options, stdin });

  const stdoutOf = (endpoint: string, result: SpawnScrubbedResult): string => {
    if (result.exitCode !== 0) throw ghFailure(endpoint, result);
    return result.stdout;
  };

  const json = async <T>(
    endpoint: string,
    extra: readonly string[] = [],
    stdin?: string,
  ): Promise<T> => parseJson<T>(endpoint, stdoutOf(endpoint, await invoke(endpoint, extra, stdin)));

  /**
   * Comment bodies go in over stdin rather than argv. They run to tens of
   * kilobytes, argv is world-readable through `/proc`, and a body carrying a
   * signed URL would be refused outright by the argv guard in `spawnScrubbed`.
   */
  const writeComment = async (endpoint: string, method: 'POST' | 'PATCH', body: string) =>
    json<CommentPayload>(endpoint, ['--method', method, '--input', '-'], JSON.stringify({ body }));

  const getViewerLogin = async (): Promise<string> =>
    stdoutOf('user', await invoke('user', ['--jq', '.login'])).trim();

  const getRepo = async (owner: string, repo: string): Promise<RepoInfo | undefined> => {
    const endpoint = `repos/${seg(owner)}/${seg(repo)}`;
    const result = await invoke(endpoint);
    // A repository the token cannot see answers 404 exactly like one that does
    // not exist, which is why the caller can only report the two disjunctively.
    if (isNotFound(result)) return undefined;
    const payload = parseJson<RepoPayload>(endpoint, stdoutOf(endpoint, result));
    return { id: payload.id, visibility: asVisibility(payload.visibility) };
  };

  const findPullForBranch = async (
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{ number: number } | undefined> => {
    const endpoint =
      `repos/${seg(owner)}/${seg(repo)}/pulls?state=open&head=${seg(owner)}:${seg(branch)}`;
    const [first] = await json<PullPayload[]>(endpoint);
    return first === undefined ? undefined : { number: first.number };
  };

  const getIssueOrPull = async (
    owner: string,
    repo: string,
    number: number,
  ): Promise<{ htmlUrl: string; kind: 'pr' | 'issue' } | undefined> => {
    const endpoint = `repos/${seg(owner)}/${seg(repo)}/issues/${number}`;
    const result = await invoke(endpoint);
    if (isNotFound(result)) return undefined;
    const payload = parseJson<IssuePayload>(endpoint, stdoutOf(endpoint, result));
    // `/issues/{n}` serves pull requests too; the extra key is what tells them apart.
    return { htmlUrl: payload.html_url, kind: payload.pull_request ? 'pr' : 'issue' };
  };

  async function* listComments(
    owner: string,
    repo: string,
    number: number,
  ): AsyncIterable<OwnComment> {
    const base = `repos/${seg(owner)}/${seg(repo)}/issues/${number}/comments?per_page=${PER_PAGE}`;
    for (let page = 1; ; page += 1) {
      const endpoint = `${base}&page=${page}`;
      const payloads = await json<CommentPayload[]>(endpoint);
      for (const payload of payloads) yield toOwnComment(payload);
      // The only safe place to stop is the page that came back short — an empty
      // one included. Stopping at page one would miss our own marker on an
      // active pull request and post a duplicate comment on every run.
      if (payloads.length < PER_PAGE) return;
    }
  }

  const createComment = async (
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<CommentRef> => {
    const endpoint = `repos/${seg(owner)}/${seg(repo)}/issues/${number}/comments`;
    const payload = await writeComment(endpoint, 'POST', body);
    return { id: payload.id, url: payload.html_url };
  };

  const updateComment = async (
    owner: string,
    repo: string,
    commentId: number,
    body: string,
  ): Promise<CommentRef> => {
    const endpoint = `repos/${seg(owner)}/${seg(repo)}/issues/comments/${commentId}`;
    const payload = await writeComment(endpoint, 'PATCH', body);
    return { id: payload.id, url: payload.html_url };
  };

  return {
    getViewerLogin,
    getRepo,
    findPullForBranch,
    getIssueOrPull,
    listComments,
    createComment,
    updateComment,
  };
}

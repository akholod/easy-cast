import { anomaly, type Anomaly } from '../anomalies.js';
import type { CommentRef, GitHubApi, OwnComment } from '../github/api.js';
import { hasOurMarker } from './marker.js';

export interface OwnCommentSearch {
  readonly chosen?: OwnComment;
  readonly duplicates: readonly OwnComment[];
  readonly anomalies: readonly Anomaly[];
}

/**
 * Finds the tool's own comment on a target.
 *
 * Restricted to the authenticated user's own comments: rewriting somebody else's
 * comment because it happened to carry a matching marker would be the worst thing
 * this tool could do to a pull request.
 */
export async function findOwnComment(
  api: GitHubApi,
  owner: string,
  repo: string,
  number: number,
  key: string,
  login: string,
): Promise<OwnCommentSearch> {
  const mine: OwnComment[] = [];
  for await (const comment of api.listComments(owner, repo, number)) {
    if (comment.authorLogin.toLowerCase() !== login.toLowerCase()) continue;
    if (!hasOurMarker(comment.body, key)) continue;
    mine.push(comment);
  }

  // Oldest wins. Two comments with one marker means a previous run raced with
  // itself; picking the oldest keeps the choice stable across later runs, whereas
  // "newest" would hop between them.
  mine.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);

  const [chosen, ...duplicates] = mine;
  const anomalies: Anomaly[] = [];
  if (duplicates.length > 0) {
    anomalies.push(
      anomaly(
        'duplicate-markers',
        `${mine.length} comments carry marker ${key}; using #${chosen.id} and leaving ` +
          `${duplicates.map((c) => `#${c.id}`).join(', ')} untouched`,
      ),
    );
  }

  return { chosen, duplicates, anomalies };
}

export interface UpsertResult {
  readonly id: number;
  readonly url: string;
  readonly created: boolean;
}

/**
 * Re-reads the target immediately before writing. This narrows the window in
 * which two concurrent runs both conclude "no comment of mine here" — it does not
 * close it, and the documentation says so rather than implying a lock exists.
 */
export async function upsertComment(
  api: GitHubApi,
  owner: string,
  repo: string,
  number: number,
  key: string,
  login: string,
  body: string,
): Promise<{ result: UpsertResult; anomalies: readonly Anomaly[] }> {
  const search = await findOwnComment(api, owner, repo, number, key, login);

  let ref: CommentRef;
  let created: boolean;
  if (search.chosen) {
    ref = await api.updateComment(owner, repo, search.chosen.id, body);
    created = false;
  } else {
    ref = await api.createComment(owner, repo, number, body);
    created = true;
  }

  return {
    result: { id: ref.id, url: ref.url, created },
    anomalies: search.anomalies,
  };
}

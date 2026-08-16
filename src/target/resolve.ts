import { targetNotFound } from '../errors.js';
import type { GitHubApi, RepoVisibility } from '../github/api.js';
import type { GitReader, RepoSource } from './infer-repo.js';
import { resolveRepo } from './infer-repo.js';
import type { TargetSpec } from './parse.js';
import type { Anomaly } from '../anomalies.js';

export interface ResolvedTarget {
  readonly owner: string;
  readonly repo: string;
  readonly kind: 'pr' | 'issue';
  readonly number: number;
  readonly visibility: RepoVisibility;
  readonly htmlUrl: string;
  readonly repoSource: RepoSource;
  readonly anomalies: readonly Anomaly[];
}

export interface ResolveDeps {
  readonly api: GitHubApi;
  readonly git: GitReader;
  readonly cwd: string;
  readonly currentBranch: () => Promise<string | undefined>;
}

/**
 * Resolves what we are about to post against — and reports visibility without
 * acting on it. The `--allow-public` gate is a pipeline decision: this module
 * only supplies the fact.
 */
export async function resolveTarget(
  spec: TargetSpec,
  repoFlag: string | undefined,
  deps: ResolveDeps,
): Promise<ResolvedTarget> {
  const inferred = resolveRepo(repoFlag, deps.cwd, deps.git);
  const { owner, repo } = inferred;

  const repoInfo = await deps.api.getRepo(owner, repo);
  if (!repoInfo) {
    // Deliberately disjunctive: a 404 here cannot distinguish a repository that
    // does not exist from one this token cannot see, and claiming either would be
    // a guess dressed as a diagnosis.
    throw targetNotFound(
      `${owner}/${repo} is not visible to this token — it either does not exist or the token has no access to it.`,
      { owner, repo, repoSource: inferred.source },
    );
  }

  let kind: 'pr' | 'issue';
  let number: number;

  if (spec.kind === 'pr-from-branch') {
    const branch = await deps.currentBranch();
    if (branch === undefined) {
      throw targetNotFound('HEAD is detached, so there is no branch to find a pull request for.', {
        owner,
        repo,
      });
    }
    const pull = await deps.api.findPullForBranch(owner, repo, branch);
    if (!pull) {
      // Exit 3 and nothing else: the tool never opens a pull request on its own,
      // and never quietly retargets to a neighbouring number.
      throw targetNotFound(`No open pull request for branch ${branch} in ${owner}/${repo}.`, {
        owner,
        repo,
        branch,
      });
    }
    kind = 'pr';
    number = pull.number;
  } else {
    kind = spec.kind;
    number = spec.number;
  }

  const found = await deps.api.getIssueOrPull(owner, repo, number);
  if (!found) {
    throw targetNotFound(`${owner}/${repo}#${number} does not exist or is not visible to this token.`, {
      owner,
      repo,
      number,
    });
  }

  // Asking for a pull request and being handed an issue is not a near miss to be
  // smoothed over — the attachment would land somewhere the caller did not name,
  // and it could not be taken back.
  if (spec.kind !== 'pr-from-branch' && found.kind !== spec.kind) {
    throw targetNotFound(
      `${owner}/${repo}#${number} is ${found.kind === 'pr' ? 'a pull request' : 'an issue'}, ` +
        `but --to asked for ${spec.kind === 'pr' ? 'a pull request' : 'an issue'}.`,
      { owner, repo, number },
    );
  }

  return {
    owner,
    repo,
    kind: found.kind,
    number,
    visibility: repoInfo.visibility,
    htmlUrl: found.htmlUrl,
    repoSource: inferred.source,
    anomalies: inferred.anomalies,
  };
}

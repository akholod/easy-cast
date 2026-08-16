/**
 * Everything this tool needs from GitHub, behind one interface so the whole
 * pipeline can be exercised without a network — and so every call goes through
 * the single scrubbed-spawn choke point rather than scattering `gh` invocations.
 */

export type RepoVisibility = 'public' | 'private' | 'internal';

export interface RepoInfo {
  /** Ordinary metadata here; only `src/upload/` may treat it as a wire parameter (P5). */
  readonly id: number;
  readonly visibility: RepoVisibility;
}

export interface CommentRef {
  readonly id: number;
  readonly url: string;
}

export interface OwnComment {
  readonly id: number;
  readonly url: string;
  readonly body: string;
  readonly createdAt: string;
  readonly authorLogin: string;
}

export interface GitHubApi {
  getViewerLogin(): Promise<string>;
  getRepo(owner: string, repo: string): Promise<RepoInfo | undefined>;
  findPullForBranch(owner: string, repo: string, branch: string): Promise<{ number: number } | undefined>;
  getIssueOrPull(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{ htmlUrl: string; kind: 'pr' | 'issue' } | undefined>;
  /**
   * Async iterable because it must paginate: on an active pull request the
   * tool's own marker can sit on the third page, and stopping at page one would
   * silently post a duplicate comment every run.
   */
  listComments(owner: string, repo: string, number: number): AsyncIterable<OwnComment>;
  createComment(owner: string, repo: string, number: number, body: string): Promise<CommentRef>;
  updateComment(owner: string, repo: string, commentId: number, body: string): Promise<CommentRef>;
}

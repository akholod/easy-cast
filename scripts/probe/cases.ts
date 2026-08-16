/**
 * The stage-0 observation matrix, as data.
 *
 * Every interpretation of this endpoint's behaviour is currently a hypothesis.
 * These cases are what turns them into recorded observations — or into an honest
 * `not-testable` with a reason, which is just as much of a result.
 *
 * A successful probe leaves an attachment that **cannot be deleted**. The order
 * below is therefore not cosmetic: the cheapest and least destructive cases run
 * first, and everything touching the public repository runs last and once.
 */

export type ProbeGroup =
  | 'request-shape'
  | 'failures'
  | 'types-and-sizes'
  | 'tokens'
  | 'publication-targets'
  | 'ledger-only'
  | 'url-second-target'
  | 'public-block';

export interface ProbeCase {
  readonly id: string;
  readonly group: ProbeGroup;
  /** What this case settles. Written as the question, so a null result is still an answer. */
  readonly question: string;
  /** True when a successful run leaves an attachment that can never be removed. */
  readonly createsPermanentAsset: boolean;
  readonly requiresPublicRepo: boolean;
  /** Which decision or module consumes the answer. */
  readonly informs: string;
}

/** Groups run in this order. The public block is deliberately last. */
export const GROUP_ORDER: readonly ProbeGroup[] = [
  'request-shape',
  'failures',
  'types-and-sizes',
  'tokens',
  'publication-targets',
  'ledger-only',
  'url-second-target',
  'public-block',
];

export const PROBE_CASES: readonly ProbeCase[] = [
  {
    id: 'shape.multipart-vs-raw',
    group: 'request-shape',
    question: 'Does the endpoint take a multipart form or a raw body?',
    createsPermanentAsset: true,
    requiresPublicRepo: false,
    informs: 'src/upload/wire.ts',
  },
  {
    id: 'shape.required-fields',
    group: 'request-shape',
    question: 'Which of name, size, content_type, repository_id are actually required?',
    createsPermanentAsset: true,
    requiresPublicRepo: false,
    informs: 'src/upload/wire.ts — and whether repositoryId is a real parameter at all',
  },
  {
    id: 'shape.two-phase',
    group: 'request-shape',
    question: 'Is this one request, or a policy call followed by a POST to another host?',
    createsPermanentAsset: true,
    requiresPublicRepo: false,
    informs: 'wire.ts calls transport.send once or twice; transport.ts must not change either way',
  },
  {
    id: 'failure.foreign-public-repo',
    group: 'failures',
    question:
      'What comes back for a public repository we have read but not push access to (e.g. cli/cli), using a working gho_ token?',
    // A 404 creates nothing, which is exactly why this case is free — and it is
    // the only configuration of "read but not push" available without fine-grained PATs.
    createsPermanentAsset: false,
    requiresPublicRepo: false,
    informs: 'the no_access_or_not_found row; the empirical basis for pre-mortem 1',
  },
  {
    id: 'failure.bad-repository-id',
    group: 'failures',
    question: 'Is a wrong repository_id distinguishable from missing push access, or is it the same 404?',
    createsPermanentAsset: false,
    requiresPublicRepo: false,
    informs: 'whether the diagnostic may name one cause or must stay disjunctive',
  },
  {
    id: 'failure.response-mid-body',
    group: 'failures',
    question: 'Does the server ever answer while the body is still being sent?',
    createsPermanentAsset: false,
    requiresPublicRepo: false,
    informs: 'transport.ts phase rule — response beats a write error',
  },
  {
    id: 'failure.connection-drop-after-body',
    group: 'failures',
    question: 'After the body is sent and the connection drops, was the file accepted?',
    createsPermanentAsset: true,
    requiresPublicRepo: false,
    informs: 'whether endpoint_unavailable may ever be retried — the working answer is no',
  },
  {
    id: 'types.accepted-extensions',
    group: 'types-and-sizes',
    question: 'Which of .png .jpg .gif .svg .webp .mp4 .mov .webm does the endpoint accept?',
    createsPermanentAsset: true,
    requiresPublicRepo: false,
    informs: 'src/media/mime-table.ts regeneration (WP-3b)',
  },
  {
    id: 'types.extension-content-type-mismatch',
    group: 'types-and-sizes',
    question:
      'Can the two 422 messages (disallowed content_type, and extension not matching content_type) be reproduced separately?',
    createsPermanentAsset: false,
    requiresPublicRepo: false,
    informs: 'whether a body can carry two contradictory signals, and the disjunctive message rule',
  },
  {
    id: 'types.oversize',
    group: 'types-and-sizes',
    question: 'What code and body come back over the size limit, and at what stage — before or after the body is sent?',
    createsPermanentAsset: false,
    requiresPublicRepo: false,
    informs: 'whether too-large is a classifier row or a transport event',
  },
  {
    id: 'types.url-length',
    group: 'types-and-sizes',
    question: 'How long is a returned attachment URL in practice?',
    createsPermanentAsset: true,
    requiresPublicRepo: false,
    informs: 'the URL reserve in estimateBodyBytes stays an upper bound',
  },
  {
    id: 'tokens.gho',
    group: 'tokens',
    question: 'Does the gh_auth (gho_) token work? This is the supported path.',
    createsPermanentAsset: true,
    requiresPublicRepo: false,
    informs: 'the documented authorisation matrix',
  },
  {
    id: 'tokens.classic-pat-without-repo',
    group: 'tokens',
    question: 'What happens with a classic PAT that lacks the repo scope?',
    createsPermanentAsset: false,
    requiresPublicRepo: false,
    informs: 'the authorisation matrix; fine-grained PAT scoping is deferred past MVP',
  },
  {
    id: 'targets.issue-comment',
    group: 'publication-targets',
    question: 'Does a URL quoted in an issue comment activate and render?',
    createsPermanentAsset: true,
    requiresPublicRepo: false,
    informs: 'the only two targets the MVP ever writes',
  },
  {
    id: 'targets.pr-comment',
    group: 'publication-targets',
    question: 'Does a URL quoted in a pull request comment activate and render?',
    createsPermanentAsset: true,
    requiresPublicRepo: false,
    informs: 'the only two targets the MVP ever writes',
  },
  {
    id: 'ledger.hidden-block-update',
    group: 'ledger-only',
    question:
      'When only the hidden ledger block changes, does the rendered comment change, and does it raise an edited event?',
    createsPermanentAsset: false,
    requiresPublicRepo: false,
    informs: 'P4 — whether "visible content unchanged" is true of the ledger-only path',
  },
  {
    id: 'reuse.url-in-second-target',
    group: 'url-second-target',
    question: 'Does the same URL activate when quoted in a second issue of the same repository?',
    createsPermanentAsset: false,
    requiresPublicRepo: false,
    // Forward-looking only: cross-target reuse is forbidden unconditionally in the
    // MVP, so this cannot change current behaviour — only a future relaxation.
    informs: 'whether the dedup scope in D11 could ever be safely widened',
  },
  {
    id: 'public.visibility',
    group: 'public-block',
    question:
      'On a public repository, what host serves the rendered asset and is it reachable anonymously?',
    createsPermanentAsset: true,
    requiresPublicRepo: true,
    informs: 'the visibility story the skill tells the user',
  },
  {
    id: 'public.asset-nature',
    group: 'public-block',
    question:
      'Is an asset uploaded against a PRIVATE repository reachable anonymously once its URL is quoted in a PUBLIC issue?',
    createsPermanentAsset: true,
    requiresPublicRepo: true,
    // If the asset turns out to be account-scoped rather than repository-scoped,
    // the whole --allow-public gate blocks the safe case and lets the dangerous
    // one through.
    informs: 'DG4 — decides whether the --allow-public gate is meaningful or theatre',
  },
];

export const casesInRunOrder = (): readonly ProbeCase[] =>
  [...PROBE_CASES].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));

export const permanentAssetCount = (cases: readonly ProbeCase[] = PROBE_CASES): number =>
  cases.filter((probe) => probe.createsPermanentAsset).length;

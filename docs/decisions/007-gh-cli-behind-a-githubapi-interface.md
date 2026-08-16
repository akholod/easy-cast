# ADR 007: gh CLI sits behind a GitHubApi interface

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Principle P3 requires that GitHub credentials pass through exactly one choke point —
one resolver, one redactor, one spawn wrapper with an environment allowlist. `gh` is
the vehicle for every GitHub read and write except the upload endpoint itself
(comments, pull/issue lookup, viewer identity, listing). If callers throughout the
codebase invoked `gh` directly, each call site would be a fresh opportunity to leak
an environment variable, skip redaction, or diverge on pagination handling.

## Decision

All interaction with `gh` is defined by the `GitHubApi` interface —
`getViewerLogin`, `getRepo`, `findPullForBranch`, `getIssueOrPull`, `listComments`,
`createComment`, `updateComment` — and implemented once, in `src/github/gh-cli.ts`,
on top of the single spawn wrapper in `src/secret/spawn.ts`. `listComments` returns
an async iterable and paginates internally, so callers never see raw pages. WP-8's
acceptance criterion is explicit: zero direct `execFile` calls to `gh` outside this
module, verified by an architecture test covering both `src/` and `scripts/`.

## Alternatives considered

Call `gh` inline wherever a command needs it, since the CLI is small and most call
sites need only one or two `gh` operations. This was rejected because it multiplies
the number of places that must independently get environment scrubbing, identity
checking (see ADR 013), and pagination right, and because it would block the
pipeline and target-resolution code (WP-9, WP-12a) from being unit-tested against a
fake `GitHubApi` — the interface is also what lets `pipeline.ts` and
`target/resolve.ts` be tested without a network call.

## Consequences

`gh`'s environment allowlist (`HOME`, `XDG_CONFIG_HOME`, `PATH`) and its treatment of
`GITHUB_TOKEN`/`GH_TOKEN` (see ADR 013) live in one place and are covered by the leak
test suite once, not per call site. Any future consumer of GitHub data — `recover`,
a later `report` command — gets pagination and redaction for free by depending on
`GitHubApi` rather than on `gh` directly. The interface also isolates upload's
`repositoryId` metadata lookup (`getRepo`) from the upload quarantine boundary in
`src/upload/` (P5): fetching repository metadata is an ordinary `GitHubApi` call,
not a pre-flight decision baked into `UploadOutcome`.

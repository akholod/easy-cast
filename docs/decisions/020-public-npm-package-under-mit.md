# ADR 020: Public npm package under MIT

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

DG2 in the Decision Gate settled whether `easy-cast` ships as a public npm package
under MIT or stays private or internal. Choosing "public" pulls in a consequence
beyond licensing: the package's fixture files, including `observations.jsonl` from
the Stage 0 probes, ship inside the published tarball, and the repository itself is
public on GitHub — anything left unredacted in either place is exposed to the
world, not just to the project's own contributors.

## Decision

`easy-cast` is published to npm under `publishConfig.access: public` and the MIT
license, with `files` in `package.json` restricted to `dist/src`, `README.md`, and
`LICENSE` — the probe harness, raw fixtures, and test files are not part of the
published package even though they live in the repository. Because the package and
its source repository are both public, `scrubObservation()` — the function that
strips known-sensitive fields from probe observations before they are committed —
is treated as a blocking security gate in CI, not as hygiene that can slip.

## Alternatives considered

Keep the package private or unpublished until the endpoint's semantics are better
understood, publishing only after Stage 0 findings are fully validated in
production use. This was considered because publishing a client for an undocumented,
unofficial endpoint increases that endpoint's visibility and plausibly shortens how
long it stays usable in its current form — a real cost, and one the plan names
explicitly rather than dismissing. It was rejected because the project's primary
consumer is an autonomous agent, and a private or gated package is a meaningfully
worse fit for that consumer than an installable, public one; the visibility risk
was accepted knowingly rather than avoided by staying private.

## Consequences

Every fixture destined for `fixtures/endpoint/` or committed under
`observations.jsonl` must pass through `scrubObservation()` before it is committed,
not just before it is published, since the repository itself is already public. The
explicit narrowing of `files` in `package.json` means adding a new directory to the
published package is a deliberate, reviewable change rather than something that
happens by omission. The decision to publish is recorded as made with the
endpoint's shortened lifespan as a known, accepted cost — not a risk the team
failed to notice.

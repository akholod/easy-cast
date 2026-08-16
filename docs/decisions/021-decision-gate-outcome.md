# ADR 021: Decision Gate outcome

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Before implementation work could begin in earnest, four questions required a
decision from the user that no amount of further architectural analysis could
resolve on its own — naming, publication, permission to perform irreversible probe
experiments, and how the target repository is determined at runtime. A fifth
question, the fate of an `--allow-public` gate, could not be answered yet at all: it
depends on a fact — whether an attachment's URL is reachable anonymously once cited
in a public issue — that only the Stage 0 probe matrix's "nature of the asset" case
can establish, and that case is deliberately run last and once, because it is
classified as destructive rather than minimally-destructive.

## Decision

DG1 fixed the package name and bin entries as `easy-cast`, with `ecast` as an
alias, matching the plan's recommendation. DG2 fixed the package as a public npm
package under MIT, also matching the recommendation, with the consequence recorded
separately (see ADR 020) that `scrubObservation()` becomes a blocking security gate
rather than hygiene once probe fixtures are headed for a public tarball. DG3
granted permission to create and use two dedicated, one-time probe repositories,
`akholod/easy-cast-probe` (private) and `akholod/easy-cast-probe-public` (public),
satisfying the dependency the probe harness (see ADR 005) has on a real target to
probe against; neither repository is to be reused for anything else. DG5 determined
how `upload` and `attach` decide which repository to act on: the user chose
inference from the git remote of the working directory, with an explicit `--repo`
flag available to override it, against the plan's own recommendation of making
`--repo` mandatory. DG4 — the fate of the `--allow-public` gate — is left open by
construction: it is unresolvable before the Stage 0 "nature of the asset" probe
case runs, and is required to be settled immediately after that case and before
WP-13, the CLI surface freeze, closes.

## Alternatives considered

For DG5 specifically, the alternative was the plan's own recommendation — require
`--repo` explicitly on every invocation, with no inference at all. That option was
not rejected on technical grounds; it remained un-refuted through three rounds of
review of the inference design that followed. The user chose the inference-based
option anyway, for convenience, with the tradeoff named and accepted rather than
discovered later: an upload driven from the wrong working directory is now possible
where a mandatory flag would have prevented it outright.

## Consequences

Choosing inference over a mandatory flag does not remove the class of error it
introduces — it narrows it. Because the resolved `owner/repo` becomes part of
`PlanScope` and is therefore bound into the token computed by `--confirm-plan` (see
ADR 010), it is structurally impossible for a real upload to land in a repository
other than the one a plan was computed for; a mismatch between the two produces
exit code 7. What that binding does not do is prevent a plan itself from being
computed against the wrong directory in the first place — `computePlanToken` is
deterministic, so nothing stops a caller from generating a valid token for whatever
directory it happens to be in without ever inspecting the resolved repository
first. The CLI prints the resolved `owner/repo` and its inference basis to stderr,
and includes both in JSON, on every non-flag-sourced resolution, including the real,
non-dry-run call — but making that output be looked at is outside anything the tool
can enforce, which is the same limit ADR 010 states for `--confirm-plan` and
consent. This risk is recorded in the plan's "not guaranteed" list in those exact
terms: repository inference is a convenience the user chose knowingly, not a gap
nobody noticed.

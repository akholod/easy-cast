# ADR 010: --confirm-plan binds a run to a plan, not to consent

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Principle P2 requires that uploads be irreversible-safe: the CLI must guarantee that
what leaves the machine is exactly the content, target, and conversion policy fixed
at plan time, and must not claim to guarantee anything about whether a human looked
at that plan first. Three consecutive review revisions tried to make a mechanism do
more than that, and each time review caught the overreach. Revision 3 introduced a
constant flag, `--ack-permanent`: the architect called it theatre, because an agent
hits it once, bakes it into its call template, and from then on the flag carries
zero information about that specific run. Revision 4 replaced it with a token bound
to file content — the critic's finding was that a token an agent can compute on its
own, without ever running `--dry-run`, is not consent; it just moved the same
problem into a more convincing-looking mechanism, and the principle had been
rewritten to fit the mechanism rather than the other way round.

## Decision

The mechanism is named `--confirm-plan=<token>` and is required for every real
(non-dry-run) upload. The token is `computePlanToken` applied to a
`PlanFingerprint`: the target's `owner/repo/kind/number`, the `key` (for `attach`),
the conversion policy (`auto`/`none`), and the ordered list of `sourceHash` values
for the files in argv order after de-duplication by first occurrence. A mismatch
between the provided token and the token recomputed from the actual run produces
exit code 7, `plan_mismatch`, with `planContext` describing what changed.
Deduplication intent — whether a given file will be freshly uploaded or reused — was
deliberately left out of the fingerprint in revision 6: it depends on remote state
the tool doesn't control, and binding to it made the handshake fail to converge for
video, whose effective conversion profile is unknown at dry-run time, and under any
concurrent change to the target.

## Alternatives considered

The two earlier mechanisms above were both genuinely tried and genuinely rejected,
not strawmen — `--ack-permanent` for being a constant an agent stops noticing, and
the pure content-bound token for being silently reframed as proof of human review
when it is not. The alternative that survived, `--confirm-plan`, was kept
specifically because review found it gives a real, separate guarantee once its claim
was narrowed: exact match between the fingerprint a token was computed for and the
fingerprint of the run presenting it.

## Consequences

What the token proves is that the files, target, and conversion policy of this run
are exactly the ones a `--dry-run` (or an equivalent computation) fixed. What it
does not prove, and must never be described as proving, is that a `--dry-run` was
actually executed, or that any human or agent looked at its output before
proceeding — `computePlanToken` is a pure, deterministic function of the
fingerprint, so any caller capable of computing `sourceHash` values can produce a
valid token without ever calling `--dry-run` or seeing a printed plan. This
limitation is stated verbatim in the "not guaranteed" list in the README and skill,
and `uploadsAreIrreversible: true` is emitted unconditionally in every JSON response
for the same reason: it is a disclosure the tool owes regardless of a given run's
outcome, not a fact about that run.

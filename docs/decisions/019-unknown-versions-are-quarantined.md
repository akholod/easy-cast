# ADR 019: Unknown versions are quarantined, never interpreted

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Several artifacts in the system carry an explicit version tag — the comment marker,
the ledger delimiter, `JournalEvent.v`, the plan-token canonical payload, the JSON
`schema` field, and the hand-written response classification table. Any of these
can, in principle, encounter a version it does not recognize: a journal written by a
future release, a marker from a different major version, a classification table
entry nobody has updated yet. Principle P1 states the governing rule generally:
unparsed state is never presented as understood.

## Decision

Every one of these version checks resolves to quarantine, never to best-effort
interpretation, when the version is unrecognized. A journal line with an unknown
`v` is skipped and flagged as `journal-line-quarantined` while the rest of the file
is still read; a ledger delimiter of an unknown version is treated as not-a-ledger,
so its content is never parsed as `[digest, url]` pairs; a marker of an unknown
version is not treated as "ours," so the comment it is attached to is left alone
rather than being overwritten; an unrecognized classification-table version fails
the upload response classification outright rather than guessing at a match.

## Alternatives considered

Attempt forward- or backward-compatible parsing — for example, try to read the
known subset of fields from an unfamiliar version and proceed with what could be
extracted. This was rejected as a general policy because "extract what looks
familiar" is exactly the mechanism by which a classifier or parser confidently
misreads a state it does not actually understand, which is the mechanism the
pre-mortem's first scenario is built around; a wrong guess that looks like success
is worse than a quarantine that visibly stops and reports an anomaly.

## Consequences

Every quarantine is observable — it surfaces in `anomalies`
(`journal-line-quarantined`, `malformed-ledger`, and equivalents) rather than being
silently dropped — so a caller inspecting JSON output can tell that something was
skipped, even though the tool does not attempt to explain what the skipped content
meant. This trades completeness for honesty: a future format change is safe to ship
without risking a mis-parse of old data, at the cost of old or unrecognized state
never being automatically migrated or repaired by the tool itself.

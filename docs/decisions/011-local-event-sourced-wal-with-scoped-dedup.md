# ADR 011: Local event-sourced WAL with strictly scoped dedup

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

An upload can succeed against GitHub while the subsequent comment write fails, or a
process can die between the two — either way, the tool needs a durable, local record
of what was actually uploaded so a re-run does not upload the same content again and
cannot lose track of a URL that already exists. Revision 3 of the plan tried to make
that record maximally useful by deduplicating against the union of two sources: the
ledger already visible in the target comment, and the local journal. Architect
review rejected this: the union erases which target a given upload belonged to, so a
URL first uploaded for one issue could be silently reused as if it had been verified
for a second issue or repository it was never actually posted to. Worse, an uncited
attachment URL — one nobody has posted into rendered markdown yet — answers `404`
when fetched, so the tool cannot even confirm the reused URL is genuinely live
before handing it back.

## Decision

The local journal (`.easy-cast/journal.jsonl`) is an append-only, event-sourced
write-ahead log with two event kinds, `asset-recorded` and `ledger-synced`,
appended one `write(2)` per event under `O_APPEND`. `foldPending()` computes the
backlog — `asset-recorded` events with a non-null scope that lack a matching
`ledger-synced` for the same `(digest, scope)` pair — directly from this log, so the
backlog is always a pure function of events already on disk, never a separately
maintained counter that could drift. Deduplication only fires on a full scope
match: same owner, repo, kind, number, and key. Records written by the `upload`
command (`scope: null`) never participate in deduplication or backlog computation,
because `upload` has no target to scope them to — their only delivery is the URL
printed to stdout — but `recover` still lists them, since the journal is the
complete record regardless of what participates in dedup.

## Alternatives considered

The union-of-ledger-and-journal design from revision 3, described above, is the
real alternative that was tried and measured against the eventual design. It looked
attractive because it maximized reuse — any URL either source knew about could be
offered back — but it traded away the one property scoped dedup exists to protect:
that a reused URL is one this exact run's target has actually cited or will cite,
not merely one that exists somewhere.

## Consequences

Dedup opportunities are strictly narrower than they could be — a file uploaded once
for issue #1 will be re-uploaded, irreversibly, if later attached to issue #2, even
though the bytes are identical — and that narrowing is accepted as the cost of never
handing back a URL nobody can currently verify. An unrecognized journal-line version
or a truncated last line is quarantined per-line (see ADR 019) rather than blocking
the whole file, and `recover --json` always prints every readable record, with
`pending` reported as the subset still lacking a `ledger-synced` counterpart.

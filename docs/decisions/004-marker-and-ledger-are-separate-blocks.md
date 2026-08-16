# ADR 004: Marker and ledger are separate comment blocks

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

`attach` needs to find "its own" comment on a target reliably, and needs to record
which files, identified by content digest, have already been uploaded, so a re-run
does not create a fresh, irreversible copy of an asset already sitting on GitHub.
Those are two different questions with two different lifetimes: the marker rarely
changes once a key is chosen — it only says "this comment belongs to key K" — while
the ledger grows, evicts, and gets replaced on every successful upload. The
ledger-only update path (see ADR 015) also needs to change nothing else in the
comment body, which only works if the ledger already lives in a delimiter of its own,
distinguishable from the marker and from surrounding content.

## Decision

The marker `<!-- easy-cast:v1:attach:<key> -->` and the ledger block
`<!-- easy-cast:ledger:v1 ... -->` are two separate, fixed-delimiter regions in the
comment body. The ledger stores `[digest, url]` pairs, capped at 64 entries, evicted
MRU-style — but only between runs; eviction inside a single batch is disallowed (see
ADR 018), since it would discard entries that same batch just created. Both
delimiters carry a version tag, and an unrecognized version is quarantined rather
than parsed (see ADR 019).

## Alternatives considered

Fold the ledger into the marker itself — for example, encode the digest/url pairs as
marker arguments — so a comment carries one delimited region instead of two. This
was rejected because it collapses the ledger-only update path: any ledger change
would then require rewriting the marker line too, and a parser that has to
distinguish "marker changed" from "ledger changed" inside one blob reintroduces the
ambiguity that separate, independently versioned delimiters remove. Keeping the
marker a small, stable string also lets `findOwnComment` scan for it without first
understanding ledger syntax at all.

## Consequences

`replaceLedgerBlock` rewrites exactly the bytes between the ledger delimiters and
passes everything else — including anything a human appended to the comment by hand
— through unmodified on the ledger-only path. A comment with two ledger delimiters is
treated as malformed: the first is used, and the state is reported as
`duplicate-ledger-delimiter` rather than silently merged. The cap of 64 and its
eviction rule are ledger properties only; the marker carries no capacity limit of
its own.

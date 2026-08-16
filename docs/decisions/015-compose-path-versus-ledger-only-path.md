# ADR 015: Compose path versus ledger-only path

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

An `attach` comment body can come into being two different ways — created fresh,
where the CLI is the sole author of everything in it, or updated against an
existing comment that may carry content the CLI never wrote, such as a caption a
human added or markdown from an earlier tool version. Those two situations need
different promises about what survives an update, and the decision went through
several revisions before landing, at revision 6, on separating them explicitly
rather than trying to make one code path serve both.

## Decision

On the compose path — no existing own comment found — the entire body is generated
from scratch by `composeBody`, and preserving pre-existing markdown is not
attempted because there is none to preserve; the size budget here is an estimate
(`estimateBodyBytes`) computed before the body exists, and it must be an upper
bound on the actual byte count. On the ledger-only path — an own comment already
exists — only the bytes between the ledger delimiters are replaced by
`replaceLedgerBlock`; everything else in `existingBody` passes through unmodified
byte-for-byte. Because `existingBody` is already in hand on this path, its size
budget is computed exactly rather than estimated.

## Alternatives considered

Always recompose the full body on every update, even when an own comment already
exists, to keep one code path instead of two. This was rejected because it cannot
honor the — explicitly non-guaranteed but still desired where possible —
preservation of content the CLI did not write, such as a caption or a manual note
next to the marker, and it also throws away the more accurate exact-budget
calculation the ledger-only path gets for free once `existingBody` is already read.

## Consequences

Preservation of foreign markdown on the ledger-only path is a side effect of only
touching the delimited region, not a guarantee the tool makes — the "not
guaranteed" list says so explicitly, because nothing stops a future format change
or a malformed ledger block from forcing a full recompose even on an update. Two
duplicate ledger delimiters in one body are treated as malformed: the first is used
and `duplicate-ledger-delimiter` is reported as an anomaly rather than merging or
preferring the last.

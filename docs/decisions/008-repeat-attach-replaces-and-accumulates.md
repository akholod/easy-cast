# ADR 008: Repeat attach with the same key replaces and accumulates

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

`attach --key K` run twice against the same target is a normal, expected workflow —
an agent re-runs the same command after fixing a screenshot, or after a partial
failure. The command has to decide what "re-run" means both for the visible comment
content and for the record of what has already been uploaded, given that neither
can be walked back once an asset exists.

## Decision

A repeat `attach` with the same `--key` replaces the visible content the marker
owns — the rendered file list and caption for that key — while the ledger
accumulates rather than replacing: prior `[digest, url]` entries for other keys and
other prior uploads stay in the ledger, subject to the cap and MRU eviction (see
ADR 004 and ADR 018), and newly uploaded or reused files add their own entries.
Nothing is retroactively removed from the ledger by a later `attach` call; the
ledger's job is to remember what has already gone out, not to describe only the
most recent call.

## Alternatives considered

Make a repeat `attach` under the same key a no-op once the marker already exists,
refusing to touch the comment again. This was rejected because it removes the
ability to fix a caption, add a file to an existing key's set, or recover from a
comment that was hand-edited or lost — none of which are unusual in agent-driven
workflows — and because "no-op on match" still has to define what happens when the
file set under the key changes, which just reproduces the replace behavior under a
different name with an extra failure mode.

## Consequences

The visible portion of a comment reflects only the latest call for a given key, so
an agent that wants a history of what it attached under one key relies on the
ledger, not on comment edit history. Because the ledger keeps accumulating across
keys and across runs, digest-based reuse can succeed even when the marker being
written now is for a different key than the one that originally uploaded that file,
as long as both are within the same target's scope — scope, not key, is what bounds
deduplication (see ADR 011).

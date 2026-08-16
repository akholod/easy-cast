# ADR 016: Immutable single-read snapshot

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

A source file can be read more than once during a single `attach` or `upload` call
— once to compute `sourceHash` for the plan token and default key, again to feed
conversion, and again to build the upload body. If each of those reads goes back to
the filesystem independently, the file on disk could change between reads — a
screenshot overwritten mid-run, a TOCTOU race — producing a `sourceHash` that does
not actually describe the bytes that get converted or uploaded, silently breaking
the guarantee behind principle P2 and `--confirm-plan` (see ADR 010).

## Decision

Each source file is captured exactly once, either as an in-memory buffer or as a
held file descriptor whose inode and mtime are checked for consistency, and that
single captured snapshot is the only basis for `sourceHash`, `digest`, the
conversion input, and the upload body. No stage of the pipeline re-reads the file
from its path after the initial capture.

## Alternatives considered

Re-read the file from disk at each stage that needs it — hash computation,
conversion, upload — relying on the file being unlikely to change during a
short-lived CLI invocation. This was rejected because "unlikely" is not the
standard P2 sets: the whole point of binding `planToken` to `sourceHash` is that the
hash describes exactly what will be uploaded, and a design that can silently
diverge under a race, however rare, undermines that binding in exactly the scenario
it exists to catch.

## Consequences

WP-4's acceptance criteria include a dedicated test asserting the file's bytes are
captured only once, a TOCTOU-style check, and the pipeline's memory footprint for a
batch is bounded by holding all captured sources at once rather than streaming each
stage independently from disk. This is treated as an acceptable tradeoff given the
CLI's expected batch sizes — a handful of screenshots or one short video per call —
not a general-purpose streaming design.

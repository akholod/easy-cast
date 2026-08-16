# ADR 014: Default --key derives from source hashes

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

`attach` needs a `key` to know which marker, and therefore which comment, a call
belongs to. Requiring an explicit `--key` on every call is more typing for a caller
— often an agent — that just wants "attach these files," and the key still has to be
deterministic enough that the same logical call produces the same key twice, and
independent of anything as environment-dependent as whether `ffmpeg` happens to be
installed.

## Decision

When `--key` is omitted, it defaults to
`<command>-<sha256(sorted sourceHash)>.slice(0, 8)` — computed from the source
files' content hashes before conversion, sorted, then hashed and truncated. Because
it is derived from `sourceHash` rather than from any post-conversion artifact, the
default key is identical whether or not `ffmpeg` is available, and identical across
machines given the same source files, regardless of conversion outcome.

## Alternatives considered

Derive the default key from file names or from argv order instead of from content.
This was rejected because file names collide trivially (`screenshot.png` attached
twice from two different directories) and argv order is not a property of content at
all — two calls with the same files in a different order, or the same files
renamed, would get different default keys under a name- or order-based scheme,
defeating the purpose of a default meant to let repeat calls with the same
underlying evidence land on the same comment automatically.

## Consequences

Renaming a source file, or replacing it with a byte-identical copy, does not change
its default key, because the key is a function of content, not of the filesystem
path — this is the same distinction `plan-token.ts` draws for `sourceHash` more
generally (see ADR 010), and it is treated as correct rather than surprising.
Because the default key does not depend on `ffmpeg`'s presence, WP-10a's acceptance
criterion tests it explicitly: the default is deterministic whether or not
conversion tooling is installed.

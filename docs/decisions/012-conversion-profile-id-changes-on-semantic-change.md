# ADR 012: A semantic change to the conversion profile changes its id

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

`digest`, the ledger's key, is computed as `sha256(sourceBytes):profileId` — it has
to distinguish "this exact file, converted the same way" from "this exact file,
converted differently," or the ledger could reuse a URL for content that was never
actually produced from the same conversion settings. `sourceHash`, by contrast, is
computed on the raw source bytes alone, before conversion, precisely so it stays
stable across a conversion policy that later degrades — `ffmpeg` missing, or
`--no-convert` in effect.

## Decision

Any change to the conversion profile that alters its actual output — codec,
container, quality settings, or any other parameter that changes the bytes `ffmpeg`
produces — changes the profile's `id`. A profile id is a semantic version of "what
this conversion does," not an arbitrary label; two profiles that produce different
output must never share an id, and a profile whose output is unchanged has no
reason to bump its id.

## Alternatives considered

Keep a single stable profile id (for example `"default"`) and let the ledger key
rely on `sourceHash` alone, since the source file rarely changes. This was rejected
because it would let the ledger claim a URL is a valid stand-in for "this file,
converted with today's settings" even after the conversion settings changed
underneath it — silently offering back a video compressed under an old profile as
if it matched a new one. That is the same class of failure the classifier's
totality (see ADR 003) and the WAL's scoping (see ADR 011) are both designed
against, applied here to conversion instead of to the network response.

## Consequences

Every observable profile change requires its own id, and the codebase treats
profile ids as append-only rather than mutable in place — an existing id's meaning
cannot be redefined once entries in a ledger or journal reference it.
`computeDigest`'s canonical test vectors are fixed per profile id specifically so a
future edit to conversion parameters is caught by a failing test rather than by a
silent change in what an old digest means.

# ADR 013: Upload identity and gh identity must match

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Principle P3 requires that the credential used to authenticate the upload and the
credential `gh` uses resolve to the same identity, or the run is refused outright —
otherwise a comment could be posted as one GitHub user while the attachment was
uploaded under a different one's token, which is confusing at best and a
credential-handling bug at worst.

## Decision

Before any upload, the CLI calls `getViewerLogin()` under the same token that will
be used for the upload and compares it against the identity `gh` itself is
authenticated as. Any mismatch is exit code 2, `identity_mismatch`, with zero
uploads attempted — this check runs during the non-mutating pre-flight phase (see
ADR 017), strictly before the repair step or any new upload. On the environment
side, `ffmpeg` gets no inherited environment variables at all (`allowEnv: []`); `gh`
gets `HOME`, `XDG_CONFIG_HOME`, and `PATH`, with `GITHUB_TOKEN` always stripped and
`GH_TOKEN` forwarded only when it is itself the source of the upload token — so the
two processes cannot silently disagree about which credential is in play because
they were handed different ambient environments.

## Alternatives considered

Trust that a single `GITHUB_TOKEN` or `gh auth token` value is consistent for the
whole process and skip the explicit identity check, relying on `gh` and the upload
client sharing one token value by construction. This was rejected because the token
used for the upload and the token `gh` resolves at call time are not actually
guaranteed to be the same value across all the ways `gh` can be configured
(multiple accounts, `GH_TOKEN` overrides, keyring-backed auth) — asserting they
match once, explicitly, is cheap compared to the cost of a comment authored by the
wrong identity, especially once that comment cites a permanent attachment.

## Consequences

Every real run pays the cost of one extra `getViewerLogin()` call before any upload
proceeds. The identity check is unconditional and cannot be bypassed by a flag,
which means an environment with genuinely divergent credentials for upload and for
`gh` cannot use the tool at all until that divergence is resolved — this is treated
as correct behavior, not a gap, because P3's single choke point is meaningless if
the two ends of that choke point are allowed to disagree.

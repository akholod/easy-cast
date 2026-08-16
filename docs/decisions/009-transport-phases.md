# ADR 009: Transport phases — no-request-bytes vs. request-started

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Correct retry behavior hinges on one fact: did any request byte reach the network.
If none did, failure is almost certainly transient — DNS, TCP, TLS — and retrying is
safe. If even a header was written, the server may already have acted on a partial
or complete request, and retrying blind risks a duplicate, irreversible upload.
`transport.ts` has to make this distinction without knowing anything about GitHub's
specific protocol, since it is deliberately the first piece of `src/upload/` written,
ahead of the Stage-0 request-shape question (see ADR 003).

## Decision

`Transport.send` returns one of three outcomes. `no-request-bytes` means zero bytes
of the request — not even headers — were written to the socket; its error is
classified as `network_unreachable` (exit code 1), which is retryable.
`request-started` means at least one byte was written, headers included, even if the
body never went out; it is classified as exit code 5, `endpoint_unavailable`, and is
never retryable. If the server responds at all while the body is still being sent,
that response wins over any write error — it is treated as `phase: 'response'`,
because a server that answered has already told us more than a local write failure
can.

## Alternatives considered

Split the boundary at "did the full request, headers and body, get sent" rather than
"did any byte get sent." This was considered because a failure partway through a
large video body feels different from a failure before the first header. It was
rejected because the risk the phase distinction manages is server-side action, not
client-side completeness — a server that received headers and part of a body may
already have started processing, so the safety property, no blind retry once the
server could plausibly have acted, requires drawing the line at the first byte, not
the last.

## Consequences

`no-request-bytes` and `request-started` are the only two failure phases `Transport`
can report, and every retry decision in the upload path is driven by that
classification rather than by inspecting the specific error. The phase model is
protocol-agnostic by construction, so WP-11a (transport) closes and is tested before
Stage 0 resolves the wire format, and WP-11b later reuses the same two phases
without modification — its acceptance criterion states this explicitly: the number
of transport phases follows what Stage 0 establishes, with no edit to
`transport.ts` itself.

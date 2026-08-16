# ADR 003: Request shape is a Stage-0 question

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

The exact HTTP request shape used by `uploads.github.com/user-attachments/assets` is
undocumented — multipart versus raw bytes, which of `name`/`size`/`content_type`/
`repository_id` are required, and whether the flow is single-phase or two-phase (a
policy negotiation followed by a POST to a different host) are all unknown before
Stage 0 runs. The project's first architecture review found that the initial design
had quarantined the *response's* uncertainty behind a classifier but left the
*request* itself outside quarantine: request-building code was drafted against
assumed semantics that existed nowhere but in the author's head. That is exactly the
failure P5 exists to prevent — protocol uncertainty leaking outside `src/upload/`.

## Decision

`src/upload/wire.ts` (request construction) and `src/upload/classify.ts` (response
classification) are written only after Stage 0's probe matrix (S0-B) has filled in,
with observed evidence, whether the endpoint is single- or two-phase and which
fields it actually requires. Everything that does not depend on that answer — CLI
surface, target parsing, mime table, ledger, WAL, plan-token, render — starts
immediately after the Decision Gate and does not wait. `transport.ts`, the generic
HTTPS phase machine (see ADR 009), is written first specifically because it carries
zero protocol knowledge: it only distinguishes whether request bytes reached the
wire, which holds for any HTTP client regardless of what the endpoint wants. WP-11b's
acceptance criterion states this explicitly: the number of transport phases follows
whatever S0-B establishes, with no edit to `transport.ts` itself.

## Alternatives considered

Capture one network trace of GitHub's own web upload flow and hardcode that shape as
the implementation, skipping a dedicated probe harness. This was on the table
because it is faster and avoids Stage 0 entirely. It was rejected because a single
browser session, under one account, one file type, and one size, does not establish
an invariant — it shows what the browser happened to send, not what the endpoint
requires or tolerates, and it says nothing about the failure paths (oversized files,
missing push access, expired tokens) the classifier has to be total over. The
pre-mortem's first scenario — a classifier that confidently mislabels an unfamiliar
response — exists precisely because assumptions of this kind pass unnoticed until a
status/body combination nobody observed shows up in production.

## Consequences

The critical path runs through S0-A and S0-B before WP-11b, WP-12b, and WP-13 can
close. Integration tests for pipeline orchestration (WP-12a) run against a stub
classifier so ordering — pre-flight, repair, upload, record — is fixed and tested
before the real wire format is known; the stub is swapped for the real classifier
only in WP-12b. Some test infrastructure is written twice by design, once against
the stub and once against the observed endpoint, and that cost is treated as smaller
than shipping request code against a hypothesis.

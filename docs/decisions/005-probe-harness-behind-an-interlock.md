# ADR 005: Probe harness lives in the repo behind an interlock

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Verifying any hypothesis about the endpoint's request or response shape means
making a real, irreversible call against real GitHub infrastructure — every
successful probe creates an asset that can never be deleted (see ADR 003 and the
plan's principle P2). That work has to happen before S0-B can close, and its
findings feed the record of "observed vs. not-testable" facts the rest of the
architecture depends on (`endpoint-semantics.md`, and the provenance fields carried
by `mime-table.ts`). An ad hoc script run once from a terminal and discarded would
leave no audit trail for what was actually observed, and no forcing function to keep
destructive experiments rare and deliberate.

## Decision

The probe harness (`scripts/probe/run.ts`, `cases.ts`, `scrub.ts`) is a versioned
part of the repository, not a throwaway. It refuses to start unless four conditions
hold simultaneously: `EASY_CAST_PROBE_REPO` is set, the repository name matches the
allowlist (`*-probe`, `*-probe-public`), the caller passed
`--i-understand-attachments-are-permanent`, and DG3 — the user's written permission
to create the two dedicated probe repositories — has been granted (see ADR 021).
Every run appends to `observations.jsonl`, so the count and content of destructive
experiments are themselves observable artifacts, not just their conclusions.

## Alternatives considered

Run probes manually with `curl` or a scratch script outside version control, since
the immediate goal is a handful of one-off observations rather than a reusable tool.
This was rejected because probe findings are load-bearing: `mime-table.ts` carries
`sourceUrl`/`retrievedAt` provenance per row, and the classification table carries
`version`/`provenance` fields, both of which assume the observation that produced
them is reproducible and reviewable. An unversioned script also bypasses
`scrubObservation()`, which — once the package is public under MIT (see ADR 020) —
is the gate standing between raw `observations.jsonl` fixtures and an npm tarball; a
script nobody reviews is a script that can leak a credential into a published
package.

## Consequences

The probe harness ships in the repository, though not in the published npm package
— `package.json`'s `files` field is limited to `dist/src`, `README.md`, and
`LICENSE` — and is tested (`probe.scrub.test.ts`) like production code. The
interlock's four-part gate is deliberately blunt compared to `--confirm-plan` (see
ADR 010): the probe has no fixed file set or target to bind a content-derived token
to, so it uses a constant acknowledgement flag instead — a weaker guarantee,
accepted because the probe is run by a human operator during Stage 0, not by an
autonomous agent in steady-state use.

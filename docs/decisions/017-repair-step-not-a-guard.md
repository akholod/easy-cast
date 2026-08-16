# ADR 017: Repair step, not a guard

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

When an upload succeeds but the subsequent comment write fails — or the process
dies in between — the journal (see ADR 011) can end up holding an `asset-recorded`
event with no matching `ledger-synced`: a backlog. Revision 5's first attempt to
handle this made the backlog a preventive guard — any run that found a pending
backlog for its scope would refuse to proceed until the backlog was resolved.
Architect review caught the consequence: because nothing inside that guarded path
could resolve the backlog itself, a scope that ever entered this state would be
locked out permanently, with no built-in way forward. The review also pointed out
the fix was already sitting inside the pipeline: the same logic that would upsert a
comment from ledger content on a normal run could just as well upsert it from
backlog content — nothing new needed to be built, only reordered.

## Decision

Repair replaces the guard. It is the first stateful step of a real `attach` call
only, running after every non-mutating pre-flight check has passed — target
resolution, identity match (see ADR 013), the `--allow-public` gate, and plan-token
verification (see ADR 010) — and before any new file is uploaded. `pipeline.ts`
folds the pending backlog for the current scope; if it is non-empty, the step
appends to or creates the target comment from the journal's own record and emits a
`ledger-synced` event, closing the backlog without requiring a new `planToken`,
because repair is understood as completing an already-authorized operation, not
starting a new one. `--dry-run`, `upload`, and `recover` are explicitly excluded
from repair — they only display `pending`, and change nothing. The rule that "no
comment exists, so none is created" does not apply to the repair path specifically:
repair is the one case allowed to create a comment where none exists, if that is
what closing the backlog requires.

## Alternatives considered

The guard design described above is the real alternative — it was implemented in an
earlier revision, reviewed, and rejected specifically because it converts a
recoverable inconsistency into a dead end, which is a worse failure mode than the
temporary backlog it was meant to prevent.

## Consequences

A run whose repair step itself fails to close the backlog returns exit code 4,
`unresolved_backlog`, with `nextAction: 'report-to-human'` — this is the one path
left where a human, not a retry, is the answer. Two more partial failure modes are
named explicitly: if GitHub accepts the comment write but `ledger-synced` never
gets recorded, the backlog remains and the next repair performs an idempotent
upsert without uploading anything new; if the target itself has been deleted or is
unreachable, the backlog also remains and the run reports `unresolved_backlog`.
Concurrent repairs on the same scope fall under the same general race caveat as
concurrent `attach` calls: the outcome is fixed by test, not guaranteed race-free.

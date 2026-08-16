# ADR 018: In-batch ledger overflow versus MRU eviction

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

The ledger caps at 64 entries (see ADR 004) and evicts least-recently-used entries
once that cap is exceeded — but eviction assumes there is an existing, settled
ledger to evict from. A single batch call can itself contain more distinct files
than fit under the cap, and evicting mid-batch would mean discarding entries the
very same call just created, before the run even finishes.

## Decision

A batch that would require the ledger to hold more than 64 entries is rejected
outright, before any file in it is uploaded — exit code 2,
`reason: 'ledger_capacity_exceeded'`. MRU eviction remains a between-runs mechanism
only: it applies when a new run's additions push an already-settled ledger over the
cap, never within the run that is creating those additions.

## Alternatives considered

Apply MRU eviction uniformly, including within a single batch, so a large batch
simply evicts its own earliest entries as it goes rather than failing outright.
This was rejected because it would silently drop ledger entries for files the same
call just uploaded — the run's own results would not be fully recorded even though
every upload in it succeeded, which is a strictly worse outcome than refusing the
oversized batch up front, before any irreversible upload has happened.

## Consequences

A caller that needs to attach more than 64 distinct files to one target in one call
must split the work across multiple calls with disjoint sets, or accept that the
ledger will not track everything by digest. Because the rejection happens before
any upload, `ledger_capacity_exceeded` costs nothing irreversible — the same
reasoning that grounds the size policy in ADR 006 applies here: a local capacity
check that blocks too early wastes a command invocation, not an asset.

# ADR 023: `upload` keeps no local state

- **Status:** Accepted for 0.1.0
- **Date:** 2026-08-17

## Context

`upload` was the last unwired command. Stage 0 had established the wire format,
so the endpoint half was ready; what remained was deciding what `upload` *is*
relative to `attach`, and the tempting answer — "`attach` without the comment" —
is wrong in a way that costs permanent assets.

`attach` is safe to re-run. Two mechanisms make it so:

- a write-ahead **journal**, so a URL recorded before a failed comment write is
  written into the comment by the next run;
- a digest→URL **ledger** carried inside the comment, so a repeat reuses assets
  even on a machine that has never seen the journal.

Both are anchored to a comment. The journal's records carry a scope — owner,
repo, kind, number, key — and the repair step matches on it. The ledger lives in
the comment body.

`upload` has no comment. So neither mechanism has anything to attach to.

## Decision

`upload` records nothing: **no journal entry, no ledger, no deduplication.**

The alternative — journalling the upload anyway, "in case it is useful" — was
rejected on a specific failure, not on taste. A journal record is cleared by
`ledger-synced`, which only ever fires when a comment is written. An upload
record could therefore never be cleared. It would sit in `recover` forever as a
backlog nobody can resolve, and `attach`'s repair step would either ignore it
(making the report a lie) or try to write it into a comment it was never meant
for. A record that can only accumulate is worse than no record.

Three consequences follow, and all three are stated on every run rather than
left in the documentation:

- a repeat uploads again, permanently (`UPLOAD_RECORDS_NOTHING`);
- the URL is the only thing that survives the command, so the caller has to keep
  it;
- exposure is decided by wherever the URL is pasted
  (`UPLOAD_EXPOSURE_FOLLOWS_QUOTING`, and see ADR 022).

Also decided, in the same spirit of not implying capabilities that do not exist:

**`--to`, `--caption`, `--key` and `--allow-public` are refused on `upload`,**
with `bad_args` and a reason each, rather than silently ignored. `--allow-public`
is the one that matters: silently accepting it would let a caller believe a gate
had been satisfied on a command that has no gate to satisfy.

**The reported `digest` is computed but not used.** It is the same identity
`attach` would have deduplicated on, emitted so a caller who wants their own
deduplication does not have to reconstruct it. Nothing in `upload` consults it.

**`plannedAction` for video is `would-upload`, not `unknown`.** In `attach` a
video's action is genuinely unknown at plan time, because the conversion profile
decides the ledger key and therefore reuse-versus-upload. Nothing is ever reused
here, so the profile changes the bytes but not the answer.

## Alternatives considered

**Journal uploads under a synthetic scope.** Rejected: see above. It creates an
unclearable backlog, which is a worse failure than the one it prevents.

**Give `upload` its own scope-free ledger file.** A real option, and the closest
call. Rejected for 0.1.0 because it introduces a second, differently-shaped
persistence format for a command whose entire point is that it hands the caller
a URL and steps out of the way. If deduplicating uploads turns out to matter, the
right shape is probably an explicit `--ledger <path>`, not an implicit one.

**Ignore the meaningless flags instead of refusing them.** Rejected. Ignoring
`--allow-public` is indistinguishable, from the caller's side, from honouring it.

## Consequences

- `upload` is wired and answers `ok` with a URL, or a real failure — never
  `endpoint_unavailable` merely because it was not implemented.
- Its structural difference from `attach` is enforced by a test that fails if
  `src/upload-run.ts` ever imports the journal, the ledger or the comment
  modules.
- The one thing `upload` shares with `attach` — whole-batch validation, argv
  de-duplication, video-only conversion, the plan handshake, severity-ordered
  failure reporting — lives in `src/batch.ts` so the two cannot drift apart on
  what they accept.
- Verified live on 2026-08-17 against `akholod/easy-cast-probe`: exit 0, one URL
  returned, no comment, no `recovery` block, and no `.easy-cast` directory
  created in a clean working directory.

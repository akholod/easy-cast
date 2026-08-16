# Release readiness

Publishing this package makes an irreversible action available to anyone who installs it. The bar is
therefore not "the tests are green" — the tests run against fixtures, and the fixtures encode
assumptions about an endpoint nobody has yet observed. The bar is that the assumptions have been
checked against the real thing, once, deliberately.

---

## The release stop rule

**Before publishing: one live smoke against a private repository.**

One. Against a repository designated for it, private, disposable. Not a matrix, not a sweep of file
types, not a loop.

**If the classifier's default branch fires — `endpoint_unavailable` — the release is blocked.** That
outcome means the response could not be interpreted, which means the tool cannot tell an accepted
upload from a rejected one, which means it cannot honour its own retry policy. Shipping that would
hand users a tool that produces permanent artifacts it cannot account for.

**The investigation happens on that one case, not by mass probing.** Every probe against the live
endpoint creates an attachment that cannot be deleted. Widening the search to "see what it does" is
how a blocked release turns into a permanent litter of assets in someone's repository. Take the one
observation, take it to the probe harness under its interlock, and change the classifier or the wire
format on the strength of it.

---

## Checklist

Every row must be true before `pnpm publish`.

| # | Condition | State |
| --- | --- | --- |
| 1 | Stage 0 (S0-A/S0-B/S0-C) has run and its findings are recorded | **not met** — Stage 0 has not run |
| 2 | `docs/endpoint-semantics.md` exists and carries one row per cell of the S0 matrix, each `observed` or `not-testable`, each with provenance | **not met** — the file does not exist |
| 3 | DG4 is decided: whether an asset uploaded against a private repository is reachable once its URL is quoted publicly, and therefore whether `--allow-public` is a meaningful gate | **not met** — open by construction until the S0-B "nature of the asset" case runs |
| 4 | `src/upload/wire.ts`, `classify.ts` and `upload.ts` are implemented against the established wire format, replacing the stub port | **not met** — the port is still `stubUploadPort`, whose only answer is `endpoint_unavailable` |
| 5 | `upload` is wired to a real implementation rather than returning `endpoint_unavailable` unconditionally | **not met** |
| 6 | `mime-table.ts` has been reconciled against Stage 0 findings, or an explicit "no divergence found" is recorded with provenance | **not met** — depends on S0-B |
| 7 | One live smoke against a private repository has been run, and its result is recorded in this file | **not met — not run** |
| 8 | The live smoke did **not** end in `endpoint_unavailable` | **not evaluable** — see 7 |
| 9 | `pnpm test`, `pnpm typecheck` and `pnpm lint` all exit 0 | **met** — 514 tests pass |
| 10 | The leak set is green: no token in argv, stdout, stderr, JSON or anomalies; `scrubObservation()` gates every probe fixture | **met** as tested; re-verify after Stage 0 adds real fixtures |
| 11 | The 404-until-quoted behaviour is confirmed rather than assumed, and the wording in `src/output.ts` matches what was observed | **not met** — currently an observation pending confirmation |
| 12 | README carries the authorisation matrix with `GITHUB_TOKEN` unsupported, and the full "not guaranteed" list | **met** |
| 13 | The skill covers every `(exitCode, reason)` pair and every "not guaranteed" line | **met** — §7–§10 and `skill/references/failures.md` |
| 14 | Probe issues are closed, probe labels removed, and the list of assets Stage 0 created is recorded — attachments are never deleted, so the list is the only accounting there will be | **not met** — S0-C depends on S0-B |

---

## Live smoke result

**Not run.** Stage 0 has not started, so there is nothing to record here.

When it runs, this section records: the date, the repository it ran against, the file, the resulting
`(exitCode, reason)` pair, whether the attachment rendered in the comment, whether the asset URL
answered 404 before the comment quoted it and what it answered after, and the URL of every asset the
smoke created — permanently.

---

## Verdict today

**Not releasable.** Rows 1–8, 11 and 14 are unmet, and rows 4, 5 and 7 are not cosmetic: the upload
path does not exist. The package would install and answer exit 5 `endpoint_unavailable` to every
`upload`, and to every `attach` that is not fully served from cache.

That is stated in the README as well, in as many words, so that nothing about this repository reads
as a working tool before it is one. Green tests are evidence that the parts around the endpoint
behave as designed; they are not evidence about the endpoint, and this document exists to keep the
two from being confused.

## Debt created deliberately, owed by US-020 (WP-12b)

`ledgerOnlyBodyBytes()` was written, tested, and then **deleted** during the cleanup pass because
nothing in production called it. Keeping it would have implied a size gate that does not exist.

The gap it stood for is real and must be closed when the real classifier is integrated:

- the pre-upload budget currently projects only the **new** files. It does not read the existing
  comment and its ledger first, so an update that would push an already-large comment past GitHub's
  limit is not caught before the irreversible uploads happen;
- the fix is to fetch the existing comment read-only during pre-flight, project the final body from
  it, and apply the exact ledger-only budget before the first byte moves;
- required test: an oversized existing comment ⇒ **zero uploads**.

This cannot bite today — the upload port is a stub and nothing has ever been uploaded — which is why
it was deferred rather than rushed. It becomes reachable the moment US-020 lands.

---

## Stage 0 result, 2026-08-16

Stage 0 **has now run**. The section above that says otherwise is superseded here.

**Live smoke: passed.** The real CLI, against `akholod/easy-cast-probe`:

| Step | Result |
| --- | --- |
| `--dry-run` | printed the plan and a `--confirm-plan` token; nothing uploaded |
| real `attach` | exit 0, one asset uploaded, comment posted |
| the identical command again | exit 0, `assetsCreated: 0`, file reported `reused` with the same URL, comment **updated** rather than added |

Both levels of idempotency are therefore confirmed against live GitHub, not only
against fixtures: the marker found the tool's own comment, and the ledger prevented
a second upload of the same bytes.

The classifier's default branch did **not** fire during the smoke, so the release
stop rule is satisfied on that count.

### What changed as a result

- The wire format is established and `wire.ts` implements it: single phase,
  `repository_id`/`name`/`size` in the query, the declared type in the header.
- `--allow-public` survives, for a corrected reason — see ADR 022. Exposure follows
  where the URL is quoted, not the repository it was uploaded against.
- The 404-until-quoted advisory is no longer hedged: the canonical URL answers 404
  to a direct fetch permanently, and the image is served through a short-lived
  signed URL substituted at render time.

### Still blocking a release

| Item | State |
| --- | --- |
| `upload` command | still not wired; answers `endpoint_unavailable` |
| Pre-upload body budget against an existing comment | still owed by US-020 — see the debt section above |
| Video types and the size ceiling | unprobed; each success costs a permanent attachment, and the image cases already establish the accept/reject shape |
| Classic PAT without `repo`, installation tokens | untested; both need credentials issued by hand |
| Abuse detection / rate limiting | not observable at this matrix size; would resolve to `endpoint_unavailable`, the safe direction |

### Permanent artefacts

Five attachments were created and **cannot be deleted**: four by the probe, one by
the live smoke. Four probe issues were opened across both probe repositories and
have been closed by `scripts/probe/cleanup.ts`. Closed, not deleted — the REST API
offers no issue deletion, and the harness reports what happened rather than what
was hoped for.

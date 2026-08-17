# Release readiness

Publishing this package makes an irreversible action available to anyone who installs it. The bar is
therefore not "the tests are green" — the tests run against fixtures, and a fixture can only encode
what somebody has actually observed. The bar is that the assumptions have been checked against the
real endpoint, deliberately, and that what was *not* checked is written down as such.

Last revised 2026-08-17.

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
endpoint risks an attachment that cannot be deleted. Widening the search to "see what it does" is how
a blocked release turns into a permanent litter of assets in someone's repository. Take the one
observation to the probe harness under its interlock, and change the classifier or the wire format on
the strength of it.

A corollary learned on 2026-08-17, worth stating because it made one whole question free: **ask the
cheapest version of the question first.** The size ceiling looked like it had to cost a large
permanent asset. It did not — `size` is a query parameter, so declaring 5 GiB while sending 64 bytes
asked the same question and created nothing.

---

## Checklist

Every row must be true before `pnpm publish`.

| # | Condition | State |
| --- | --- | --- |
| 1 | Stage 0 has run and its findings are recorded | **met** — 2026-08-16, extended 2026-08-17 |
| 2 | `docs/endpoint-semantics.md` records what was observed, with provenance, and what was not | **met** |
| 3 | DG4 is decided: whether an asset uploaded against a private repository is reachable once its URL is quoted publicly, and therefore whether `--allow-public` is a meaningful gate | **met** — decided against the original assumption; see [ADR 022](decisions/022-allow-public-gate-after-stage-0.md) |
| 4 | `src/upload/wire.ts`, `classify.ts` and `upload.ts` are implemented against the established wire format, replacing the stub port | **met** — the stub was deleted in `eb48310` |
| 5 | `upload` is wired to a real implementation rather than returning `endpoint_unavailable` unconditionally | **met** — 2026-08-17; see [ADR 023](decisions/023-upload-keeps-no-local-state.md) |
| 6 | `mime-table.ts` has been reconciled against Stage 0 findings, or an explicit "no divergence found" is recorded with provenance | **met** — `.png`, `.gif` and `.mp4` observed accepted, and the 10 MB figure is now the endpoint's own words rather than the documentation's. `.webm`, `.mov`, `.jpg`, `.webp` and `.svg` remain documentation-derived and are listed as such |
| 7 | One live smoke against a private repository has been run, and its result is recorded in this file | **met** — four of them, below |
| 8 | The live smoke did **not** end in `endpoint_unavailable` | **met** |
| 9 | `pnpm test`, `pnpm typecheck` and `pnpm lint` all exit 0 | **met** — 627 tests |
| 10 | The leak set is green: no token in argv, stdout, stderr, JSON or anomalies; `scrubObservation()` gates every probe fixture | **met** — re-verified after the 2026-08-17 observations were added |
| 11 | The 404-until-quoted behaviour is confirmed rather than assumed, and the wording in `src/output.ts` matches what was observed | **met**, and stronger than the original claim: the canonical URL answers 404 permanently, to a direct fetch, in every case |
| 12 | README carries the authorisation matrix with `GITHUB_TOKEN` unsupported, and the full "not guaranteed" list | **met** |
| 13 | The skill covers every `(exitCode, reason)` pair and every "not guaranteed" line | **met** — §7–§10 and `skills/easy-cast/references/failures.md` |
| 14 | Probe issues are closed and every asset Stage 0 created is listed — attachments are never deleted, so the list is the only accounting there will be | **met** — see "Permanent artefacts" |
| 15 | The skill ships in the package rather than only in the repository | **met** — `files` includes `skills`, and `skills/easy-cast/SKILL.md` is where an installer looks |

---

## Live smoke results

### 2026-08-16 — `attach`, against `akholod/easy-cast-probe` (private)

| Step | Result |
| --- | --- |
| `--dry-run` | printed the plan and a `--confirm-plan` token; nothing uploaded |
| real `attach` | exit 0, one asset uploaded, comment posted |
| the identical command again | exit 0, `assetsCreated: 0`, file reported `reused` with the same URL, comment **updated** rather than added |

Both levels of idempotency confirmed against live GitHub rather than only against fixtures: the
marker found the tool's own comment, and the ledger prevented a second upload of the same bytes.

### 2026-08-17 — video through `attach`, same repository

| Step | Result |
| --- | --- |
| `attach clip.mp4 --to issue:1` | exit 0, `video/mp4` **accepted** (201) |
| how it rendered | `body_html` carried `<video controls muted>` — a bare URL on its own line does produce the native player |
| what serves it | `private-user-images.githubusercontent.com/<uploader user id>/<id>-<uuid>.mp4?jwt=…`, `X-Amz-Expires=300`, `response-content-type=video/mp4` |
| the identical command again | exit 0, `assetsCreated: 0`, `reused` — the ledger key survives conversion |

Two things this settled that had been assumed: `video/mp4` is an accepted type, and the bare-URL
rendering is measured rather than inferred from how GitHub's web UI writes video links.

### 2026-08-17 — the size ceiling, at no cost

Declared `size=5368709120` (5 GiB) while sending 64 bytes:

```
422 {"message":"Validation Failed","errors":[{"resource":"UserAsset","code":"custom","field":"size",
     "message":"size Yowza that's a big file. … with a file size less than 10MB."}]}
```

- The endpoint **names its own ceiling: 10MB.** The unit — MB or MiB — is not stated and was not
  measured.
- It validates the **declared** size before reading the body, so an over-large file costs one round
  trip rather than one upload.
- **No attachment was created.** The question that looked like it had to cost a large permanent asset
  cost nothing at all.
- The message is written for the web UI and arrives wrapped in `<span>` markup. The classifier strips
  the tags before the message reaches a caller; the wording is untouched, and the raw body is recorded
  verbatim in `fixtures/endpoint/observations.jsonl`.

### 2026-08-17 — `upload`, same repository

| Step | Result |
| --- | --- |
| `upload dot.png --allow-public` | exit 2 `bad_args` — the flag is refused, not ignored |
| `upload dot.png --dry-run` | exit 0, plan and token, both `upload`-specific notes present |
| real `upload` | exit 0, one URL, **no `comment` and no `recovery` in the output** |
| in a clean directory | **no `.easy-cast` directory created** — `upload` opened no journal |

The classifier's default branch did not fire in any of these smokes, so the release stop rule is
satisfied.

---

## Verdict today

**Releasable on the endpoint evidence.** Rows 1–15 are met, the upload path exists and has been
exercised live on both commands, and every classifier row is backed by a response somebody actually
received.

What remains before `pnpm publish` is release mechanics rather than evidence: the repository has
never been pushed, so CI has never run anywhere but this machine.

Green tests are evidence that the parts around the endpoint behave as designed; they are not evidence
about the endpoint, and this document exists to keep the two from being confused.

---

## Still not established

Each of these is a deliberate gap with a reason, not an oversight:

| Item | Why it is still open |
| --- | --- |
| `.webm` and `.mov` | each success costs another permanent asset, and `.png`/`.gif`/`.mp4` already establish the accept/reject shape across both categories |
| The exact size boundary (MB vs MiB) | one refusal establishes the shape the classifier needs; the exact byte would cost a request per probe and change no behaviour |
| Whether the ceiling differs by plan or by media type | the probe account is one account on one plan. GitHub documents 100 MB for paid-plan video; that figure remains documentation, not observation |
| Installation tokens (`ghs_`) | CI is out of scope and `GITHUB_TOKEN` is deliberately never read |
| A classic PAT without the `repo` scope | that credential has to be issued by hand through the web UI |
| Abuse detection and rate limiting | not observable at this matrix size. A `403` with an HTML body would resolve to `endpoint_unavailable`, which is the safe direction |
| A 400 with no declared type | seen before recording began, never captured properly |
| A connection dropped after the body has been sent | not induced deliberately; the transport treats it as `request-started`, the conservative reading |

One further item is a known weakness rather than an unknown, and it belongs here so it is not mistaken
for a guarantee:

**The upload/`gh` identity check cannot currently fail.** `assertSameIdentity` compares
`api.getViewerLogin()` with `api.getViewerLogin()` — both sides are read through `gh`. Because
`ghAllowEnv` forwards `GH_TOKEN` to `gh` when the token came from there, and otherwise the token
*came from* `gh`, the two are the same identity by construction, and the assertion documents an
invariant rather than verifying one. Making it a real check means reading the identity with the upload
token directly (`GET /user` with the bearer token) rather than through `gh`. It is recorded here
rather than quietly left in place, because
[ADR 013](decisions/013-upload-and-gh-identity-must-match.md) and the README both describe it as a
comparison that happens before anything is uploaded.

---

## Permanent artefacts

Seven attachments exist and **cannot be deleted**:

| When | Case | Repository it was uploaded against |
| --- | --- | --- |
| 2026-08-16 | request-shape investigation (`.png`) | private |
| 2026-08-16 | accepted-type check (`.gif`) | private |
| 2026-08-16 | asset-nature test (`.png`) | private, then quoted publicly |
| 2026-08-16 | public-visibility check (`.png`) | public |
| 2026-08-16 | `attach` live smoke (`.png`) | private |
| 2026-08-17 | video live smoke (`.mp4`) | private |
| 2026-08-17 | `upload` live smoke (`.png`) | private |

The 2026-08-17 size probe created **none** — that was the point of asking it the cheap way.

Probe issues were opened in both repositories and are closed by `scripts/probe/run.ts --cleanup`.
Closed, not deleted: the REST API offers no issue deletion, and the harness reports what happened
rather than what was hoped for. The attachments are not cleaned up, because they cannot be.

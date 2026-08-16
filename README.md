# easy-cast

Attach visual evidence — screenshots and video — to a GitHub issue or pull request from the command
line.

An agent that changes the front end can only report in prose: "done, checked it." A reviewer gets a
claim, not proof. `easy-cast` is the missing step between the two: it takes a file that already
exists on disk, uploads it, and posts it into a comment the tool owns and can find again. Capture is
not its job: the `playwright-cli` skill records the screenshot or the video, `easy-cast` delivers it.

Its primary consumer is an agent rather than a person, which is why the output is a machine
contract: `--json` emits exactly one JSON object whatever happens, and every failure carries a
`nextAction` rather than leaving an exit code to be guessed at.

---

## Status: `attach` works, `upload` does not

Stage 0 — the probe that establishes the undocumented endpoint's wire format and response
semantics — **has run**. What it found is in
[docs/endpoint-semantics.md](docs/endpoint-semantics.md), and the raw evidence is in
`fixtures/endpoint/observations.jsonl`.

| Command | State today |
| --- | --- |
| `attach` | **works.** Verified end to end against a real repository: dry run, real attach, then the identical command again — which reused the asset, created nothing, and updated the comment rather than adding one |
| `upload` | **not wired.** Returns exit **5** `endpoint_unavailable` immediately |
| `recover` | works. It only ever reads the local journal |
| `--dry-run` | works, and is meaningful: it produces a real plan and a real `--confirm-plan` token |

Still not released, and [docs/release-readiness.md](docs/release-readiness.md) says what is
outstanding. In short: `upload` is unwired, the pre-upload size budget does not yet account for an
existing comment, and video types, the size ceiling, installation tokens and abuse detection remain
unprobed — each for a stated reason rather than by oversight.

---

## Uploads are irreversible

An uploaded attachment **cannot be deleted — ever**. Removing the markdown from a comment does not
remove the asset. Editing the comment does not. Deleting the comment does not. Closing the issue does
not. The asset stays reachable at its own URL.

Every design decision in this tool follows from that one fact:

- sanitised source data is the primary defence; masking is secondary and leaks on anything that
  moves;
- consent for anything irreversible is collected **before** the bytes leave the machine;
- nothing is ever retried automatically when the outcome is unknown.

---

## Install

Not published yet. From a clone:

```bash
pnpm install
pnpm build
node dist/src/cli.js --help
```

Requires Node 22 or newer, `gh` on `PATH` for everything except the upload itself, and `ffmpeg` if
you want video converted to a widely playable mp4 rather than uploaded as-is.

---

## The three commands

```
easy-cast attach <file...> --to pr | pr:<n> | issue:<n>
easy-cast upload <file...> [--repo owner/name]
easy-cast recover
```

| Command | What it does |
| --- | --- |
| `attach` | uploads the files and writes them into a comment on a pull request or issue. The comment is identified by a hidden marker, so a repeat run updates that comment instead of adding another |
| `upload` | uploads without posting anything. No comment, no ledger, and **no deduplication whatsoever** |
| `recover` | prints the local write-ahead journal: what was uploaded, and what is recorded locally but not yet referenced by any comment. It only reads — repair belongs to a real `attach` run, which is the only thing that knows the target |

Flags, in full, are `easy-cast --help`. The ones that change what is at stake:

| Flag | Effect |
| --- | --- |
| `--to pr` | resolves the pull request open for the current branch. If there is none, exit 3 — the tool never opens one |
| `--repo owner/name` | overrides the repository inferred from the git remote. The only way to eliminate the wrong-directory class of error outright |
| `--key <key>` | addresses a specific comment. Defaults to a hash of the source files |
| `--dry-run` | plans and changes nothing: no upload, no mutating GitHub call, no temporary file, no repair. Prints a `--confirm-plan` token |
| `--json` | exactly one JSON object on stdout, whatever the outcome, including an unhandled exception |
| `--no-convert` | uploads video as-is instead of converting it. Toggling this back and forth costs one irreversible upload, because the conversion profile is part of the deduplication key |
| `--allow-public` | consent to uploading into a public repository. Without it, a public target is refused with exit 6 before any byte moves |

---

## The `--dry-run` → `--confirm-plan` handshake

A real upload requires a token that was computed for the same plan:

```bash
easy-cast attach shot.png --to pr --dry-run --json     # exit 0, reason dry_run, prints planToken
easy-cast attach shot.png --to pr --confirm-plan=<token>
```

Without a token: exit 7, `plan_missing`. With a token computed for a different plan: exit 7,
`plan_mismatch`, and `planContext.changed` names what moved.

**What the token proves.** That what leaves the machine is exactly: those source bytes, identified by
hash, in that order, to that repository, that issue or pull request, under that `--key` and that
conversion policy. If any of those changed after the token was issued, the run is refused rather than
performed.

**What the token does not prove**, and cannot:

| Claim | Why the token cannot carry it |
| --- | --- |
| "`--dry-run` was executed" | the token is deterministic — it is computable from the plan without ever running `--dry-run` |
| "a plan was displayed to anyone" | nothing about display is an input to the token |
| "a human agreed" | consent is not observable by a CLI |
| "the file was looked at" | the token is computed over bytes, not over pixels anybody saw |

So an automated caller can satisfy the handshake completely while having seen nothing. That is a
conceded limit, not an oversight — see
[ADR 010](docs/decisions/010-confirm-plan-binds-a-run-to-a-plan.md). The obligation to look at the
file before publishing it lives in the skill, and the CLI cannot enforce it.

What the CLI does own is the rendering: `--dry-run` prints a human-readable plan — the repository and
how it was inferred, every file with its size and size verdict, whether `ffmpeg` was found and
therefore whether video will be converted, and then the token. Without that, the handshake would be
two automated calls with nothing shown in between.

---

## Authorisation

| Source | Supported | Notes |
| --- | --- | --- |
| `GH_TOKEN` | **yes** | read first. When it is the source, it is also forwarded to `gh`, so both sides act as the same account |
| `gh auth login` | **yes** | used when `GH_TOKEN` is unset: the token comes from `gh auth token` |
| `GITHUB_TOKEN` | **no — deliberately unsupported** | never read, and always stripped from the environment of any child process |

Why `GITHUB_TOKEN` is unsupported: it normally arrives from GitHub Actions as an installation token,
CI is explicitly out of scope for this iteration, and the upload endpoint's behaviour under an
installation token has never been observed. Silently picking up a credential whose behaviour against
an irreversible endpoint is unknown is worse than reporting that no token was found. With no
credential, the tool exits 2 `token_not_found` and says exactly what to do.

`GITHUB_TOKEN` is also stripped from `gh`'s environment on every call, because `gh auth token` prints
whatever `GITHUB_TOKEN` holds when it is set — leaving it in place would silently switch the identity
out from under the check below.

**Both sides must be the same account.** The token that uploads and the `gh` session that writes the
comment are compared before anything is uploaded; a mismatch is exit 2 `identity_mismatch` with zero
uploads. Uploading under one identity and commenting under another would attribute a permanent
attachment to an account the caller never named. See
[ADR 013](docs/decisions/013-upload-and-gh-identity-must-match.md).

---

## Outcomes

Exit code alone is ambiguous on purpose; the pair `(exitCode, reason)` is the contract, and each pair
carries its own `nextAction`.

| Exit | Means |
| --- | --- |
| 0 | done — or, for `dry_run`, a plan awaiting `--confirm-plan` |
| 1 | the run failed with the remote state known (except `internal_error`, which is unknown) |
| 2 | the call or the environment is wrong; nothing was uploaded |
| 3 | no such pull request, issue or repository. Nothing was created, and nothing is guessed |
| 4 | partial upload — some files landed. Safe to repeat only when `reason` is `partial_upload_retryable` |
| 5 | the endpoint could not be spoken to, or answered unclassifiably. State unknown; **never repeat** |
| 6 | public repository without `--allow-public`. Refused before any byte moved |
| 7 | the plan token is missing or no longer matches |

The full pair-by-pair table, with the retry rules and what to say to a person for each one, is in
`skill/references/failures.md`.

---

## Not guaranteed

Stated in full, because each line is a way this tool can cost you something irreversible:

- **deletion of an uploaded asset — never, under any exit code;**
- **that a human saw the file:** `--confirm-plan` proves the plan matched, not consent;
- **that a plan was ever shown at all:** `computePlanToken` is deterministic, so a caller can compute
  a valid token without ever running `--dry-run`. What is guaranteed is that execution matches the
  plan — not that the plan was demonstrated to anybody;
- **that the repository was inferred correctly relative to your intent** (D2″/DG5): the repository is
  taken from the git remote of the directory the command ran in. Running from the wrong directory
  results in an irreversible upload into a different repository. The tool prints the resolved
  `owner/repo` and the basis of the inference on every inference, but it cannot prevent that output
  being ignored. To eliminate the class of error entirely, pass `--repo` explicitly;
- **idempotency under concurrent runs:** the behaviour is pinned by a test, not fixed;
- **reuse across targets or across `--key` values;** and `upload` does not deduplicate at all;
- **preservation of someone else's markdown:** on the compose path the comment body is overwritten
  whole; on the ledger-only path preservation is incidental, not promised (D15′);
- **behaviour when several of the tool's own comments carry the same marker:** the oldest is
  rewritten, the rest stay visible with stale URLs, and their ledgers are not read — on another
  machine that costs one irreversible re-upload;
- **the journal is bound to the directory the command ran in.** `.gitignore` excludes only
  `.easy-cast/tmp/`, so `journal.jsonl` **can be committed, and then travels with the repository**
  (which is why `.gitattributes` sets `merge=union` on it). If it is not committed, then another
  machine, CI, a run from a different directory, or `rm -rf .easy-cast` all mean no deduplication —
  and, on a repeat, irreversible duplicates. Whether to commit the journal is your decision, and the
  skill is required to name it;
- **atomicity of `O_APPEND` on network filesystems** (NFS, a networked `$HOME`) is not guaranteed —
  the test is green on a local filesystem only;
- **switching `--no-convert` on and off** costs one irreversible upload;
- **eviction from a comment's ledger past 64 distinct files** costs one irreversible upload (on the
  same machine this is softened by the local write-ahead journal);
- **the correctness of every interpretation of the endpoint until Stage 0 completes.**

One open question is worth naming separately, because it decides whether a safety gate means
anything: whether an asset uploaded against a **private** repository stays unreachable once its URL
is quoted somewhere public **has not been established**. That is DG4, and Stage 0's "nature of the
asset" case settles it. Until then, a private target is not evidence of privacy, and the worth of
`--allow-public` is itself unknown. Treat every uploaded frame as readable by a stranger.

---

## Design decisions

The reasoning behind each of the above lives in [docs/decisions/](docs/decisions/) — records 003 to
021, one per decision, with the alternatives that were considered and what each choice costs. The
index is
[docs/decisions/README.md](docs/decisions/README.md). Rather than restating them here: start with
[003](docs/decisions/003-request-shape-is-a-stage-0-question.md) for why the endpoint is quarantined,
[010](docs/decisions/010-confirm-plan-binds-a-run-to-a-plan.md) for the plan handshake,
[011](docs/decisions/011-local-event-sourced-wal-with-scoped-dedup.md) and
[017](docs/decisions/017-repair-step-not-a-guard.md) for deduplication and repair, and
[021](docs/decisions/021-decision-gate-outcome.md) for the open DG4 question above.

Two further documents: [docs/skill-derived-requirements.md](docs/skill-derived-requirements.md)
records the requirements the skill imposed on the CLI surface and how each was closed or rejected,
and [docs/release-readiness.md](docs/release-readiness.md) records what has to be true before this is
published — and why it is not publishable today.

---

## Licence

MIT. See [LICENSE](LICENSE).

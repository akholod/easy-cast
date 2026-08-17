# Every outcome, and what to do about it

The pair `(exitCode, reason)` is the contract. The exit code alone is ambiguous by design — code 1
covers both a dead network and a rejected file, code 4 covers both a partial upload that is safe to
repeat and one that is not — so every pair carries its own `nextAction`, and **`nextAction` is what
you act on**.

With `--json`, stdout carries exactly one valid JSON object no matter how the run ended, including
an unhandled exception inside the tool (which becomes `1` / `internal_error`). Parse it. Do not
branch on the exit code plus a substring of the message.

## The table

| Exit | `reason` | `state` | `retryable` | `nextAction` | What it is |
| --- | --- | --- | --- | --- | --- |
| 0 | `ok` | known | false | `done` | attached; the comment was written |
| 0 | `dry_run` | known | false | `request-plan` | a plan and a `planToken`. **Not** the end of the job |
| 0 | `recover_report` | known | false | `done` | `recover` read the journal. It only ever reads |
| 1 | `network_unreachable` | known | true | `retry` | no request byte reached the wire; nothing landed |
| 1 | `no_access_or_not_found` | known | false | `ask-user` | GitHub turned down a token we *had* |
| 1 | `rejected_by_endpoint` | known | false | `fix-args` | the endpoint refused this file or this request |
| 1 | `internal_error` | **unknown** | false | `report-to-human` | a bug in this tool; where it stopped is not known |
| 2 | `bad_args` | known | false | `fix-args` | malformed invocation, or a file over the policy size limit |
| 2 | `bad_key` | known | false | `fix-args` | `--key` is not a valid key |
| 2 | `unsupported_extension` | known | false | `fix-args` | not a file type GitHub takes as an attachment |
| 2 | `body_budget_exceeded` | known | false | `fix-args` | the comment would exceed the body budget: fewer files, shorter caption |
| 2 | `ledger_capacity_exceeded` | known | false | `fix-args` | the batch needs more than 64 ledger entries. Split it |
| 2 | `repo_not_inferable` | known | false | `fix-args` | no git remote to infer a repository from. Pass `--repo` |
| 2 | `repo_ambiguous` | known | false | `fix-args` | several remotes and no `origin`. Pass `--repo` |
| 2 | `journal_not_writable` | known | false | `fix-environment` | `.easy-cast/` cannot be written. Without the journal, a repeat means duplicates |
| 2 | `identity_mismatch` | known | false | `fix-environment` | the upload token and `gh` act as different accounts |
| 2 | `token_not_found` | known | false | `fix-environment` | no credential at all. `gh auth login`, or set `GH_TOKEN` |
| 3 | `target_not_found` | known | false | `ask-user` | no such pull request, issue or repository — §9 |
| 4 | `partial_upload_retryable` | **mixed** | true | `retry` | some files landed, the rest failed transport-level. **Repeat it** |
| 4 | `partial_upload_blocked` | **mixed** | false | `report-to-human` | some files landed and at least one ended unknown. **Never repeat** |
| 4 | `unresolved_backlog` | known | false | `report-to-human` | recorded uploads that could not be written into a comment |
| 5 | `endpoint_unavailable` | **unknown** | false | `report-to-human` | the endpoint could not be spoken to, or answered something unclassifiable. **Never repeat** |
| 6 | `refused_public` | known | false | `ask-user` | public repository, no `--allow-public` — §10 |
| 7 | `plan_mismatch` | known | false | `request-plan` | the plan changed since the token was issued; `planContext.changed` says what |
| 7 | `plan_missing` | known | false | `request-plan` | a real upload without `--confirm-plan=<token>` |

Two notes on reading it:

- On a batch, run-level `state` and `retryable` are **folded from the individual files**, not copied
  from this table: `mixed` when some succeeded and some did not, `unknown` when any file's outcome is
  unknown, and `retryable: false` the moment the comment's visible content was touched. `nextAction`
  is not folded — it always comes from the pair.
- `unresolved_backlog` is part of the contract but no current code path emits it: a backlog is
  *repaired* by the next real `attach` rather than turned into a refusal. If it ever appears, treat
  it as what it says — `report-to-human`.

## What is never repeated, and why

An uploaded attachment cannot be deleted. That single fact decides the whole retry policy: repeating
a run is only safe when the tool **knows** the bytes never arrived.

| Never repeat automatically | Because |
| --- | --- |
| `5` / `endpoint_unavailable` | the request may have been received and answered in a way the classifier could not read. The server may hold the asset already; a repeat creates a second one, permanently |
| `4` / `partial_upload_blocked` | at least one file's outcome is unknown, for the same reason. The files that *did* land are safe — their URLs are in the journal — but the unknown one poisons the repeat |
| `1` / `internal_error` | the tool does not know where it stopped, so it cannot claim the remote side is untouched |

`1` / `network_unreachable` and `4` / `partial_upload_retryable` are the two that may be repeated.
Both mean the same thing underneath: every failure is transport-level and no request byte reached
the wire, so nothing can have landed. On the repeat, the tool first performs its repair step —
writing locally recorded URLs into the comment — and then reuses, rather than re-uploads, every file
whose digest it already knows. Repeating those two is not merely permitted; it is how the job
finishes.

**Never invent a retry policy of your own.** No backoff loop, no "try three times", no re-running a
failed command with different flags to see what happens. Two pairs say `retry`; everything else does
not.

## Saying it to a person

Report the fact, the consequence and the one thing you need from them. Not the exit code on its own —
nobody outside this document knows what a 4 is.

| Pair | How to phrase it |
| --- | --- |
| `0` / `ok` | "Attached `<file>` to `<comment url>`. The direct asset link stays 404 until the comment renders it — that is expected." |
| `0` / `dry_run` | "Plan only — nothing was uploaded. It would upload `<files>` to `<owner/repo>#<n>`." Then continue; a dry run is not a result to report and stop on |
| `1` / `no_access_or_not_found` | "GitHub refused the credential for `<owner/repo>`. The account is `<login>` — does it have access to that repository?" |
| `1` / `rejected_by_endpoint` | "GitHub refused the file itself: `<message>`. Nothing was uploaded." Then fix the call — do not repeat it |
| `1` / `internal_error` | "The tool failed internally and cannot tell whether anything reached GitHub: `<message>`. I have not re-run it — a repeat could create a duplicate attachment that cannot be deleted. Check `<journalPath>` and the target before trying again." |
| `2` / `token_not_found` | "No GitHub credential available. Run `gh auth login`, or set `GH_TOKEN`. `GITHUB_TOKEN` is deliberately not read." |
| `2` / `identity_mismatch` | "The upload token acts as `<a>` but `gh` acts as `<b>`. Nothing was uploaded — the attachment would have been permanently attributed to an account you did not name." |
| `2` / `journal_not_writable` | "`.easy-cast/` is not writable, so there is no deduplication record. I stopped: without it, a repeat uploads the same file again, permanently." |
| `2` / `ledger_capacity_exceeded`, `body_budget_exceeded` | "Too much for one comment (`<detail>`). Nothing was uploaded. Split it into two attach calls?" |
| `3` / `target_not_found` | §9 — a question, with the repository and branch in it |
| `4` / `partial_upload_retryable` | "`<n>` of `<m>` files uploaded; the rest failed on the network. Re-running is safe and reuses what already uploaded — doing that now." Then do it |
| `4` / `partial_upload_blocked` | "`<n>` files uploaded permanently; `<k>` ended in an unknown state. I have **not** re-run it — a repeat could duplicate an attachment that cannot be deleted. The uploaded URLs are recorded in `<journalPath>`." |
| `5` / `endpoint_unavailable` | "The upload endpoint could not be reached, or answered something the tool cannot interpret. Whether the file was accepted is unknown, so I have not retried: a repeat could create a permanent duplicate." |
| `6` / `refused_public` | §10 — the irreversibility first, then the question |
| `7` / `plan_mismatch` | not a question for a human. `planContext.changed` names what moved; get a fresh plan and continue |

## `recovery.pending` — URLs with nothing pointing at them

`recovery.pending` lists uploads that **exist on GitHub** but that no comment references yet: the
bytes went up, the URL was recorded locally, and the comment write failed afterwards. Each entry
carries its `scope` (`owner`, `repo`, `kind`, `number`, `key`), the `digest` and the `url`.

It is not a curiosity. An asset with nothing pointing at it exists forever and is invisible to
anyone reading the thread — and a later run that could not see the record would upload the same
bytes again, permanently.

| Field | Meaning |
| --- | --- |
| `recovery.journalPath` | where the write-ahead journal lives. Deduplication is bound to this directory |
| `recovery.journalPersisted` | the URL was recorded locally before anything was written to GitHub |
| `recovery.commentLedgerPersisted` | `false` means the comment does not yet reference everything that was uploaded |
| `recovery.repaired` | this run wrote a previous backlog into the comment |
| `recovery.pending` | what is still unreferenced, per scope |

**The fix is to re-run the same `attach` command for the same target.** Repair is the first
stateful step of a real `attach` run: it writes the recorded URLs into the comment and marks them
synced, and it uploads nothing while doing so. `easy-cast recover` *reports* the backlog but never
repairs it — it has no target to repair against.

If the backlog belongs to a target you no longer intend to post to, say so to a person rather than
silently leaving it: the assets are already permanent, and only a human can decide whether the
comment should exist at all.

## Where the journal lives, and what happens without it

Deduplication state is `journal.jsonl` under `.easy-cast/` **in the directory the command ran from**
(`recovery.journalPath` in every JSON output). `.gitignore` excludes only `.easy-cast/tmp/`, so the
journal *can* be committed, and `.gitattributes` sets `merge=union` on it so a merge keeps records
from both sides. Whether to commit it is the user's decision — and it is a real one:

| Situation | Consequence |
| --- | --- |
| Journal committed | deduplication travels with the repository, to other machines and other clones |
| Journal not committed | another machine, CI, a run from a different directory, or `rm -rf .easy-cast` all mean **no deduplication** — and a repeat then uploads the same bytes again, permanently |

The comment's own ledger covers the same ground for the same target, so the loss is not total, but
it caps out: it holds 64 entries, most-recently-used first, and beyond that the least recently used
is evicted. An evicted file that is attached again costs one more irreversible upload.

## What the tool does not guarantee

Stated in full, because each line is a way an agent can spend something that cannot be spent back.
The same list is in the project README; it is repeated here so that handling a failure never
requires leaving the skill.

| Not guaranteed | What it costs when you assume otherwise |
| --- | --- |
| **Deletion of an uploaded asset — never, under any exit code** | everything below follows from this one |
| **That a human saw the file** | `--confirm-plan` proves the plan matched, not consent — §4 |
| **That a plan was ever shown at all** | the token is deterministic and computable without running `--dry-run`. Execution matches the plan; the plan being demonstrated to anybody is not proven — §4 |
| **That the repository was inferred as you intended** (D2″/DG5) | the repository comes from the git remote of the directory the command ran in. The wrong directory is an irreversible upload into a different repository. The resolved `owner/repo` and the basis of the inference are printed on every inference, but nothing forces anyone to read them. `--repo` removes the class of error outright — §9 |
| **Idempotency under concurrent runs** | the behaviour is pinned by a test, not fixed. Do not run two `attach` calls against one target at once |
| **Reuse across targets or across `--key` values** | deduplication is scoped to `(owner, repo, kind, number, key)`. Attaching the same file to a second issue uploads it again. `upload` does not deduplicate at all |
| **Preservation of someone else's markdown** | on the compose path the comment body is overwritten whole; on the ledger-only path preservation is incidental, not promised (D15′). Never point this tool at a comment a person edits by hand |
| **Correct behaviour with several of the tool's own comments carrying one marker** | the oldest is rewritten; the others stay visible with stale URLs and their ledgers are not read — on another machine that costs one irreversible re-upload |
| **A journal that follows the work** | it lives under `.easy-cast/` in the directory the command ran in. `.gitignore` excludes only `.easy-cast/tmp/`, so `journal.jsonl` **can be committed and then travels with the repository** (`.gitattributes` sets `merge=union` on it). Uncommitted, it means no deduplication on another machine, in CI, from another directory, or after `rm -rf .easy-cast`. Whether to commit it is the user's decision, and **saying so is this skill's job** |
| **Atomicity of `O_APPEND` on network filesystems** | NFS or a networked `$HOME` may lose or interleave journal records; the test is green on a local filesystem only |
| **Stability across `--no-convert`** | toggling it on and off costs one irreversible upload — the conversion profile is part of the deduplication key |
| **Ledger capacity past 64 distinct files** | eviction costs one irreversible upload; on the same machine the local journal softens it |
| **The correctness of any interpretation of the endpoint until Stage 0 completes** | including the 404-until-quoted behaviour in §7 and the private-asset reachability question (DG4) in §10 |

# Requirements on the CLI derived from the skill

Writing the skill is the first time the CLI surface is used by its actual consumer. Every question the
skill could not answer from the surface as planned is recorded here as a requirement — or as an
explicit rejection with a reason.

**Governing rule.** Every row below is `closed` or `rejected` **before US-016 (WP-13) closes**. An
open row at that point blocks WP-13; it is not a nice-to-have. The surface freezes with WP-13, and a
requirement discovered after the freeze costs a breaking change.

| Status | Meaning |
| --- | --- |
| `open` | the surface does not answer it yet; someone must decide |
| `closed` | satisfied by an acceptance criterion of the named story — the criterion is the evidence |
| `rejected` | deliberately not done; the reason is recorded, and the skill compensates |

Source of each row: the skill section that hit the question. `§n` refers to `skills/easy-cast/SKILL.md`.

---

## Open

- [x] **R1 — `attach` prints, in its own output, that the URL does not resolve until it is quoted.**
      Owner: **US-016** (WP-13). Source: §7 (WP-14b), reached while writing §4.
      An agent that just published will verify its work. A `GET` on a fresh attachment URL was
      observed to return `404` until the URL is cited in rendered markdown — an observation pending
      confirmation in S0 — so the agent concludes the upload failed and loops on reloads — or, worse, uploads again, irreversibly. The skill will say this in §7, but
      §7 only helps an agent that loaded the skill. The one channel every caller sees is the command's
      own output. Decide: does success output carry the sentence, or does the skill carry it alone?

- [x] **R2 — exit 3 (`target_not_found`) JSON carries enough to ask a useful question.**
      Owner: **US-016**, with **US-011**. Source: §9 (WP-14b), reached while writing §1.
      The contract currently mandates `branch` on exit 3. To put a real question in front of the user
      the agent also needs: which repository was resolved and on what basis (`target.owner`,
      `target.repo`, `target.repoSource`), and confirmation that nothing was created
      (`assetsCreated: 0`). Without the repository the agent cannot even phrase "no pull request for
      `feature/x` in `acme/web`" — and the resolved repository is exactly the thing D2″/DG5 says the
      caller must be shown. Proposal: exit 3 returns `target` (minus `kind`/`number`) alongside
      `branch`.

- [x] **R3 — `--dry-run` reports per-file source size and the size verdict.**
      Owner: **US-016**, with **US-004**. Source: §5 and `references/recording.md`.
      For video, `--dry-run` returns `plannedAction: 'unknown'` because conversion is not performed.
      The skill tells the agent to settle length and viewport *before* recording again, but the agent
      has no size signal at plan time — the first time it learns a file is too large is a failed real
      run, and a failed real run is not free if other files in the batch already uploaded. Proposal:
      `uploaded[].sourceBytes` plus the `checkSize` level (`ok` / `warn` / `reject`) in dry-run
      output.

- [x] **R4 — availability of `ffmpeg` is observable from the CLI.**
      Owner: **US-016**, with **US-006**. Source: `references/sanitizing.md`.
      The mandatory review of a video is done by extracting frames, which needs `ffmpeg`. The skill
      therefore branches: no `ffmpeg` → the video cannot be reviewed → do not publish a video, publish
      screenshots. The CLI already probes `ffmpeg` for conversion, so the agent should not have to
      probe it a second time by other means. Proposal: a boolean in `--dry-run` output.

- [x] **R5 — exit 6 (`refused_public`) states the irreversibility in the message the agent will relay.**
      Owner: **US-016**, with **US-024** (§10). Source: §2, §4.
      Consent for a public repository is collected before the bytes leave. The agent asks the user;
      the user's decision is only informed if the question contains the fact that the attachment
      cannot be withdrawn. If the message says only "public repository, pass `--allow-public`", the
      agent will relay exactly that, and the consent is uninformed. Proposal: the exit-6 `message`
      names irreversibility explicitly.

- [x] **R6 — the human-readable plan text has an owner.**
      Owner: **US-016**. Source: §4.
      `--confirm-plan` proves the execution matches the fingerprint and nothing else — not that a plan
      was rendered, not that anybody read it. So the rendering is the only part of the handshake with
      any human value, and right now nobody owns it: the JSON is a machine contract, and the skill
      does not specify what the agent prints. Decide one of: (a) `--dry-run` emits a human-facing plan
      block on stderr; (b) the skill prescribes the exact text the agent shows. Not both, and not
      neither.

## Closed

- [x] **R7 — `--caption` and `--key` survive hostile text without breaking the marker.**
      Owner: **US-013** (WP-10b). Closed by its acceptance criterion: `--key` and caption containing
      `-->`, newlines and markdown are escaped, and the marker stays intact. The skill invites free
      text in captions, so this is load-bearing for it.

- [x] **R8 — a video renders as GitHub's native player.**
      Owner: **US-007** (WP-6). Closed by its acceptance criterion: video is emitted as a bare URL on
      its own line, images as `![escaped](url)`. §1 of the skill promises "a video of a flow"; that
      promise is this criterion.

- [x] **R9 — the resolved `owner/repo` and the basis of the inference reach the caller.**
      Owner: **US-011** (WP-9) and **US-016**. Closed: `target.repoSource` is in the JSON contract and
      the resolved repository is printed to stderr whenever `repoSource !== 'flag'`. The residual risk
      — that nobody looks at either — stays in the "not guaranteed" list, where it belongs; it is not
      a CLI requirement.

- [x] **R10 — the journal location is discoverable.**
      Owner: **US-009** (WP-7b) and **US-016**. Closed: `recovery.journalPath` is in the JSON
      contract. The skill needs it to tell an agent where deduplication state lives and what is lost
      when the directory is not the one the previous run used.

## Rejected

- [x] **R11 — a `reviewed` / `confirmed-by-human` field in the JSON output.** Owner: **US-016**.
      **Rejected.** The CLI cannot observe whether anybody looked at a file, and P2 forbids asserting
      what cannot be verified — the whole point of the `--confirm-plan` wording is that a deterministic
      token proves matching, not consent. A field named `reviewed` would be read as evidence of
      review by every consumer that saw it. The obligation lives in §4 of the skill and nowhere in the
      CLI, and the skill says so in as many words.

- [x] **R12 — a capture subcommand in `easy-cast` (screenshot / record wrappers).** Owner: **US-016**.
      **Rejected** by decision 1: capture and annotation are solved by `playwright-cli`, and this tool
      is the delivery step only. Recorded here because §5, §6 and §11 of the skill all describe
      capture work, and the shortest reading of that is "put it in the CLI". It stays out: a second
      capture surface would compete with `playwright-cli` for the same job and drift from it.

## Resolution — US-016 (WP-13), 2026-08-16

All six open rows were closed while freezing the CLI surface. What each one became:

| Row | How it was closed |
| --- | --- |
| R1 | `notes[]` in the JSON output, and a paragraph in the human output, whenever a comment was actually written. The text is `URL_NOT_LIVE_UNTIL_QUOTED` in `src/output.ts`, so there is one wording rather than several. Tested both ways: present when a comment exists, absent when the write failed. |
| R2 | Exit 3 now carries `target.owner`, `target.repo` and `target.repoSource` alongside `branch`. Without the repository *and how it was chosen*, an agent cannot ask a question worth answering — "no pull request found" is useless if the wrong repository was inferred. |
| R3 | `uploaded[].sizeBytes` and `uploaded[].sizeVerdict` on the dry-run plan, and the size in the human plan with an explicit marker when it is over GitHub's documented threshold. |
| R4 | `environment.ffmpegAvailable` on the dry-run plan, plus a line in the human plan saying whether video will be converted or uploaded as-is. It changes what actually gets uploaded, so a plan that omits it cannot be judged. |
| R5 | The `refused_public` message states that an uploaded attachment can never be deleted, in the message the agent relays — not only in the docs. |
| R6 | **The CLI owns it.** `human()` in `src/cli.ts` renders the dry-run plan: repository and how it was inferred, every file with size and verdict, the conversion situation, then the token. This was the row that mattered most — if nobody rendered a plan, `--confirm-plan` would be two automated calls with nothing shown in between, which is precisely the failure P2 already concedes it cannot prevent. |

R11 (a `reviewed` field) and R12 (a capture subcommand) remain rejected, for the reasons recorded above.

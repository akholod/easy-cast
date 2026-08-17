---
name: easy-cast
description: Attach visual proof to a GitHub issue or pull request — a screenshot of layout, a video of a flow, a before/after pair. Use when the change or the bug is visible to the eye and describes poorly in prose.
---

# Visual proof on an issue or PR

`easy-cast` takes a file that already exists on disk, uploads it, and posts it into a comment the tool
owns. Capture is not its job: the `playwright-cli` skill records the screenshot or the video,
`easy-cast` delivers it.

`easy-cast --help` is the source of truth for commands and flags. This file does not repeat it. It
covers only the decisions that go wrong when nobody states them.

Shape of a run:

1. decide whether anything should be attached at all — §1;
2. capture on sanitised data — §2, §3, §5;
3. **open the finished file and look at it** — §4;
4. get the plan, then attach.

**An uploaded attachment cannot be deleted — ever.** Deleting the comment does not delete the asset;
it stays reachable at its own URL. Every rule below follows from that one fact.

---

## 1. Whether to attach at all

Agents fail in both directions: some never attach anything, some put a video in every pull request.
Both are wrong, and the second is worse — it trains reviewers to skip the attachments.

| What the change is | Attach | Why |
| --- | --- | --- |
| Layout, styling, a static screen, an empty or error state | one screenshot | a still shows all of it |
| A flow, an interaction, an animation, anything with timing | one short video | a still cannot show a transition |
| A difference that only reads as a difference | two screenshots, before then after, same viewport | the reviewer compares, and cannot compare against memory |
| A visual bug being reported | screenshot, or video if it needs a sequence to appear | prose reproduction steps for a layout bug are rarely reproducible |
| Backend, refactor, config, dependency bump, docs, test-only | nothing | there is nothing to look at |

Cost, plainly: **a video costs a reviewer a minute of attention; a screenshot costs a second.** When
both would work, the screenshot wins. **Default to a screenshot.**

Two more rules that follow:

- One artifact per point. Three screenshots of the same page from slightly different scroll positions
  is not thoroughness, it is noise.
- Before/after only when the two frames differ in the thing under discussion. Two screenshots that
  differ in a timestamp, a random avatar and the change make the reviewer hunt for the change.

Attaching nothing is the correct answer for most pull requests. Say what you did in prose and stop.

---

## 2. Record on sanitised data

Sanitised data is the **primary** defence. Masking is not (§3), and neither is care during review (§4)
— those are the second and third lines behind this one.

The demonstration scenario runs on a **test account with fictional data**. Production data in frame is
a defect in the scenario, to be fixed by re-recording — not something to paint over. The upload is
irreversible, so "we will remove it later" does not exist as an option.

Where real data gets into a frame that was supposed to be clean:

| Source | Fix |
| --- | --- |
| The logged-in account — display name, avatar, email in the account menu | a test account with a fictional name |
| Seed data copied from production into staging | a fixture set written for the demo; a staging box carrying a copy of prod data **is** production |
| The browser profile — autofill, saved passwords, other tabs, bookmarks bar | a fresh in-memory session, never your own profile (`playwright-cli` sessions default to in-memory) |
| The URL bar — signed links, `?token=`, `?jwt=`, internal hostnames | navigate to a clean URL before recording starts |
| DevTools panels or a request log left open | close them before capture |
| Notification toasts and desktop chrome | record the page, not the desktop |

Visibility of the result is not a defence either, and Stage 0 settled why. The URL the tool prints
never serves the image to anyone; GitHub substitutes a short-lived signed URL when it *renders* the
comment, and that signed URL works with no credentials at all. So access follows **who can read the
comment**, not which repository the file was uploaded against — an asset uploaded against a private
repository and quoted in a public issue was fetched anonymously during the probe.

The practical rule: a URL that leaves a private comment for a public one is public from that moment,
and nothing here can prevent or detect it. Never promise anyone "a public link", never treat a private
target as proof of privacy, and treat every uploaded frame as readable by a stranger.

Details and a re-usable checklist: [references/sanitizing.md](references/sanitizing.md).

---

## 3. Masks are the second line, and they leak

Playwright's `mask` paints over a region **at capture time**. That works when the frame never moves.
A video moves: it scrolls, it opens a menu, it re-lays out on a resize. What was covered in frame 1
is exposed in frame 5, and the mask has no idea.

| Artifact | Does the mask hold? | What actually protects it |
| --- | --- | --- |
| Screenshot, fixed viewport | yes — the region is measured and painted once, and the frame never moves | sanitised data, then `mask` |
| Screenshot, full-page or scrolling capture | partly — measured once against a layout that scrolls under it | sanitised data, then verify the finished PNG |
| Video | **no** | sanitised data **plus** eyes on the finished file |

Corollaries worth stating:

- A mask is destructive and one-way. It cannot be removed from the produced file, and its presence
  cannot be verified later by anything except looking.
- A CSS overlay drawn with `showOverlay` is not a mask. It is frame-local decoration that scrolls
  away exactly like the content underneath it.
- There is no post-hoc blur step in this toolchain. If the finished file has something in it, the
  answer is re-record, not retouch.

For masking syntax and thresholds in visual regression tests, use the `playwright-best-practices`
skill — it covers masking volatile content, disabling animations and diff thresholds in full.

---

## 4. Mandatory review before sending

**Open the finished file and look at it. Every time.**

| Artifact | How to review it |
| --- | --- |
| Screenshot | read the PNG directly — you can see images |
| Video | extract frames and read them; see [references/sanitizing.md](references/sanitizing.md) |

What you are looking for:

- tokens, JWTs, session ids, `?token=` / `?jwt=` / `?sig=` in any visible URL;
- email addresses, real customer names, real employee names;
- internal hostnames, ticket ids belonging to someone else, unrelated open tabs;
- anything you would not paste into the pull request description as plain text.

Checking the first and last frame is **not** a review. Exposure usually happens in the middle, at the
moment the page scrolled or a menu opened.

### `--confirm-plan` does not prove anything was reviewed

`--confirm-plan` binds the upload to a plan and does nothing else. Specifically, the token proves
that what leaves the machine is exactly: those source bytes (identified by hash), in that order, to
that target, under that conversion policy. That is the whole of it.

It does **not** prove:

| Claim | Why the token cannot carry it |
| --- | --- |
| "`--dry-run` was executed" | the token is deterministic — it is computable from the plan without ever running `--dry-run` |
| "a plan was shown to someone" | nothing about display is an input to the token |
| "a human agreed" | consent is not observable by a CLI |
| "the file was looked at" | the token is computed over bytes, not over pixels anybody saw |

So an agent can pass both calls automatically and satisfy the CLI completely while having seen
nothing. **Publishing without looking at the file is forbidden by this skill, and the CLI cannot
enforce it.** The check exists in exactly one place: you actually open the file.

Order matters. Look at the file **before** requesting the plan. After the upload, nothing can be
taken back — not by deleting the comment, not by re-running with different arguments, not by any
flag.

---

## 5. How to record a watchable scenario

Scripts written for speed produce two seconds of unreadable smear. A reviewer-facing recording is
paced for a human eye, and that is a different job from a test.

| Setting | Value | Why |
| --- | --- | --- |
| Opening pause | ~700 ms after the first paint | the player's first frame becomes the poster; a mid-navigation frame makes a useless thumbnail |
| Typing | `pressSequentially(text, { delay: 60 })` | `fill()` is instantaneous and reads as a rendering glitch |
| Between steps | `waitForTimeout(800–1200)` | a click and its result must not land in the same perceived instant |
| Meaningful transitions | `page.screencast.showChapter(title, { description, duration })` | tells the reviewer what they are about to watch |
| Viewport width | **1000–1280**, not 1920 | GitHub's inline player downscales; at 1920 the text is unreadable |
| Length | seconds, not minutes | see §1 on the cost of a video |

Record the whole scenario as **one script** through `run-code`, not as a sequence of separate CLI
invocations — process-per-step recording puts dead air of unpredictable length between every action.

Full skeleton, chapter placement and the reviewer-versus-test differences:
[references/recording.md](references/recording.md). For the screencast and overlay API itself, use
the `playwright-cli` skill's video-recording reference — it is not duplicated here.

---

## 6. Annotations need a setup step

An overlay box drawn around an element needs `boundingBox()`; `boundingBox()` needs a locator; the
locator needs a snapshot to be chosen from. Nothing in the API hints at that chain, so an agent that
is not told it simply never annotates anything. Here is the chain, whole:

```js
// playwright-cli run-code --filename=annotate.js
async page => {
  // 1. locator — from the snapshot you already took, by role/name, not by ref
  const target = page.getByRole('button', { name: 'Save changes' });

  // 2. make it visible, because a box off-screen is not measurable
  await target.scrollIntoViewIfNeeded();

  // 3. measure — viewport-relative, and null when the element is not visible
  const box = await target.boundingBox();
  if (!box) throw new Error('no bounding box: element is not visible');

  // 4. draw at those coordinates
  await page.screencast.showOverlay(`
    <div style="position:absolute; left:${box.x - 4}px; top:${box.y - 4}px;
      width:${box.width + 8}px; height:${box.height + 8}px;
      border:2px solid #d73a49; border-radius:6px;"></div>
    <div style="position:absolute; left:${box.x + box.width / 2}px;
      top:${box.y + box.height + 10}px; transform:translateX(-50%);
      padding:4px 10px; background:#24292f; color:#fff; border-radius:6px;
      font:13px system-ui;">Did nothing before this change</div>
  `, { duration: 2500 });
}
```

Two facts that break annotations if you do not know them:

- Coordinates are **viewport-relative and instantaneous**. Scroll after measuring and the box stays
  where the element used to be. Measure again after every scroll.
- Overlays are `pointer-events: none`, so a sticky overlay can stay up while you keep clicking. Hold
  the handle and call `dispose()` when the point has been made.

More recipes — arrow, before/after label, sticky status badge, multi-element callout:
[references/annotations.md](references/annotations.md).

---

## 7. The link is dead at first, and that is normal

A freshly uploaded attachment URL answers **404** until something quotes it in rendered markdown.
The comment the tool just wrote is what activates it. Nothing failed.

The CLI now says this itself: on every run that actually wrote a comment, the JSON carries the
sentence in `notes[]` and the human output prints it as its own paragraph. This section exists
anyway, because the note only helps a caller who reads it, and because the *reason* is what stops
the damage.

An agent that has just published will verify its work. It `GET`s the asset URL, receives 404,
concludes the upload failed, and uploads again. **Every one of those re-uploads is permanent.** The
loop costs one irreversible asset per iteration, and nothing cleans up afterwards.

| After a successful `attach` | Do | Do not |
| --- | --- | --- |
| Confirming it worked | read `exitCode: 0`, `comment.url` and `uploaded[].status` | `GET` the asset URL |
| Looking at the result | open `comment.url` — the rendered comment is where the asset is live | open the asset URL on its own |
| Seeing a 404 on the asset URL | treat it as expected and say so | re-run, re-upload, or report a failure |

Status of the claim: **established by Stage 0**, and stronger than "until quoted". The asset URL
answers 404 to a direct fetch *permanently* — before citation and after it, in private repositories
and public ones alike. It is not a link that becomes live; it is an identifier. GitHub serves the
image by substituting a short-lived signed URL when it renders the comment, so `comment.url` is the
only place the picture exists. A 404 on the asset URL is never evidence of anything having failed.

---

## 8. Read the pair, not the code

The exit code alone does not say what to do. Code 1 covers both "the network was down, repeat it"
and "the endpoint refused this file, change the arguments". Code 4 covers both a partial upload that
is safe to repeat and one that is not. What decides the next step is the **pair**
`(exitCode, reason)` — and the CLI has already resolved that pair for you into `nextAction`.

**`nextAction` is authoritative. Act on it, not on the exit code.**

| `nextAction` | What it means for you |
| --- | --- |
| `done` | finished — report what was attached |
| `request-plan` | run the same command with `--dry-run --json`, then pass the token back as `--confirm-plan=<token>` |
| `fix-args` | the call is wrong; change the arguments. Re-running unchanged fails identically |
| `fix-environment` | the arguments are fine; a credential, a directory or a permission has to change first |
| `ask-user` | a person has to answer something — §9 and §10 |
| `retry` | repeating the identical command is safe |
| `report-to-human` | stop, report, and do not re-run |

### The two rules that cost the most when reversed

| Pair | Repeat it? | Why |
| --- | --- | --- |
| `5` / `endpoint_unavailable` | **never** | `state` is `unknown` — the server may have accepted the bytes. A repeat can create a second attachment nobody can delete |
| `4` / `partial_upload_blocked` | **never** | at least one file ended in an unknown state, for exactly the same reason |
| `4` / `partial_upload_retryable` | **yes — and you should** | every failure was transport-level and known not to have landed |

Why `partial_upload_retryable` is safe rather than merely tolerable: re-running the same command
performs the repair step first — the URLs already recorded locally are written into the comment —
and every file whose digest is already in the ledger or the journal is **reused, not uploaded
again**. The repeat costs nothing irreversible and finishes the job.

Both directions of this mistake are expensive. Retrying a blocked run buys a permanent duplicate.
Refusing to retry a retryable one leaves a comment half-written and a backlog unresolved, for no
gain at all.

Two habits that follow:

- Never wrap this CLI in a generic retry-with-backoff. The only pairs that may be repeated
  automatically are the two that say `nextAction: 'retry'`.
- Never decide from `exitCode` and a substring of the message. Parse `--json` and read the pair.

The full pair-by-pair table — all 25 of them, with the wording to use when reporting each one to a
person — is [references/failures.md](references/failures.md). Read it before writing any error
handling around this tool.

---

## 9. No pull request or issue — ask, do not invent

Exit **3**, `target_not_found`. Three situations reach it:

| What happened | What the JSON gives you |
| --- | --- |
| `--to pr`, and the current branch has no open pull request | `branch`, plus `target.owner`, `target.repo`, `target.repoSource` |
| `--to pr:<n>` or `--to issue:<n>`, and that number is not there | `target.owner`, `target.repo`, and the number |
| The repository itself is not visible to this token | `target.owner`, `target.repo`, `target.repoSource` |

**The tool never opens a pull request, never opens an issue, and never picks a neighbouring
number.** `assetsCreated` is `0` — nothing was created. That is not a gap to work around: a guessed
target is an irreversible upload onto somebody else's thread.

Ask one question, with `AskUserQuestion`, built from what the JSON handed you — the repository and
the branch are exactly what make the question answerable:

> No open pull request for branch `feature/checkout-fix` in `acme/web` (repository inferred from the
> git remote of this directory). Where should the recording go?
> — Open the pull request first, then attach · Attach to an existing issue (which number?) · Do not
> attach

A wrong `target.repoSource` is a different question, and a more urgent one. `origin` and
`sole-remote` both mean the repository was inferred from the git remote of the directory the command
ran in. If the repository named back is not the one you meant, **the working directory was wrong** —
ask about that, and do not re-run with a guessed `--repo` until a person has confirmed it. An upload
into the wrong repository is as permanent as any other.

---

## 10. A public repository needs its own consent

Exit **6**, `refused_public`: the target repository is public and `--allow-public` was not passed.
Nothing was uploaded. The refusal lands before a single byte moves, because that is the only moment
at which refusing is still free.

**Do not add `--allow-public` yourself.** It is not a flag that clears an error; it is the record of
a decision that cannot be revisited. Ask — and the question has to carry the fact that makes it a
real question:

> `acme/docs` is a public repository, and an uploaded attachment can never be deleted — not by
> deleting the comment, not by any flag. The file is `checkout-flow.mp4`; it shows the checkout form
> with the test account's fictional card details on screen. Publish it there?
> — Publish · Do not publish · Attach to a private target instead

Say the irreversibility **before** asking for the answer, not after it. The CLI's own exit-6 message
already states it, so relaying that message is enough on its own.

What this gate does **not** establish, now that Stage 0 has answered it: the asset is not protected by
the repository it was uploaded against. Access follows who can read the *comment*, because GitHub
hands anyone who can see that comment a working signed link. The gate is meaningful for `attach` only
because `attach` posts into the same repository it uploaded against, so the two audiences coincide.

The moment a URL is copied somewhere more public, the file is as public as its new home. A private
target is therefore not proof of privacy, and §2 stands unchanged: let the file's contents — not the
repository's visibility — decide whether it may be published.

---

## 11. A screenshot as feedback to yourself

Separate use, same tool, no upload involved: **you can read the image you just captured.** A DOM
snapshot tells you what exists; the screenshot tells you what a person would see.

```bash
playwright-cli screenshot --filename=check.png
# then read check.png
```

| Question | DOM snapshot | Screenshot |
| --- | --- | --- |
| Does the element exist? | yes | — |
| Would a person see it? | no — `opacity: 0`, white-on-white and a z-index of -1 all read as "present" | yes |
| Is the spacing right? | no | yes |
| Did a modal or a sticky header cover it? | rarely | yes |
| Is the text truncated or wrapped badly? | no | yes |
| Did the font or the icon actually load? | no | yes |

Make this the default loop before claiming a visual change works: capture, read, judge, fix. It is
local, it costs nothing irreversible, and it replaces guessing from a snapshot.

This is self-verification, not communication. A screenshot taken to check your own work does not
become an attachment just because it exists — §1 still decides that.

---

## References

| File | Read it when |
| --- | --- |
| [references/recording.md](references/recording.md) | recording video |
| [references/annotations.md](references/annotations.md) | the frame needs a callout, a box or a label |
| [references/sanitizing.md](references/sanitizing.md) | the app is logged in, the data is not obviously fictional, or the repository is public |
| [references/failures.md](references/failures.md) | the command exited non-zero, or you are writing error handling around it |
| [references/visual-reports.md](references/visual-reports.md) | — not yet; iteration 2 |

Neighbouring skills, by name — never by path, because the path differs per machine and the name does
not:

| Skill | What to get from it |
| --- | --- |
| `playwright-cli` | capture, sessions, `run-code`, the screencast and overlay API |
| `playwright-best-practices` | writing visual regression tests: masking volatile content, disabling animations, diff thresholds |

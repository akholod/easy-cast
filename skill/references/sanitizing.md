# Keeping data out of the frame

An uploaded attachment **cannot be deleted — ever**. Removing the markdown, editing the comment,
deleting the comment, closing the issue: none of them remove the asset, which stays reachable at its
own URL. That single fact fixes the order of defences:

| Line | Mechanism | Strength |
| --- | --- | --- |
| 1 | The scenario runs on a test account with fictional data | the only one that removes the problem instead of covering it |
| 2 | `mask` on a static screenshot | covers a fixed region of a frame that never moves |
| 3 | Reviewing the finished file before publishing | catches what the first two missed |
| — | Deleting it afterwards | **does not exist** |

## Line 1 — a sanitised run

Production data in frame is a defect in the scenario. The fix is to re-record, not to paint over.

| Ingredient | What it means concretely |
| --- | --- |
| Test account | a fictional display name, a fictional email, a fictional avatar — an account created for demonstrating, not a real person's account with a nickname |
| Fictional records | fixtures written for the demo; realistic in shape, invented in content |
| Fresh browser session | in-memory profile, no autofill, no saved passwords, no other tabs, no bookmarks bar; `playwright-cli` sessions are in-memory unless `--persistent` is passed |
| Clean entry URL | navigate to the plain URL before recording starts, never to a signed or token-carrying link |
| A staging box with a copy of production | **is production.** Treat it as such |
| Closed developer tools | no request log, no console, no storage inspector in frame |

Storage state deserves its own line: loading a saved `state.json` to skip a login is exactly how a
real session and a real account end up in a demonstration. Log in as the test account inside the
scenario, or load storage state that belongs to the test account only.

## Line 2 — `mask`, and where it stops working

`mask` paints over a region **at capture time**, once, at coordinates measured once.

| Artifact | Holds? | Why |
| --- | --- | --- |
| Screenshot, fixed viewport | yes | the region is measured and painted while the frame is still |
| Screenshot, full-page or scrolling | partly | measured once against a layout that moves underneath |
| Video | **no** | what is covered in frame 1 is exposed in frame 5, and the mask does not follow |

Consequences:

- The mask is baked into the produced file. It cannot be undone, and its presence cannot be verified
  by anything except looking at the result.
- An overlay drawn with `showOverlay` is decoration, not a mask — it scrolls away with the content.
- There is no post-hoc blur in this toolchain. A finished file containing something it should not is
  re-recorded, not retouched.

Masking syntax, `maskColor`, `stylePath`, disabling animations and diff thresholds are covered in
full by the `playwright-best-practices` skill. Do not reinvent them here.

## Line 3 — review the finished file

**Mandatory, every time, before the file leaves the machine.** `--confirm-plan` proves the upload
matches the plan; it proves nothing about anybody having looked. See §4 of the skill.

### A screenshot

Read the PNG. You can see images — do it directly, and do not reason about the file from the script
that produced it.

### A video

Frames, not a scrub. The exposure is normally in the middle, where the page scrolled.

```bash
# 1. contact sheet first — one image, read it in one go
ffmpeg -i demo.mp4 -vf "fps=2,scale=360:-1,tile=5x4" sheet.png

# 2. any suspicious tile at full resolution, by timestamp
ffmpeg -ss 6.5 -i demo.mp4 -frames:v 1 frame-6500ms.png

# 3. or every frame, for a short clip
mkdir -p frames && ffmpeg -i demo.mp4 frames/f%04d.png
```

`fps=2` at 5×4 tiles covers ten seconds in one sheet. Adjust the tile grid to the length; a sheet
that drops the tail of the video is a review that did not cover the tail of the video.

Clean up afterwards: `rm -rf frames sheet.png`. Frames of a real screen are the same data as the
video.

**No `ffmpeg` available?** Then the video cannot be reviewed, and an unreviewed video is not
published. Attach screenshots instead — they are reviewable with what you have, and §1 of the skill
prefers them anyway.

### Checklist

| Look for | Typical hiding place |
| --- | --- |
| Tokens, JWTs, session ids, API keys | the URL bar, a copied link, a "share" dialog, a devtools panel |
| `?token=`, `?jwt=`, `?sig=`, `X-Amz-*` in a visible URL | signed asset links, download links, preview links |
| Email addresses | the account menu, a user list, a mail-to link, an audit log |
| Real customer or employee names | seed data, an assignee dropdown, a comment thread, an avatar tooltip |
| Internal hostnames and ports | the URL bar, an error banner, a stack trace, a network panel |
| Unrelated tickets, unrelated customers | a sidebar list, a search history, an autocomplete dropdown |
| Anything from another tab or the desktop | a full-screen capture that was supposed to be a page capture |

Rule of thumb: **anything you would not paste into the pull request description as plain text does
not belong in a frame either.** The frame is more permanent than the text — the text can be edited.

## Visibility is not a defence

Rendering follows the target's visibility as far as has been observed. Whether an asset stays
reachable only to members once its URL is quoted somewhere else **is not established** and is not
promised by this tool. Two rules follow:

- Never tell anyone the attachment is "a public link" or "a private link". Neither is guaranteed.
- Decide what goes in the frame as though a stranger could open it, because the cheapest assumption
  is also the only irreversible one.

A public repository carries a further consequence, and consent for it is collected **before** the
bytes leave, never after.

## If something leaked anyway

The asset is published and cannot be withdrawn. Do not spend time deleting comments — that changes
nothing about reachability.

| What was exposed | Action |
| --- | --- |
| A token, key or session id | **rotate the credential immediately.** It is compromised, and no amount of comment editing un-compromises it |
| Personal data of a real person | escalate to a human owner; this is a disclosure, not a bug in a script |
| An internal hostname or an unrelated ticket id | report it, record it, and fix the scenario before the next recording |

In every case: fix the scenario so the next recording cannot repeat it, and say plainly what
happened. Silently re-recording a clean version leaves the original exactly where it was.

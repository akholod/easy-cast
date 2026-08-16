# Recording a scenario for a reviewer

For the screencast and overlay API — `video-start`, `video-chapter`, `run-code`,
`page.screencast.*` — use the `playwright-cli` skill's video-recording reference. It is not repeated
here.

This file covers only what changes when the audience is a **person reviewing a pull request** rather
than a test runner.

## Test recording vs reviewer recording

| | Test | Reviewer |
| --- | --- | --- |
| Purpose | evidence for a failure investigation | someone must understand a change in one viewing |
| Speed | as fast as the browser allows | paced for an eye that has to follow |
| Length | whatever the test takes | seconds; every second costs attention |
| Viewport | whatever the suite fixes | 1000–1280 wide, so text survives the inline player |
| Narration | none | chapter cards at meaningful transitions |
| Data | fixtures, incidental | fictional **by design** — the file is published and cannot be withdrawn |
| Watched by | almost nobody | the reviewer, once, probably at 1x |

## Rhythm

| Moment | Do | Why |
| --- | --- | --- |
| Start | `await page.waitForTimeout(700)` after the first paint | the opening frame becomes the poster; a half-rendered page makes a useless thumbnail |
| Typing | `pressSequentially(text, { delay: 60 })` | `fill()` sets the value in one tick and reads as a glitch, not as typing |
| After a click | `waitForTimeout(800–1200)` | the action and its result must not land in the same perceived instant |
| Before a transition | `showChapter(...)` | a card lets the viewer re-orient instead of hunting for what moved |
| Reveal of the point | `waitForTimeout(1500)` and hold | the frame the whole recording exists for gets the most time |
| End | one beat after the last action, then stop | a video that cuts mid-animation reads as broken |

Two things not to do:

- **Do not record as a sequence of separate CLI invocations.** One process per step inserts dead air
  of unpredictable length between actions, and the result is unwatchable. Write one script and run it
  through `run-code`.
- **Do not narrate with `console.log`.** It goes nowhere the reviewer can see. Narration is
  `showChapter` and overlays; see [annotations.md](annotations.md).

## Skeleton

```js
// playwright-cli run-code --filename=demo.js
async page => {
  await page.screencast.start({
    path: 'demo.webm',
    size: { width: 1280, height: 800 },   // not 1920 — see below
  });

  await page.goto('https://staging.example.test/app');
  await page.waitForTimeout(700);          // let the first frame settle

  await page.screencast.showChapter('The bug', {
    description: 'Saving with an empty title silently did nothing.',
    duration: 2000,
  });

  await page.getByRole('textbox', { name: 'Title' })
    .pressSequentially('Quarterly report', { delay: 60 });
  await page.waitForTimeout(900);

  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForTimeout(1200);         // let the result be seen

  await page.screencast.showChapter('After the fix', {
    description: 'The row appears immediately and the toast confirms it.',
    duration: 2000,
  });

  await page.getByText('Quarterly report').waitFor();
  await page.waitForTimeout(1500);         // hold on the point of the whole recording

  await page.screencast.stop();
}
```

## Chapters

A chapter card blurs the page and blocks until its duration expires, so each one is a real pause in
the recording. Budget them.

| Put a chapter here | Not here |
| --- | --- |
| Before the scenario starts — one sentence saying what is about to happen | Between every two clicks |
| At a change of context: another page, another role, another account | On a step that is self-evident from the screen |
| Between "before" and "after" when both are in one recording | At the very end — nobody reads a card after the point is made |

Two to four chapters in a short recording. More than that and the video is mostly cards.

## Viewport and file size

- **Width 1000–1280.** GitHub's inline player is narrow; a 1920-wide capture is downscaled and its
  text becomes unreadable. Height follows the content — 620–800 is normal.
- Recording at a mobile viewport is legitimate when the change is a mobile layout. Say so in the
  chapter card, or the reviewer will read the narrow frame as a bug.
- Length, not resolution, is what makes a file big. Measured: a 8.7 s capture at 1000×620 is ~238 KB
  as WebM and ~38 KB after conversion to h264 mp4. A short clip is nowhere near any limit; a
  three-minute screen recording is a different object and should not exist (§1 of the skill).

## Do not re-encode by hand

`easy-cast` converts the recording itself before upload. Running `ffmpeg` over the file yourself and
attaching the result is not the same operation:

| Consequence | Detail |
| --- | --- |
| Different bytes | identity is derived from the **source bytes**; a re-encode is a different file, so nothing already uploaded is reused |
| A new irreversible upload | the previous asset stays where it is; you have now published two |
| A plan that no longer matches | a plan obtained before the re-encode does not describe the re-encoded file, and the run is refused |

Record, review, attach the recording. If the container or codec has to change, that is the tool's
job, not a preprocessing step of yours.

## Before you stop the recording

- Is the point of the video visible in a single frame somewhere, held long enough to read?
- Would the video make sense with the sound off and no explanation? It will have both.
- Is every piece of data in frame fictional? If not, stop — re-record on sanitised data
  ([sanitizing.md](sanitizing.md)), do not plan to paint over it.
- Is it under fifteen seconds? If not, what is being cut?

Then review the finished file frame by frame — §4 of the skill, procedure in
[sanitizing.md](sanitizing.md). A recording that was never opened does not get attached.

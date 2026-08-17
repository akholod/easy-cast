# Annotation recipes

Overlays are arbitrary HTML drawn on top of the frame with `page.screencast.showOverlay(html, opts)`.
The API itself belongs to the `playwright-cli` skill; this file is the part that stops agents from
using it — where the coordinates come from, and what to draw with them.

## The chain, once

Every overlay that points **at something** needs the same four steps. There is no shortcut, and no
part of the API hints that the chain exists:

```
snapshot  →  locator  →  scrollIntoViewIfNeeded()  →  boundingBox()  →  showOverlay(html at those coords)
```

```js
const target = page.getByRole('button', { name: 'Save changes' });
await target.scrollIntoViewIfNeeded();
const box = await target.boundingBox();
if (!box) throw new Error('no bounding box: element is not visible');
// box = { x, y, width, height } in CSS pixels, relative to the viewport, as of this instant
```

Rules that come with it:

| Rule | Consequence if ignored |
| --- | --- |
| Coordinates are viewport-relative | scroll after measuring and the box marks empty space |
| Coordinates are instantaneous | a late-loading font, image or banner shifts the layout and invalidates them |
| `boundingBox()` returns `null` for an element that is not visible | `${box.x}` becomes `undefined` and the overlay silently lands at the top-left corner |
| Overlays are `pointer-events: none` | none — this is the useful half: keep a sticky overlay up while you click through the page |

Re-measure after every scroll, every navigation and every state change that moves things. Measuring
once at the top of a script and drawing five overlays from it is the standard way this goes wrong.

## Box with a caption

The default. Marks one element and says why it matters.

```js
async function callout(page, locator, text, duration = 2500) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  if (!b) throw new Error('callout target is not visible');
  return page.screencast.showOverlay(`
    <div style="position:absolute; left:${b.x - 4}px; top:${b.y - 4}px;
      width:${b.width + 8}px; height:${b.height + 8}px;
      border:2px solid #d73a49; border-radius:6px;
      box-shadow:0 0 0 9999px rgba(0,0,0,0.18);"></div>
    <div style="position:absolute; left:${b.x + b.width / 2}px; top:${b.y + b.height + 10}px;
      transform:translateX(-50%); padding:5px 11px; background:#24292f; color:#fff;
      border-radius:6px; font:13px/1.4 system-ui; white-space:nowrap;">${text}</div>
  `, { duration });
}
```

The `box-shadow` spread dims everything except the marked element. Drop it when two things are marked
at once, or the two dimmings stack into black.

## Arrow

A caption that has to sit away from the element — because the element is at the edge of the frame, or
the space below it is occupied.

```js
const b = await locator.boundingBox();
const tipX = b.x + b.width / 2, tipY = b.y - 6;      // point just above the element
await page.screencast.showOverlay(`
  <svg style="position:absolute; left:0; top:0; width:100%; height:100%;">
    <defs><marker id="ah" markerWidth="9" markerHeight="9" refX="8" refY="3"
      orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#d73a49"/></marker></defs>
    <line x1="${tipX + 130}" y1="${tipY - 70}" x2="${tipX}" y2="${tipY}"
      stroke="#d73a49" stroke-width="2.5" marker-end="url(#ah)"/>
  </svg>
  <div style="position:absolute; left:${tipX + 140}px; top:${tipY - 92}px;
    padding:5px 11px; background:#24292f; color:#fff; border-radius:6px;
    font:13px system-ui;">This is the count that was stale</div>
`, { duration: 3000 });
```

Check the arrow's tail stays inside the frame. An arrow that starts off-screen reads as a rendering
artifact.

## Before / after label

For a single recording that shows both states, or for two screenshots taken in one run. The label
must be part of the frame — a caption in the comment body is read after the image, not with it.

```js
function stateLabel(page, text, tone) {
  const bg = tone === 'before' ? '#6e7781' : '#1a7f37';
  return page.screencast.showOverlay(`
    <div style="position:absolute; top:14px; left:14px; padding:6px 14px;
      background:${bg}; color:#fff; border-radius:999px;
      font:600 13px system-ui; letter-spacing:.02em;">${text}</div>
  `);   // no duration — sticky, dispose it yourself
}

const label = await stateLabel(page, 'Before', 'before');
// ... reproduce the old behaviour ...
await label.dispose();
```

Sticky overlays need `dispose()`. An undisposed "Before" badge riding into the "after" half of the
recording is worse than no label at all.

## Sticky progress badge

Useful in a longer flow: the viewer always knows which step they are watching without a chapter card
stopping the video.

```js
let badge;
async function step(page, text) {
  if (badge) await badge.dispose();
  badge = await page.screencast.showOverlay(`
    <div style="position:absolute; top:12px; right:12px; padding:6px 12px;
      background:rgba(0,0,0,0.72); color:#fff; border-radius:8px;
      font:13px system-ui;">${text}</div>
  `);
}
```

## Marking several elements at once

One `showOverlay` call, several absolutely positioned children — not several calls. Separate calls
give separate handles, separate lifetimes and a dispose order to keep track of.

```js
const boxes = [];
for (const l of locators) {
  await l.scrollIntoViewIfNeeded();
  const b = await l.boundingBox();
  if (b) boxes.push(b);                       // skip what is not visible, do not fabricate coordinates
}
await page.screencast.showOverlay(boxes.map((b, i) => `
  <div style="position:absolute; left:${b.x - 3}px; top:${b.y - 3}px;
    width:${b.width + 6}px; height:${b.height + 6}px;
    border:2px solid #0969da; border-radius:5px;"></div>
  <div style="position:absolute; left:${b.x - 3}px; top:${b.y - 24}px;
    padding:1px 7px; background:#0969da; color:#fff; border-radius:4px;
    font:12px system-ui;">${i + 1}</div>
`).join(''), { duration: 3000 });
```

Note the loop re-measures each element after scrolling to it, which means the earlier boxes are now
stale. For a set that does not fit in one viewport, either shrink the viewport content
(`page.setViewportSize`, zoom out) or mark them in separate shots.

## Annotating a screenshot

Overlays are drawn into the page, so they are captured by a screenshot as well as by a recording:
draw the overlay, take the shot, dispose it. `page.screencast.hideOverlays()` /
`showOverlays()` toggle all of them at once, which is how you get an annotated and a clean shot of
the same frame without re-measuring anything.

## Restraint

| Symptom | Fix |
| --- | --- |
| Three callouts in one frame | the frame is making three points; split it |
| A caption restating the visible label | drop it — say why it matters, not what it says |
| Annotations covering the thing being demonstrated | move the caption, or dim instead of boxing |
| A legend explaining the annotation colours | too many colours; one accent is enough |

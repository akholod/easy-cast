# Visual reports

Several artifacts in one structured comment, instead of a flat stack of images under a single
caption. Three commands, and only one of them can create anything permanent:

| Command | Does | Uploads |
| --- | --- | --- |
| `harvest <dir...>` | finds media, writes a report spec with **every label blank** | never |
| `compose --spec f` | prints the exact comment that spec would post | never |
| `report --spec f --to <target>` | uploads and posts it | **yes** |

```bash
easy-cast harvest ./screenshots --out report.json
# open each file, write what it shows, delete the placeholder text
easy-cast compose --spec report.json
easy-cast report --spec report.json --to pr --dry-run --json
easy-cast report --spec report.json --to pr --confirm-plan=<token>
```

## When a report is the right shape

Most of the time it is not. §1 of the skill still decides how many artifacts a point needs, and the
answer is usually one — a report of five screenshots is five chances for the reviewer to skip all of
them.

| Situation | Use |
| --- | --- |
| One screenshot makes the point | `attach` |
| One video makes the point | `attach` |
| Before and after | `report` — the comparison renders side by side, which is the only arrangement a reviewer can actually compare |
| A flow with distinct stages that each need saying | `report` |
| Several states of one screen — empty, loading, error | `report`, with everything past the first point folded |
| Files that just happen to be in a directory | nothing. That is not a report, it is a directory |

## `harvest` will not upload for you, ever

Point it at a directory and it writes a document, not a comment. The labels come back empty on
purpose:

```json
{ "path": "screenshots/checkout-3.png", "label": "" }
```

Filling that in requires opening the file — which is §4 of this skill, the one obligation the CLI
cannot enforce. A spec still carrying `harvest`'s `REPLACE THIS` placeholder is **refused** by
`report`, because it is the one mechanical sign that nobody looked at anything.

`harvest` also does not guess at structure. It will not pair `before.png` with `after.png` for you:
a wrong pairing carries the tool's authority into the reviewer's head, and you are one edit away
from the right one.

## The spec

```json
{
  "version": 1,
  "title": "Inline filtering on the members table",
  "sections": [
    {
      "heading": "What this adds",
      "text": "Filtering is debounced at 200 ms.",
      "artifacts": [{ "path": "demo.mp4", "label": "the list narrowing as the filter is typed" }]
    },
    {
      "heading": "The change itself",
      "compare": {
        "before": { "path": "before.png", "label": "Before: no filter" },
        "after":  { "path": "after.png",  "label": "After: filtered" }
      }
    },
    {
      "heading": "Other states",
      "collapsed": true,
      "artifacts": [{ "path": "empty.png", "label": "nothing matches the filter" }]
    }
  ]
}
```

| Field | Note |
| --- | --- |
| `version` | must be `1`. An unknown version is refused, not coerced |
| `title` | one `###` heading at the top |
| `heading` | one `####` per section; becomes the `<summary>` when the section is collapsed |
| `text` | prose above the artifacts |
| `label` | what the frame **shows and why it matters**, not the file name. Defaults to the basename, which is almost always worse |
| `compare` | rendered as a two-column table. **A video cannot go in a cell** — the player only appears when the URL is the sole content of a line, so a comparison containing video is stacked instead |
| `collapsed` | folds the section behind `<details>`. Requires a heading, because an unlabelled fold tells the reviewer nothing about whether to open it |

Anything past the first point belongs in a fold. One visible artifact and a `<details>` beats five
images that push the description off the screen.

## `compose` before `report`, every time

`compose` prints the comment with `NOT-UPLOADED-YET:` where each URL will go. That is the last moment
anything is free: read it, then decide.

It also catches the mistakes that would otherwise cost an upload to discover — a path that is not an
accepted type, a label that says nothing, a comparison whose two frames are not the same viewport.

## The plan token binds the spec too

For `attach` the token covers the bytes, the target and the conversion policy. For `report` it also
covers the **spec**, so editing a label after obtaining a token invalidates it — `planContext.changed`
will say `report-spec`. Re-run `--dry-run` and use the new token.

Re-indenting the file does **not** invalidate it: the hash is taken over the parsed spec, not the
bytes on disk.

## What a report shares with `attach`

Everything except the arrangement. Same whole-batch validation before the first byte moves, same
plan handshake, same journal, same comment marker, same ledger, same repair step. So:

- a repeat run **reuses** what it already uploaded and updates the same comment;
- a file named twice — or two paths holding identical bytes — is uploaded once and referenced
  wherever the spec places it;
- every failure is the same `(exitCode, reason)` pair, with the same `nextAction`, documented in
  [failures.md](failures.md).

One difference worth knowing: the default `--key` is namespaced by command, so a report and a plain
`attach` of the same files address **different comments** rather than overwriting each other.

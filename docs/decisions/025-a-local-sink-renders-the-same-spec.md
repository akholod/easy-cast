# ADR 025: A local sink renders the same spec

- **Status:** Accepted for 0.1.0
- **Date:** 2026-08-25

## Context

Every destination this tool had was permanent. `attach` and `report` post to
GitHub; `harvest` and `compose` produce documents that are only useful on the way
to posting. So a caller who had captured evidence and was **not yet sure whether
to publish it** had no supported path: either post it and find out, or keep a
directory of loose files and a comment body that existed nowhere.

That gap matters most for the caller this tool was built for. An agent that has
just driven a browser has a screenshot, a video, and a claim to make about them —
and [ADR 010](010-confirm-plan-binds-a-run-to-a-plan.md) plus §4 of the skill say
the one obligation nothing can enforce is that somebody *looked* first. Looking is
easier at a folder than at an argument list, and a folder can be deleted.

The shape of the answer was already in the code. `renderReport(spec, resolved)`
is parameterised over a `path -> {url, category}` map, and it already had two
callers: `report`, which supplies real asset URLs, and `renderReportPreview`,
which supplies `NOT-UPLOADED-YET:` placeholders for `compose`.

## Decision

**`easy-cast render --spec <file> --out-dir <dir>` writes the report to a local
folder**, and it is a **third resolution builder** rather than a second renderer.
The resolution it supplies is relative paths into a sibling `assets/`.

One spec, one renderer, three resolutions. **Nothing else may render a spec.**
That is the whole reason this command is small, and the reason a locally rendered
`report.md` promotes to a GitHub comment with no re-authoring — including the rule
that a video URL must be alone on its line, which is inherited rather than
restated. A second renderer would have to re-derive it, and would eventually
diverge on the case that matters.

The folder holds `report.md`, `spec.json` verbatim, `manifest.json`, and
`assets/<sourceHash12>-<basename>` — **copies**, never symlinks or moves, because a
run directory gets cleaned and a report pointing at deleted temporary files is not
evidence of anything.

**`render` is not in `MUTATING_COMMANDS`**, and refuses `--to`, `--caption`,
`--key` and `--allow-public` explicitly rather than ignoring them. Each would look
like it was doing something on a command that posts nowhere and reads no
credential; `--allow-public` would look like it was *protecting* something. It
takes no plan token for the same reason `harvest` and `compose` take none — there
is no plan to bind.

## Alternatives considered

**`--to local` or `--to <path>`.** Rejected. `src/target/parse.ts` is deliberately
strict because `--to` "addresses something the tool is about to post irreversible
content against, so a form we are not certain of is refused rather than coerced
into the nearest plausible number". Threading a filesystem path through that slot
puts a deletable destination and a permanent one in the same argument, which is
exactly how a caller ends up somewhere they did not intend. A separate verb also
keeps `MUTATING_COMMANDS` meaningful: the set of things that can upload stays
`attach | upload | report`.

**Reuse `--out`.** Rejected, and it is the same mistake one layer down. `--out`
names a *file* — the spec `harvest` writes — and is consumed by `writeFileSync`.
Reusing it would silently create a directory named `report.json` on one command
and throw `EISDIR` on the other. `--out-dir` costs one entry in `VALUE_FLAGS` and
one HELP line, and is refused on every command except `render`.

**A `--force` flag to overwrite a non-empty out-dir.** Rejected. `render` refuses
a non-empty directory outright; the caller names another one, which costs nothing
and is the reversible branch this tool's defaults are built on. Adding a
destructive-sounding global boolean to `BOOL_FLAGS` — where `parseArgs` would then
accept it on `attach` and `upload` unless a per-command guard were hand-written —
is a real cost to avoid a non-existent one.

**Also emit an `index.html` so the folder is double-clickable.** Rejected. It is a
second rendering of the same spec, and single-rendering is precisely what makes
this change a zero-line renderer change. The stated need — watching the video — is
already met: `assets/<hash>-clip.mp4` opens in any player, and R12 already refused
a second capture surface on the same reasoning.

**Accept file types GitHub does not.** Rejected. A local render that accepted a
`.txt` would produce a spec that renders locally and then fails at `report` — the
moment it matters. The spec is a GitHub-shaped document; rendering it elsewhere
does not change what it is for.

## Consequences

- The default destination for an undecided run is now reversible. Local first,
  GitHub on an explicit ask.
- **`manifest.json` records `sourceHash`, not the ledger key, and this is a
  deliberate limit rather than an oversight.** `computeSourceHash` names the bytes
  the caller pointed at; it is the `--key` and plan-token identity. The ledger key
  is `computeDigest` — `sha256(bytes):<effectiveProfileId>` — and a local render
  applies **no conversion profile**, so it has no profile id to name. A `.webm`
  converted to mp4 on its way to GitHub has different bytes anyway. The honest
  promotion claim is therefore narrower than "the assets are already identified":
  same source bytes ⇒ same default `--key` ⇒ a later `report` addresses the same
  comment. It is **not** ledger reuse, and a caller who assumed otherwise would be
  wrong for video specifically — the artifact class this command exists to make
  reviewable.
- **A local render is not a review credit.** Nothing links a rendered folder to a
  later `report`: [ADR 023](023-upload-keeps-no-local-state.md) keeps no local
  upload state, and `manifest.json` is read by nothing. The plan token is computed
  fresh and the public-repository gate is unasked until it is asked.
- `render` inherits `assertEdited`, so a spec still carrying `harvest`'s
  placeholder is refused here too. The obligation in
  [ADR 024](024-reports-are-declared-not-swept.md) does not weaken because the
  destination is deletable.
- `render` takes `--spec` only and refuses positional files, so it structurally
  cannot sweep a directory. ADR 024 holds for every sink, not only the permanent
  one.
- Three of the CLI's seven verbs now create nothing and read no credential, and
  they answer on the same JSON contract as the rest — `command: "render"`,
  `assetsCreated: 0`, `uploaded: []`, with the destination in `notes[]`, the way
  `harvest` reports where it wrote its spec.

# ADR 024: A report is declared, not swept

- **Status:** Accepted for 0.1.0
- **Date:** 2026-08-17

## Context

Iteration 2 was described as three commands — `harvest`, `compose`, `report` —
whose job is to put several artifacts into one structured comment instead of a
flat stack of images under a single caption.

The obvious reading of `harvest` is the dangerous one: point it at a test run's
output directory, and it uploads what it finds. That would make a bulk
irreversible upload one keystroke away, and it would defeat the single obligation
this tool cannot enforce and has always deferred to the skill — that somebody
looked at each frame before it became permanent (P2, §4 of the skill,
[ADR 010](010-confirm-plan-binds-a-run-to-a-plan.md)).

The obligation is not decorative. A screenshot directory from a browser run is
exactly where a logged-in session, a real customer name or a signed URL ends up.

## Decision

**`harvest` uploads nothing, and must never upload anything.** It walks
directories, finds media, and writes a *document*: a report spec listing every
path it found, with **every label left blank**.

The blankness is the mechanism, not an omission. An agent that fills in a label
has had to open the file to know what to write, and a reviewer reading the spec
can see at a glance which artifacts nobody looked at. `harvest` also leaves a
placeholder sentence in the spec, and **`report` refuses a spec that still
contains it** — the one mechanical sign that nobody edited anything.

**`compose` uploads nothing either.** It renders the exact comment body the spec
would produce, with unmistakable `NOT-UPLOADED-YET:` placeholders where the URLs
will go. Its whole purpose is that a person can read the comment before it exists.

**`report` is the only command that uploads**, and it is `attach` with a
different renderer: the same whole-batch validation, the same plan handshake, the
same journal, ledger, marker and repair step. A report is not a new kind of
upload; it is a different arrangement of the same one.

Three smaller decisions fall out:

**The plan token binds the spec.** For `attach` and `upload` the bytes leaving
the machine are the whole product, so the source hashes describe the plan
completely. For a report the composed text is equally the product — a caller who
obtained a token and then rewrote a label would post something the plan never
described. `PlanScope.specHash` closes that, which is why the token format moved
to **v2**. The hash is taken over the parsed spec, so re-indenting a file does
not invalidate a token.

**The default key is namespaced by command.** `report-…` versus `attach-…`, so a
report and a plain attach of the same files address different comments instead of
overwriting one another.

**A comparison never puts a video in a table cell.** Stage 0 established that the
native player appears only when the URL is the sole content of its line; a cell is
never a line. A `compare` containing a video renders the pair stacked, with labels,
rather than producing a dead link inside a neat table.

## Alternatives considered

**`harvest` uploads what it finds.** Rejected: it is the exact shape of the
accident this tool exists to prevent, and no flag makes it safe — a required
`--yes` becomes template boilerplate, which is the failure already recorded in
ADR 010.

**Infer structure from file names** — pair `before.png` with `after.png`, group by
directory. Rejected. It would put a claim in the reviewer's head that nobody
verified, with the tool's authority behind it. A wrong pairing is worse than no
pairing, and the caller who knows the answer is one edit away.

**Let `report` take files on the command line as well as a spec.** Rejected: two
sources of truth for what gets posted, and the flag combination that mixes them is
the one nobody tests.

**Skip the spec and add flags** (`--section`, `--label`, `--compare`). Rejected:
the structure is a tree, argv is a list, and the result would be unreadable at
exactly the moment it matters — while somebody is deciding whether to publish.

## Consequences

- Two of the three new commands cannot create anything irreversible, and neither
  reads a credential. They work on a machine with no `gh` and no token.
- `report` inherits every property `attach` has, including that a repeat run
  reuses assets rather than uploading them again.
- The spec is versioned and refused rather than coerced when the version is
  unknown ([ADR 019](019-unknown-versions-are-quarantined.md)).
- Verified live on 2026-08-17 against `akholod/easy-cast-probe`: a four-artifact
  report with a title, two headings, a side-by-side comparison and a fold rendered
  as `<h3>`, `<h4>`×2, `<video>`, `<table>` and `<details>`. Three of the four
  artifacts were byte-identical, so they were uploaded once and referenced three
  times — which is what `PreparedFile.paths` exists for.

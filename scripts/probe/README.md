# Stage 0 — endpoint observation

This directory establishes what GitHub's undocumented `uploads.github.com/user-attachments/assets`
endpoint actually does. Everything the tool believes about that endpoint is a hypothesis until these
observations exist.

## Read this before running anything

**A successful probe leaves a GitHub attachment that can never be deleted.** Eleven of the nineteen
cases create one. Closing an issue does not remove its attachments; nothing removes them.

That is why this is a script and not a shell session: the observations have to be reproducible and
reviewable. It is also why the script is deliberately awkward to start — making an irreversible
operation scriptable is exactly what makes it cheap to repeat by accident.

## The interlock

The runner refuses to start unless **all** of these hold at once:

| Condition | Why |
| --- | --- |
| `EASY_CAST_PROBE_REPO` is set | The target must be named explicitly, never inferred |
| its value is one of `akholod/easy-cast-probe` or `akholod/easy-cast-probe-public` | An allowlist, not a pattern — `*-probe` would accept a typo pointing at a real repository |
| `--i-understand-attachments-are-permanent` is passed | The cost is acknowledged in the invocation itself |

Both probe repositories are **throwaway**. They accumulate permanent junk by design and must never
be reused for anything else.

```
EASY_CAST_PROBE_REPO=akholod/easy-cast-probe \
  node dist-scripts/probe/run.js --i-understand-attachments-are-permanent
```

The run prints how many permanent assets it is about to create, and how many previous runs this file
already records, **before** doing anything.

## Order

`cases.ts` holds the matrix. `casesInRunOrder()` returns it in the order it must run:

1. request shape and failures — the cheapest cases, several of which create nothing at all
2. types and sizes
3. tokens
4. publication targets
5. the ledger-only comment update
6. the same URL quoted in a second target
7. **the public-repository block, last and once**

The public block is last because it is the only part that produces anonymously reachable, permanent
artefacts. Cases marked `requiresPublicRepo` can only run against the `-public` repository; the
interlock enforces that rather than trusting the order.

## Output

Every observation is appended to `fixtures/endpoint/observations.jsonl` **through
`scrubObservation`**, which wraps `redact()` and additionally strips request ids and asset UUIDs.
There is deliberately no unscrubbed path to that file: the package is published publicly, so a secret
recorded there is a secret published.

Each record carries a run number, so a repeated run is visible in the file rather than blending in.

The curated result — `(status, body signature) → outcome` — lands in
`fixtures/endpoint/classification.json` and, in human-readable form, in `docs/endpoint-semantics.md`.
Every cell of the matrix must end up either `observed` or `not-testable` **with a reason**. A cell
left blank is not a finding; a cell marked `not-testable` is.

## Cleanup

`--cleanup` closes issues titled with the `[easy-cast-probe]` prefix. It does **not** claim to delete
them — whether issues can be deleted at all is itself unverified, and the script reports what
actually happened rather than what it hoped for.

**Attachments are never cleaned up, because they cannot be.**

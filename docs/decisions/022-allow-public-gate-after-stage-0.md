# ADR 022: What `--allow-public` actually protects

- **Status:** Accepted for 0.1.0
- **Date:** 2026-08-16

## Context

The `--allow-public` gate was written on an assumption nobody had tested: that an
attachment's visibility follows the repository it was uploaded against. If that
were false — if an asset were reachable by anyone who obtained its URL — the gate
would block the safe case and let the dangerous one through, which is worse than
having no gate, because it would also be reassuring.

Stage 0 tested it, and the first answer was wrong.

An unauthenticated `GET` of the canonical
`https://github.com/user-attachments/assets/<uuid>` URL returns 404 in every case:
before citation, after citation in a private repository, and after citation in a
public one. Read no further and the obvious conclusion is that the asset is
protected and the gate works. That conclusion was recorded, and it was wrong.

That URL never serves bytes to anyone. What serves the image is a rewrite GitHub
performs when it renders the comment: `body_html` carries an `<img>` pointing at
`private-user-images.githubusercontent.com/<uploader user id>/…?jwt=<signed>`,
with a five-minute expiry, scoped by the **uploading user** rather than by any
repository. Fetching that signed URL with no credentials at all returned **200**,
for an asset uploaded against the *private* probe repository and quoted in a
*public* issue.

## Decision

Exposure follows **where the URL is quoted**, not which repository it was uploaded
against. Anyone who can read the comment can obtain a working signed link and, from
there, the bytes.

`--allow-public` is kept for `attach`, and it is meaningful there — but for a
reason different from the one it was written for. `attach` quotes the URL in the
same repository it uploaded against, so the repository's visibility and the
comment's visibility are the same thing. The gate is correct because of that
coupling, not because the asset is repository-scoped.

For `upload`, which prints a URL and quotes nothing, the gate would be meaningless:
the repository passed to the endpoint controls nothing about who can eventually see
the file. `upload` therefore does not gain a visibility gate, and its documentation
says plainly that exposure is decided by wherever the caller pastes the URL.

The claim "in a private repository the link opens only for members" is retained
only in its precise form: true while the URL is quoted only there.

## Alternatives considered

**Drop the gate entirely.** Defensible on the evidence — the asset is not
repository-scoped, so gating on repository visibility looks like the wrong
question. Rejected because for `attach` it is not the wrong question: attach
controls both ends, and the repository it posts into is exactly the audience that
gets a signed link. Dropping the gate would remove a real protection on the one
command where it works.

**Gate every upload on an explicit acknowledgement instead of on visibility.**
Considered and rejected as a replacement, because it degrades to noise: a flag
required on every invocation is one an agent adds to its template once and never
thinks about again — the same failure already recorded in ADR 010. It remains
available as a future addition for `upload`, where visibility genuinely cannot be
gated.

## Consequences

- `attach` keeps the gate; the reasoning behind it in the code and docs is
  corrected to name the coupling rather than a property the asset does not have.
- `upload` gets no gate and an explicit warning instead.
- Every statement about privacy must be conditioned on where the URL is quoted. A
  URL copied out of a private comment into a public one is public from that moment,
  and nothing in this tool can prevent or detect it.
- This is now a documented limit rather than an assumption, which is the difference
  the probe was run to establish.

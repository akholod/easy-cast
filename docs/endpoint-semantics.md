# Endpoint semantics — stage 0 results

What `uploads.github.com/user-attachments/assets` actually does, established by
`scripts/probe/` on 2026-08-16 against `akholod/easy-cast-probe` (private) and
`akholod/easy-cast-probe-public` (public).

Raw evidence: `fixtures/endpoint/observations.jsonl`.
Machine-readable table: `fixtures/endpoint/classification.json`.

Before this document, every interpretation of this endpoint was a hypothesis. Rows
marked **not established** still are.

## The request

```
POST https://uploads.github.com/user-attachments/assets
     ?repository_id=<id>&name=<file name>&size=<byte length>
Authorization: Bearer <token>
Content-Type: <the media type, which must match the file extension>

<the raw bytes>
```

**Single phase.** There is no policy call and no second host — the shape the plan
allowed for (`policy → POST elsewhere`) does not occur. `wire.ts` therefore calls
`transport.send` once, and `transport.ts` needed no change.

`repository_id` is **required**: omitting it answers 404. It is the numeric
`id` from `repos/{owner}/{repo}`, not the `node_id`.

The `Content-Type` header — not a query parameter — is what declares the type. A
request sent without one was refused with `400 Invalid Content-Type` during
exploratory work, but that exchange predates the observation log, so 400 is
deliberately **not** a row in the table: it falls to the default and is reported as
`endpoint_unavailable` until it has been recorded properly.

## The responses

| Status | Body signal | Meaning | Observed from |
| --- | --- | --- | --- |
| 201 | `{"url": …}` | success | a real `.png` and a real `.gif` |
| 404 | `Not Found` | **no access, or not found — indistinguishable** | wrong `repository_id`; a repository we can read but not push to (`cli/cli`); `repository_id` omitted entirely |
| 422 | `content_type is not included in the list of allowed content types` **and** `name has a file extension that does not match the content type` | the type or the name was refused | both recorded cases carried **both messages at once**: `.png` as `application/octet-stream`, and `.log` as `text/plain` |
| anything else | — | `endpoint_unavailable` | nothing — this is the deliberate default |

Two consequences the code depends on:

- **404 must stay disjunctive.** Three unrelated causes produce a byte-identical
  response. Naming one would be a guess presented as a diagnosis.
- **A 422 body can carry two reasons at once**, in `errors[]`. The message is
  built from all of them rather than from whichever matched first.

## How an attachment is actually served

This is the part that changed a decision, and it was nearly got wrong.

The URL the endpoint returns —
`https://github.com/user-attachments/assets/<uuid>` — **never serves bytes to
anyone**. An unauthenticated `GET` answers 404 in every case tested: before
citation, after citation in a private repository, and after citation in a public
one.

What actually serves the image is a rewrite performed at **render** time. `body_html`
contains an `<img>` whose `src` is:

```
https://private-user-images.githubusercontent.com/<uploader user id>/<id>-<uuid>.<ext>?jwt=<signed>
```

with `X-Amz-Expires=300`. The path is scoped by the **uploading user**, not by any
repository. The signature is regenerated on every render.

**Fetching that signed URL with no credentials at all returned 200** — for an asset
uploaded against the *private* repository and quoted in a *public* issue.

### What that means

Exposure follows **where the URL is quoted**, not which repository it was uploaded
against. Anyone who can read the comment can obtain a working signed link, and from
there the bytes.

| Situation | Effect |
| --- | --- |
| `attach` to a private repository | the comment is private, so only members can obtain a signed link. The gate holds — **because `attach` quotes the URL in the same repository it uploaded against** |
| `attach` to a public repository | the comment is public, so the asset is public. This is what `--allow-public` exists to make deliberate |
| the URL is copied out and pasted somewhere more public | the asset becomes as public as its new home. Nothing in this tool can prevent that |
| `upload`, which prints a URL and quotes nothing | the repository it was uploaded against controls **nothing**. Exposure is decided entirely by wherever the caller pastes it |

So the `--allow-public` gate is meaningful for `attach` and meaningless for
`upload`. That distinction is now recorded in the decisions rather than assumed.

The wording "in a private repository the link opens only for members" is true only
while the URL is quoted only there.

## Not established

These are genuinely open, not overlooked:

- **Abuse detection and rate limiting.** A matrix this small cannot trigger them. A
  `403` with an HTML body remains possible and unclassified; it would resolve to
  `endpoint_unavailable`, which is the safe direction.
- **Installation tokens (`ghs_`).** Untested. CI is out of scope and `GITHUB_TOKEN`
  is deliberately never read.
- **A classic PAT without the `repo` scope.** That credential has to be issued by
  hand through the web UI.
- **A 400 with no declared type.** Seen before recording began, never captured.
- **Video types and the size ceiling.** Each success would have cost another
  permanent attachment. The image cases already establish the accept/reject shape,
  and `mime-table.ts` remains a table of hypotheses for the types not probed.
- **A connection dropping after the body has been sent.** Not induced deliberately.
  The transport treats it as `request-started`, which is the conservative reading.

## Permanent artefacts created

Four attachments, which **cannot be deleted**:

| Case | Repository it was uploaded against |
| --- | --- |
| request-shape investigation (`.png`) | private |
| accepted-type check (`.gif`) | private |
| asset-nature test (`.png`) | private, then quoted publicly |
| public-visibility check (`.png`) | public |

Probe issues were opened in both repositories and are closed by
`scripts/probe/run.ts --cleanup`. The attachments are not cleaned up, because they
cannot be.

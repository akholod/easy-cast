# ADR 006: 100 MB is a local policy limit, not a GitHub limit

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

GitHub's documentation describes size ceilings that vary by asset type and by the
account's billing plan — 10 MB for images and GIFs, 10 MB for video on a free plan,
100 MB for video on a paid plan, 25 MB for other files. An earlier draft handled that
variance with a `--plan` flag, letting the caller state which GitHub billing plan
they were on so the CLI could pick the matching documented ceiling and reject
accordingly. A separate proposal, during the second review iteration, suggested
tightening the local reject threshold from 100 MB to 25 MB on the theory that a
lower number fails safer.

## Decision

`--plan` is dropped entirely. The CLI never asks which GitHub billing plan the
caller is on and never claims to enforce GitHub's real limit — that true limit is
not independently knowable through this undocumented endpoint and depends on account
state the CLI has no reliable way to query. Instead there is exactly one
locally-owned threshold, `local_policy_limit = 100 MB`, named as our own policy in
every message and in the JSON `reason` field it produces. Below the documented
per-type ceilings the CLI stays silent; between the documented ceiling and 100 MB it
warns; only above 100 MB does it refuse to attempt the upload at all.

## Alternatives considered

Lower `local_policy_limit` to 25 MB, matching GitHub's stated ceiling for "other
files," erring toward rejecting more locally. This was rejected during architecture
review: a local size rejection does not create anything irreversible — it stops
before the request is even made — so a rejection that turns out to have been
unnecessary costs the caller one retried command, not a permanent asset. A ceiling
set too low produces exactly that unnecessary friction on files GitHub would have
accepted, for no corresponding safety gain, since the one outcome the policy needs
to prevent — attempting a request so large it is almost certainly pointless — is
already served by a threshold far larger than 25 MB.

## Consequences

The CLI's stated size policy can diverge from GitHub's actual, undocumented behavior
at the endpoint, in both directions — it may warn on a file GitHub would accept
without complaint, and it may accept a file GitHub silently rejects. Both are
acceptable, because the server's response is authoritative once a request is sent:
`classifyUploadResponse` is what actually decides success or failure. The local
check exists only to avoid attempting requests that are almost certainly pointless,
never to pre-empt the server's judgment.

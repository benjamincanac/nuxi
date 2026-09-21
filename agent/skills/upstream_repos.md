---
description: Use when classify_issue returns an upstream, to map the label to the repository and to phrase the comment about an upstream root cause.
---

# Upstream repositories

The list of upstreams is not fixed. Each repository declares its own under `upstreams` in `.github/tia.yml`, as `owner/repo` slugs. The label is `upstream/<repo>`, for example `unovue/reka-ui` becomes `upstream/reka-ui`.

## Procedure

1. `classify_issue` returns `upstream`, the label it planned. Pass that value to `track_upstream`. It accepts the label or the slug.
2. `track_upstream` searches the upstream repository and asks Jev whether one of its issues describes the same problem.
3. When it returns `upstreamIssue`, the pair is stored. The daily sweep checks whether the upstream issue closed and mentions the maintainers to retest or bump the dependency.
4. When it returns `null`, nothing is stored. Do not suggest that the reporter opens an upstream issue unless the facts say so.

## Comment

Say that the root cause looks upstream, name the library, and link the upstream issue when there is one. Do not promise a fix date. Do not tell the reporter the issue will be closed.

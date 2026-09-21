---
description: Use for every triage, re-triage, sweep, pull request or comment event on an issue. This is the pipeline, step by step.
---

# Triage pipeline

Every tool takes `owner`, `repo` and `issueNumber`. Tools record their decisions in the run's plan. You read their `facts` and `next`, you do not decide anything yourself.

Four rules hold for the whole run:

1. Call a tool only when this page tells you to, or when a tool returned its name in `next`. A tool missing from `next` must not be called, whatever the issue looks like.
2. Call each tool at most once.
3. `search_issues` is for a maintainer's questions, never for a triage run. The pipeline tools read GitHub themselves.
4. End every run with `apply_triage`, even when there is nothing to write.

## 1. Entry

Start with the tool named in the turn.

- New issue, manual triage or @-mention asking to triage: `classify_issue`. Pass `force: true` only for an explicit @-mention or a maintainer request.
- Sweep or release pass: `sweep_issue`. It returns `next`. When `next` contains `classify_issue`, continue at step 2. Otherwise go to step 4.
- New comment on an issue that waits for a reproduction: `check_reproduction_comment`. When it returns `classify_issue` in `next`, continue at step 2. Otherwise stop without calling `apply_triage`.
- Pull request opened or edited: `link_pull_request`, then `apply_triage` with an empty comment on each returned issue. Nothing else.

## 2. Classify

Call `classify_issue`. Then:

- `skipped` is set: go to step 4 with an empty comment.
- `escalate` is true: load the `escalation` skill. No comment.
- `security` is true: load the `escalation` skill. One sentence, nothing about the vulnerability.
- Otherwise continue with `next`.

## 3. Follow `next`, in this order

Call only the tools listed in `next`, and keep this order because later steps read earlier results.

1. `track_upstream` with the `upstream` value returned by `classify_issue`. Load `upstream_repos` if you need the mapping.
2. `validate_reproduction`. Load `reproduction_validation` to phrase its facts. When it returns `valid: false`, skip `run_sandbox_repro` and `check_fixed_in_release`.
3. `run_sandbox_repro`, only when `validate_reproduction` returned `runnable: true`.
4. `check_fixed_in_release`.
5. `check_duplicate`. It returns `duplicateOf` with its state. An open match is a duplicate: say so and link it. A closed match is not. Say the same thing was reported in that issue and that it was closed, and stop there. Never call it a duplicate, never say it is being tracked there, and never send the reporter to comment on a closed issue.

A tool that throws is reported to you as an error. Do not retry more than once. Skip it and continue, the issue simply keeps fewer decisions.

## 4. Apply

Call `apply_triage` once, last.

- Collect the `facts` returned by every tool in this run. Write one comment that conveys them, under 80 words, friendly, in English. Link issues and pull requests as `#123`.
- The literal fact `REPRODUCTION_REQUEST` means the templated reproduction request is appended for you. Do not write your own request, at most one short sentence before it.
- No facts: pass an empty comment. Labels and mentions still apply.
- Mentions planned by tools are appended for you. Call `mention_maintainers` yourself only when the `answered_signals` or `escalation` skill tells you to.
- When `apply_triage` rejects the comment for length, shorten it and call it again.

Then reply with one or two sentences summarizing what was decided. Load `label_taxonomy` if you need to explain a label.

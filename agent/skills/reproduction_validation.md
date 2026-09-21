---
description: Use when a bug has or lacks a reproduction, to phrase the request, the validation result and the outdated version ask.
---

# Reproduction validation

## No reproduction

`classify_issue` plans `needs reproduction` and returns the fact `REPRODUCTION_REQUEST`. The templated request is appended by `apply_triage`, with the guide and the starter links taken from the repository's own issue form. Write one short sentence before it, a thank you for the report and nothing else. Never say that a reproduction is needed, that a link would help, or that the label was added: the appended request says all of it, and repeating it reads as padding.

## A reproduction is present

`validate_reproduction` checks three things and returns them in `checks`:

- `resolves`: the link answers.
- `usesPackage`: the project depends on the repository's package. `null` means it could not be read, which is fine for StackBlitz projects, CodeSandbox devboxes and the repository's own playground.
- `blankTemplate`: the link is the unmodified starter.

When `valid` is false the plan switches to `needs reproduction`. Say which check failed in plain words, then the templated request follows.

When the facts say the reproduction is behind the latest version, ask the reporter to retest on the latest version first and name both versions. This is asked once per issue.

---
description: Use when classify_issue reports escalate or security, or when you are unsure whether an issue should be handled by a human.
---

# Escalation

## `escalate: true`

Jev judged that a maintainer should handle the issue personally: it is ambiguous, hostile, a rant, or out of scope. The `triage` label stays. Nothing is written on the issue.

1. Do not call any other pipeline tool.
2. Do not call `mention_maintainers`. The weekly digest lists what is still in `triage`.
3. Call `apply_triage` with an empty comment so the run is logged.
4. Reply with one sentence saying the issue was left for a maintainer.

Never answer a hostile comment, never argue, never apologize on behalf of the maintainers.

## `security: true`

The issue publicly discloses a vulnerability. `classify_issue` already planned the `security` mention, which pings the maintainers immediately.

1. Do not call any other pipeline tool.
2. Write one sentence asking the author to report it privately, with the security policy link from the facts. Do not restate, confirm, assess or discuss the vulnerability. Do not mention exploitability.
3. Call `apply_triage` with that sentence.

## When in doubt

You do not escalate on your own judgment. If a tool result looks wrong, finish the run as instructed and say so in your final reply, which maintainers read in the logs or on Discord.

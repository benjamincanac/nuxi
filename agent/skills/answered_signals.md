---
description: Use when a thread may already be resolved, to know which signals count as answered and how to phrase the comment and the mention.
---

# Answered signals

Jev decides `is_answered` inside `classify_issue`. This page lists what it looks for so you can phrase the outcome, and what never counts.

## Counts as resolved

- A maintainer, member or collaborator answered and the reporter confirmed it works.
- A linked pull request was merged and the thread says it fixes the problem.
- The reporter says it is fixed, that it was their mistake, or that it is no longer relevant.
- A `needs verification` issue where the reporter confirms the fix on the latest version.

## Never counts

- Silence, however long. Inactivity goes through the sweep and the `stale` rule, not through `answered`.
- A suggestion nobody confirmed.
- A workaround while the reporter still asks for a fix.
- A thumbs up reaction.

## Outcome

`classify_issue` plans the `answered` label and the `close_answered` mention. You do not call `mention_maintainers` for it. Write a short comment that thanks the participants and says the thread looks resolved. Never say the issue will be closed, that is the maintainers' call.

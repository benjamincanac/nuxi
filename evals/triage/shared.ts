/** Shared helper for triage evals, not an eval itself. */
export function triagePrompt(fixture: string): string {
  return (
    `Triage fixture/${fixture}#1. Start with classify_issue (owner "fixture", repo "${fixture}", issueNumber 1). ` +
    `Load the triage skill and follow it. The repository is in dry-run: run the full pipeline, apply_triage only logs.`
  );
}

/** The comment `apply_triage` would post, with the appended request and mention. The judge grades this, not the run summary. */
export function postedComment(turn: { toolCalls: readonly { name: string; output?: unknown }[] }): string {
  const output = turn.toolCalls.findLast((call) => call.name === "apply_triage" && call.output)?.output;
  return (output as { comment?: string | null } | undefined)?.comment ?? "";
}

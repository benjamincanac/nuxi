/** Shared helper for triage evals, not an eval itself. */
export function triagePrompt(fixture: string): string {
  return (
    `Triage fixture/${fixture}#1. Start with classify_issue (owner "fixture", repo "${fixture}", issueNumber 1). ` +
    `Load the triage skill and follow it. The repository is in dry-run: run the full pipeline, apply_triage only logs.`
  );
}

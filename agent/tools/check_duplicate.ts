import { defineTool } from "eve/tools";

import { updatePlan } from "../lib/plan";
import { checkDuplicate } from "../lib/steps/duplicate";
import { recordDecision } from "../lib/store";
import { issueInput, requireContext, runId } from "../lib/tool";

export default defineTool({
  description:
    "Compares the issue against the 8 most similar open and closed issues and asks Jev whether it duplicates one of them. Records the decision in the run's plan.",
  inputSchema: issueInput,
  label: { start: ({ owner, repo, issueNumber }) => `Check duplicates of ${owner}/${repo}#${issueNumber}` },
  async execute(ref, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const outcome = await checkDuplicate(context, ctx.abortSignal);
    await updatePlan(runId(ctx), ref, context.dryRun, "check_duplicate", outcome.patch);
    await recordDecision({
      at: new Date().toISOString(),
      repo: `${ref.owner}/${ref.repo}`,
      issueNumber: ref.issueNumber,
      step: "duplicate",
      answers: outcome.answers,
      actions: outcome.patch,
      dryRun: context.dryRun,
      runId: runId(ctx),
    });
    return {
      duplicateOf: outcome.duplicateOf ? { number: outcome.duplicateOf.number, url: outcome.duplicateOf.url, state: outcome.duplicateOf.state } : null,
      candidatesCompared: outcome.candidates.length,
      facts: outcome.patch.facts ?? [],
    };
  },
});

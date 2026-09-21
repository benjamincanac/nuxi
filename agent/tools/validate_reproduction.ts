import { defineTool } from "eve/tools";

import { updatePlan } from "../lib/plan";
import { validateReproduction } from "../lib/steps/reproduction";
import { issueInput, requireContext, runId } from "../lib/tool";

export default defineTool({
  description:
    "Validates the reproduction of a bug: the link resolves, the project depends on the repo's package, it is not the blank template, and which version it uses compared to the latest. Records the outcome in the run's plan.",
  inputSchema: issueInput,
  label: { start: ({ owner, repo, issueNumber }) => `Validate reproduction of ${owner}/${repo}#${issueNumber}` },
  async execute(ref, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const outcome = await validateReproduction(context, ctx.abortSignal);
    await updatePlan(runId(ctx), ref, context.config.dryRun, "validate_reproduction", outcome.patch);
    return {
      valid: outcome.valid !== null,
      latestVersion: outcome.latestVersion,
      checks: outcome.checks,
      facts: outcome.patch.facts ?? [],
    };
  },
});

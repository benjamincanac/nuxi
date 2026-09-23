import { defineTool } from "eve/tools";

import { updatePlan } from "../lib/plan";
import { validateReproduction } from "../lib/steps/reproduction";
import { issueInput, requireContext, runId } from "../lib/tool";

export default defineTool({
  description:
    "Checks the reproduction of a bug without opening it: whether its links are only the unmodified starter template, and whether the reported version is behind the latest. Records the outcome in the run's plan.",
  inputSchema: issueInput,
  label: { start: ({ owner, repo, issueNumber }) => `Validate reproduction of ${owner}/${repo}#${issueNumber}` },
  async execute(ref, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const outcome = await validateReproduction(context, ctx.abortSignal);
    await updatePlan(runId(ctx), ref, context.dryRun, "validate_reproduction", outcome.patch);
    return {
      valid: outcome.valid !== null,
      latestVersion: outcome.latestVersion,
      links: outcome.links,
      facts: outcome.patch.facts ?? [],
    };
  },
});

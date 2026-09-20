import { defineTool } from "eve/tools";

import { updatePlan } from "../lib/plan";
import { checkFixedInRelease, knownAreas } from "../lib/steps/fixed";
import { getPlan, recordDecision } from "../lib/store";
import { issueInput, requireContext, runId } from "../lib/tool";

export default defineTool({
  description:
    "Checks whether a bug is already fixed in a published release. Collects merged pull requests that reference the issue and changelog entries scoped to its areas, then asks Jev which one fixes it. Uses the sandbox result when run_sandbox_repro ran before. Records the decision in the run's plan.",
  inputSchema: issueInput,
  label: { start: ({ owner, repo, issueNumber }) => `Check releases for a fix of ${owner}/${repo}#${issueNumber}` },
  async execute(ref, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const plan = await getPlan(ref);
    const areaSlugs = knownAreas(context, plan?.areas ?? []);

    const outcome = await checkFixedInRelease(context, areaSlugs, plan?.sandbox ?? null, ctx.abortSignal);
    await updatePlan(runId(ctx), ref, context.config.dryRun, "check_fixed_in_release", outcome.patch);
    await recordDecision({
      at: new Date().toISOString(),
      repo: `${ref.owner}/${ref.repo}`,
      issueNumber: ref.issueNumber,
      step: "fixed",
      answers: outcome.answers,
      actions: outcome.patch,
      dryRun: context.config.dryRun,
      runId: runId(ctx),
    });
    return {
      fixedBy: outcome.fixedBy,
      candidatesCompared: outcome.candidates.length,
      facts: outcome.patch.facts ?? [],
    };
  },
});

import { defineTool } from "eve/tools";

import { updatePlan } from "../lib/plan";
import { checkFixedInRelease, knownAreas } from "../lib/steps/fixed";
import { getClassified, getPlan, recordDecision } from "../lib/store";
import { issueInput, requireContext, runId } from "../lib/tool";

export default defineTool({
  description:
    "Checks whether a bug is already fixed in a published release. Collects merged pull requests that reference the issue and changelog entries scoped to its areas, then asks Jev which one fixes it. Records the decision in the run's plan.",
  inputSchema: issueInput,
  label: { start: ({ owner, repo, issueNumber }) => `Check releases for a fix of ${owner}/${repo}#${issueNumber}` },
  async execute(ref, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const plan = await getPlan(ref);
    // A release pass has no classify step in its plan. The areas come from the last one that ran.
    const areaSlugs = knownAreas(context, [...(plan?.areas ?? []), ...((await getClassified(ref))?.areas ?? [])]);

    const outcome = await checkFixedInRelease(context, areaSlugs, ctx.abortSignal);
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

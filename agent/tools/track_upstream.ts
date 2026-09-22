import { defineTool } from "eve/tools";
import { z } from "zod";

import { updatePlan } from "../lib/plan";
import { trackUpstream } from "../lib/steps/upstream";
import { recordDecision } from "../lib/store";
import { issueInput, requireContext, runId } from "../lib/tool";

export default defineTool({
  description:
    "Call when classify_issue returned an upstream. Searches the upstream repository for an existing issue about the same problem, persists the pair so its closure can be followed, and records the link in the run's plan.",
  inputSchema: issueInput.extend({
    upstream: z.string().describe("The upstream label returned by classify_issue, such as upstream/reka-ui, or the owner/repo slug."),
  }),
  label: { start: ({ upstream }) => `Search ${upstream} for an existing issue` },
  async execute({ upstream, ...ref }, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const name = upstream.replace(/^upstream\//, "");
    const slug = context.config.upstreams.find((candidate) => candidate === name || candidate.split("/")[1] === name);
    if (!slug) throw new Error(`${upstream} is not a configured upstream. Configured: ${context.config.upstreams.join(", ")}`);

    const outcome = await trackUpstream(context, slug, ctx.abortSignal);
    await updatePlan(runId(ctx), ref, context.dryRun, "track_upstream", outcome.patch);
    await recordDecision({
      at: new Date().toISOString(),
      repo: `${ref.owner}/${ref.repo}`,
      issueNumber: ref.issueNumber,
      step: "upstream",
      answers: outcome.answers,
      actions: outcome.patch,
      dryRun: context.dryRun,
      runId: runId(ctx),
    });
    return { upstream: slug, upstreamIssue: outcome.match?.url ?? null, facts: outcome.patch.facts ?? [] };
  },
});

import { defineTool } from "eve/tools";
import { z } from "zod";

import { applyPlan, countWords, MAX_COMMENT_WORDS, reproductionRequest } from "../lib/apply";
import { skipReason } from "../lib/context";
import { emptyPlan, hasWrites } from "../lib/plan";
import { getPlan } from "../lib/store";
import { issueInput, requireContext, runId, writeApproval } from "../lib/tool";

export default defineTool({
  description:
    "Last step of a run and the only tool that writes to GitHub. Applies the plan recorded by the other tools: Issue Type, labels, and one comment. You only provide the comment text. Labels and mentions come from the plan and cannot be changed here. In dry-run it logs the intended actions and writes nothing.",
  inputSchema: issueInput.extend({
    comment: z
      .string()
      .describe(
        `The comment for the reporter, in English, friendly maintainer tone, under ${MAX_COMMENT_WORDS} words, conveying the plan's facts and nothing else. Empty string when the plan has no facts. The reproduction request and the maintainer mention are appended automatically, do not write them.`,
      ),
  }),
  approval: { request: writeApproval },
  label: { start: ({ owner, repo, issueNumber }) => `Apply triage to ${owner}/${repo}#${issueNumber}` },
  async execute({ comment, ...ref }, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const recorded = await getPlan(ref);
    // Without a plan no tool evaluated the skip rules for this run, so they are evaluated here.
    // The activity guard is off: this path answers an explicit @-mention.
    const plan = recorded ?? { ...emptyPlan(ref, runId(ctx), context.config.dryRun), skipped: skipReason(context, true) };

    if (!plan.escalate && !plan.skipped && !hasWrites(plan) && !comment.trim()) {
      return { applied: false, reason: "Nothing to do: no decision was taken, the issue stays in triage." };
    }

    const templated = plan.facts.includes("REPRODUCTION_REQUEST") ? reproductionRequest(context.reproduction) : "";
    // The request is appended in full. When it is the only fact, a comment that asks for one
    // says the same thing twice. A run that also found an unusable link still has to explain it.
    const onlyFact = plan.facts.every((fact) => fact === "REPRODUCTION_REQUEST");
    if (templated && onlyFact && /reproduc|sandbox|stackblitz|codesandbox|minimal/i.test(comment)) {
      throw new Error(
        "The reproduction request is appended for you, so the comment must not ask for one. Keep one short sentence thanking the reporter, and call apply_triage again.",
      );
    }
    const words = countWords(`${comment} ${templated}`);
    if (words > MAX_COMMENT_WORDS) {
      throw new Error(`The comment is ${words} words with the appended request, the limit is ${MAX_COMMENT_WORDS}. Shorten it and call apply_triage again.`);
    }

    const actions = await applyPlan(context.config, plan, comment, context.humanLabels, context.issue.labels, context.reproduction);
    return { applied: !actions.dryRun, ...actions };
  },
});

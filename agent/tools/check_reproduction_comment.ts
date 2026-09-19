import { defineTool } from "eve/tools";
import { z } from "zod";

import { hasReproductionQuestions } from "../lib/jev/questions";
import { ask, clip } from "../lib/jev";
import { updatePlan } from "../lib/plan";
import { recordDecision } from "../lib/store";
import { issueInput, requireContext, runId } from "../lib/tool";

export default defineTool({
  description:
    "Call when a new comment lands on an issue labeled `needs reproduction`. Asks Jev whether that comment provides a reproduction. When it does, plans the label removal and a thank you, and tells you to run the pipeline again from classify_issue.",
  inputSchema: issueInput.extend({ commentId: z.number().int().positive() }),
  label: { start: ({ owner, repo, issueNumber }) => `Check new comment on ${owner}/${repo}#${issueNumber}` },
  async execute({ commentId, ...ref }, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const comment = context.issue.comments.find((candidate) => candidate.id === commentId);
    if (!comment) throw new Error(`Comment ${commentId} not found on the issue.`);
    if (!context.issue.labels.includes("needs reproduction")) return { hasReproduction: false, next: [] as string[] };

    const answers = await ask(
      hasReproductionQuestions(),
      { title: context.issue.title, body: "", comments: [{ author: comment.author, body: clip(comment.body, 6_000) }] },
      ctx.abortSignal,
    );
    const hasReproduction = answers.has_reproduction.probability >= context.config.thresholds.has_reproduction;
    const patch = hasReproduction
      ? { removeLabels: ["needs reproduction"], facts: [`Thank @${comment.author} for the reproduction.`] }
      : {};

    await updatePlan(runId(ctx), ref, context.config.dryRun, "check_reproduction_comment", patch);
    await recordDecision({
      at: new Date().toISOString(),
      repo: `${ref.owner}/${ref.repo}`,
      issueNumber: ref.issueNumber,
      step: "reproduction_comment",
      answers,
      actions: patch,
      dryRun: context.config.dryRun,
      runId: runId(ctx),
    });
    return { hasReproduction, next: hasReproduction ? ["classify_issue"] : [] };
  },
});

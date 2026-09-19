import { defineTool } from "eve/tools";
import { z } from "zod";

import { MENTION_TEMPLATES, updatePlan, type MentionTemplate } from "../lib/plan";
import { issueInput, requireContext, runId } from "../lib/tool";

const templates = Object.keys(MENTION_TEMPLATES) as [MentionTemplate, ...MentionTemplate[]];

export default defineTool({
  description:
    "Adds an @-mention of the repo's maintainers to the run's plan, for decisions only they can take: closing, converting to a discussion, retesting after an upstream fix. The mention is posted by apply_triage inside the single comment of the run. Pick the template, the wording is fixed.",
  inputSchema: issueInput.extend({
    template: z.enum(templates),
    detail: z.string().max(240).describe("One sentence of evidence in English. Summarize the issue here when it is not written in English."),
  }),
  label: { start: ({ template }) => `Plan maintainer mention: ${template}` },
  async execute({ template, detail, ...ref }, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const plan = await updatePlan(runId(ctx), ref, context.config.dryRun, "mention_maintainers", {
      mentions: [{ template, detail }],
    });
    return { mentions: plan.mentions.map((mention) => mention.template) };
  },
});

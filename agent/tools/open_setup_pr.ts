import { defineTool } from "eve/tools";
import { z } from "zod";

import { isProduction } from "../config";
import { openSetupPullRequest, proposeSetup } from "../lib/setup";

export default defineTool({
  description:
    "Sets up a repository that has no .github/tia.yml yet. Opens one pull request from the tia/setup branch with a config detected from the repository, and removes the workflows tia replaces. Only on a maintainer's explicit request. With preview true it returns the proposal and writes nothing.",
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    preview: z.boolean().default(false).describe("Return the proposed config and workflow changes without opening the pull request."),
  }),
  // A pull request is reviewable, but it still lands in someone's notifications.
  approval: { request: ({ toolInput }) => (toolInput?.preview ? "not-applicable" : "user-approval") },
  label: { start: ({ owner, repo, preview }) => `${preview ? "Preview" : "Open"} setup pull request for ${owner}/${repo}` },
  async execute({ owner, repo, preview }, ctx) {
    if (preview || !isProduction()) {
      const proposal = await proposeSetup({ owner, repo }, ctx.abortSignal);
      return { status: "preview" as const, yaml: proposal.yaml, notes: proposal.notes, workflows: proposal.workflows.map(({ path, action, reason }) => ({ path, action, reason })) };
    }
    return openSetupPullRequest({ owner, repo }, ctx.abortSignal);
  },
});

import { defineTool } from "eve/tools";
import { z } from "zod";

import { buildDigest } from "../lib/digest";
import { listEnabledRepositories } from "../lib/github";
import { listDecisions } from "../lib/store";

export default defineTool({
  description:
    "Answers backlog questions from a maintainer: what is waiting on them, grouped by reason, plus totals and component clusters. With an issue number it returns the stored Jev answers and actions for that issue. Use the GitHub tools for anything else.",
  inputSchema: z.object({
    repo: z.string().optional().describe("owner/repo. Defaults to every enabled repository."),
    issueNumber: z.number().int().positive().optional(),
  }),
  label: { start: ({ repo }) => `Read backlog status${repo ? ` of ${repo}` : ""}` },
  async execute({ repo, issueNumber }, ctx) {
    const configs = (await listEnabledRepositories(ctx.abortSignal)).filter(
      (config) => !repo || `${config.owner}/${config.repo}`.toLowerCase() === repo.toLowerCase(),
    );

    if (issueNumber) {
      const decisions = (await listDecisions()).filter(
        (decision) => decision.issueNumber === issueNumber && (!repo || decision.repo.toLowerCase() === repo.toLowerCase()),
      );
      return { decisions: decisions.slice(-12) };
    }

    const digests = await Promise.all(configs.map((config) => buildDigest(config, ctx.abortSignal)));
    return { repositories: digests };
  },
});

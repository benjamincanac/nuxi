import { defineTool } from "eve/tools";
import { z } from "zod";

import { isEnabled } from "../config";
import { loadRepoConfig } from "../lib/github";
import { updatePlan } from "../lib/plan";
import { getPullRequest, pullRequestTargets } from "../lib/steps/pull-request";
import { markOnce } from "../lib/store";
import { runId } from "../lib/tool";

export default defineTool({
  description:
    "Call when a pull request is opened or edited. Finds the issues it closes and plans a single maintainer mention when a community pull request targets a request that was never discussed. GitHub already shows the linked pull request on the issue, so nothing is labeled. Returns the issue numbers that got a mention, call apply_triage with an empty comment on each.",
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    pullRequestNumber: z.number().int().positive(),
  }),
  label: { start: ({ owner, repo, pullRequestNumber }) => `Link ${owner}/${repo}#${pullRequestNumber} to its issues` },
  async execute({ owner, repo, pullRequestNumber }, ctx) {
    const config = await loadRepoConfig({ owner, repo }, ctx.abortSignal);
    if (!config || !isEnabled(config, "pr")) return { issues: [] as number[] };

    const pr = await getPullRequest({ owner, repo }, pullRequestNumber, ctx.abortSignal);
    const issues: number[] = [];
    for (const { issueNumber, dryRun } of await pullRequestTargets({ owner, repo }, pr, ctx.abortSignal)) {
      const ref = { owner, repo, issueNumber };
      if (!dryRun && !(await markOnce(ref, "enhancement-pr"))) continue;
      await updatePlan(runId(ctx), ref, dryRun, "link_pull_request", {
        mentions: [{ template: "enhancement_pr", detail: `${pr.html_url} by @${pr.user?.login ?? "ghost"}.` }],
      });
      issues.push(issueNumber);
    }
    return { issues };
  },
});

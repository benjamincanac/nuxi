import { defineTool } from "eve/tools";
import { z } from "zod";

import { isEnabled } from "../config";
import { loadTriageContext } from "../lib/context";
import { gh, loadRepoConfig } from "../lib/github";
import { kindOf } from "../lib/issue-forms";
import { updatePlan } from "../lib/plan";
import { markOnce } from "../lib/store";
import { runId } from "../lib/tool";

const pullRequestSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  author_association: z.string().default("NONE"),
  user: z.object({ login: z.string() }).nullable(),
});

const CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|#)(\d+)/gi;

export function referencedIssues(text: string, repo: string): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(CLOSING_REFERENCE)) {
    if (match[1] && match[1].toLowerCase() !== repo.toLowerCase()) continue;
    numbers.add(Number(match[2]));
  }
  return [...numbers];
}

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

    const pr = await gh(pullRequestSchema, `/repos/${owner}/${repo}/pulls/${pullRequestNumber}`, { owner, signal: ctx.abortSignal });
    const community = !["OWNER", "MEMBER", "COLLABORATOR"].includes(pr.author_association);
    const issues: number[] = [];

    for (const issueNumber of referencedIssues(`${pr.title}\n${pr.body ?? ""}`, `${owner}/${repo}`).slice(0, 5)) {
      const ref = { owner, repo, issueNumber };
      const context = await loadTriageContext(ref, ctx.abortSignal).catch(() => null);
      if (!context || context.issue.isPullRequest || context.issue.state !== "open") continue;

      const request = community && kindOf(context.issue, context.kinds)?.report === false;
      if (!request || !(context.dryRun || (await markOnce(ref, "enhancement-pr")))) continue;
      await updatePlan(runId(ctx), ref, context.dryRun, "link_pull_request", {
        mentions: [{ template: "enhancement_pr", detail: `${pr.html_url} by @${pr.user?.login ?? "ghost"}.` }],
      });
      issues.push(issueNumber);
    }
    return { issues };
  },
});

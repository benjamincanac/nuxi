import { z } from "zod";

import { isEnabled } from "../../config";
import { loadTriageContext } from "../context";
import { gh, linkedIssues, type RepoRef } from "../github";
import { kindOf } from "../issue-forms";
import { isDryRunForced, isMarked } from "../store";

const pullRequestSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  author_association: z.string().default("NONE"),
  user: z.object({ login: z.string() }).nullable(),
});

export type PullRequest = z.output<typeof pullRequestSchema>;

export function getPullRequest(repo: RepoRef, pullRequestNumber: number, signal?: AbortSignal): Promise<PullRequest> {
  return gh(pullRequestSchema, `/repos/${repo.owner}/${repo.repo}/pulls/${pullRequestNumber}`, { owner: repo.owner, signal });
}

/**
 * The open requests a community pull request closes that were never announced. A bug report needs
 * no warning. Asked before a run is dispatched too: a pull request with none has nothing to do.
 */
export async function pullRequestTargets(repo: RepoRef, pr: PullRequest, signal?: AbortSignal): Promise<{ issueNumber: number; dryRun: boolean }[]> {
  const targets: { issueNumber: number; dryRun: boolean }[] = [];
  for (const issueNumber of linkedIssues(pr, `${repo.owner}/${repo.repo}`).slice(0, 5)) {
    const ref = { ...repo, issueNumber };
    const context = await loadTriageContext(ref, signal).catch(() => null);
    if (!context || !isEnabled(context.config, "pr") || context.issue.isPullRequest || context.issue.state !== "open") continue;
    if (kindOf(context.issue, context.kinds)?.report !== false) continue;
    // Dry runs never consume the marker, so they never read it either.
    const dryRun = context.dryRun || (await isDryRunForced(ref));
    if (!dryRun && (await isMarked(ref, "enhancement-pr"))) continue;
    targets.push({ issueNumber, dryRun });
  }
  return targets;
}

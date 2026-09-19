import { connectGitHubCredentials } from "@vercel/connect/eve";
import { githubChannel, type GitHubInboundContext } from "eve/channels/github";
import { z } from "zod";

import { githubConnector, isProduction } from "../config";
import { isBot, loadRepoConfig } from "../lib/github";
import { enqueue, type QueueItem } from "../lib/store";

const BOT_NAME = "nuxi";
const MENTION = new RegExp(`(^|\\s)@${BOT_NAME}\\b`, "i");

const issueLabels = z.object({
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  user: z.object({ login: z.string() }).nullable(),
});

/**
 * Hooks never dispatch a turn themselves. They queue the event and `schedules/dispatch_queue`
 * starts the session, on the issue thread or in the Discord approvals channel.
 * Previews receive no webhook driven triage: they are triggered through the ops route.
 */
async function queue(ctx: GitHubInboundContext, item: Omit<QueueItem, "owner" | "repo" | "notBefore">): Promise<null> {
  if (!isProduction()) return null;
  if (isBot(ctx.sender.login, ctx.sender.type)) return null;
  const ref = { owner: ctx.repository.owner, repo: ctx.repository.name };
  if (!(await loadRepoConfig(ref))) return null;
  await enqueue({ ...ref, ...item, notBefore: Date.now() });
  return null;
}

export default githubChannel({
  botName: BOT_NAME,
  credentials: connectGitHubCredentials(githubConnector()),
  // The eyes reaction is a write. Dry runs must leave no trace on the issue.
  progress: { reactions: false },

  onIssue(ctx, issue) {
    if (issue.action !== "opened" && issue.action !== "reopened") return null;
    return queue(ctx, { issueNumber: issue.issueNumber, reason: "issue" });
  },

  async onComment(ctx, comment) {
    const issueNumber = ctx.conversation.issueNumber;
    if (ctx.conversation.kind !== "issue" || issueNumber === null) return null;

    if (MENTION.test(comment.body)) {
      return queue(ctx, { issueNumber, reason: "mention", commentId: comment.id, text: comment.body.slice(0, 2_000) });
    }

    // Only the reporter's reply on an issue that waits for them re-runs the pipeline.
    const { owner, name } = ctx.repository;
    const issue = await ctx.github.request<unknown>({ method: "GET", path: `/repos/${owner}/${name}/issues/${issueNumber}` });
    const parsed = issueLabels.safeParse(issue.body);
    if (!parsed.success) return null;
    const labels = parsed.data.labels.map((label) => (typeof label === "string" ? label : label.name));
    const waiting = labels.includes("needs reproduction") || labels.includes("needs verification");
    if (!waiting || parsed.data.user?.login !== comment.author?.login) return null;
    return queue(ctx, { issueNumber, reason: "comment", commentId: comment.id });
  },

  onPullRequest(ctx, pullRequest) {
    if (pullRequest.action !== "opened" && pullRequest.action !== "edited") return null;
    return queue(ctx, { issueNumber: pullRequest.pullRequestNumber, reason: "pull_request" });
  },

  events: {
    // The default handlers check out the repo and post the model's reply as a comment.
    // Triage needs neither: `apply_triage` is the only writer, and it honors dry-run.
    "turn.started"() {},
    // The default posts the approval prompt as a public comment. Runs that need an approval are
    // dispatched to Discord, so reaching this means a misconfiguration. Stay silent.
    "input.requested"(event, channel) {
      console.warn(`[nuxi] input requested on ${channel.repository.fullName}, ignored`, JSON.stringify(event.requests.map((request) => request.kind)));
    },
    "message.completed"(event, channel) {
      if (event.finishReason !== "tool-calls" && event.message) {
        console.log(`[nuxi] ${channel.repository.fullName}#${channel.conversation.issueNumber ?? channel.conversation.pullRequestNumber}: ${event.message}`);
      }
    },
    "turn.failed"(event, channel) {
      console.error(`[nuxi] turn failed on ${channel.repository.fullName}`, event);
    },
    "session.failed"(event, channel) {
      console.error(`[nuxi] session failed on ${channel.repository.fullName}`, event);
    },
  },
});

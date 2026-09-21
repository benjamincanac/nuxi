import { defaultDiscordAuth, discordChannel, renderInputRequestComponents } from "eve/channels/discord";
import { z } from "zod";

import { env, requireApproval } from "../config";
import { mentionLine, reproductionRequest } from "../lib/apply";
import { loadTriageContext } from "../lib/context";
import { discordCredentials } from "../lib/discord";
import { emptyPlan } from "../lib/plan";
import { getPlan } from "../lib/store";

function maintainerIds(): string[] {
  return (env("DISCORD_MAINTAINER_IDS") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
}

const applyInput = z.object({ owner: z.string(), repo: z.string(), issueNumber: z.number(), comment: z.string() });

/**
 * What an approval would write, in the prompt itself. "Approve tool call: apply_triage" alone asks
 * a maintainer to say yes to something they cannot see.
 */
async function describeWrite(input: unknown, runId: string): Promise<string> {
  const parsed = applyInput.safeParse(input);
  if (!parsed.success) return "";
  const { owner, repo, issueNumber, comment } = parsed.data;
  const ref = { owner, repo, issueNumber };
  const context = await loadTriageContext(ref).catch(() => null);
  const plan = (await getPlan(ref)) ?? emptyPlan(ref, runId, true);

  const lines = [`**[${owner}/${repo}#${issueNumber}](<https://github.com/${owner}/${repo}/issues/${issueNumber}>)**`];
  if (plan.setType) lines.push(`Type: ${plan.setType}`);
  // The plan is what the steps asked for. Only labels the issue carries can be removed, and only ones it lacks added.
  const current = context?.issue.labels ?? [];
  const add = plan.addLabels.filter((label) => !current.includes(label));
  const remove = plan.removeLabels.filter((label) => !context || current.includes(label));
  if (add.length) lines.push(`Add: ${add.join(", ")}`);
  if (remove.length) lines.push(`Remove: ${remove.join(", ")}`);

  const request = plan.facts.includes("REPRODUCTION_REQUEST") && context ? `\n\n${reproductionRequest(context.reproduction)}` : "";
  const mention = context ? mentionLine(context.config, plan) : "";
  const body = [comment, request, mention && `\n\n${mention}`].filter(Boolean).join("");
  if (body) lines.push("", body.length > 900 ? `${body.slice(0, 900)}…` : body);
  return lines.join("\n");
}

const appliedOutput = z.object({
  dryRun: z.boolean(),
  blocked: z.string().nullable(),
  setType: z.string().nullable(),
  addedLabels: z.array(z.string()),
  removedLabels: z.array(z.string()),
  comment: z.string().nullable(),
});

/** A real write only happens behind an approval when approvals are on, so a written result was approved. */
function wasApproved(output: unknown): boolean {
  const applied = appliedOutput.safeParse(output);
  if (!applied.success || !requireApproval()) return false;
  const { dryRun, blocked, setType, addedLabels, removedLabels, comment } = applied.data;
  return !dryRun && blocked === null && Boolean(setType || addedLabels.length || removedLabels.length || comment);
}

/**
 * Two uses without a server: `/ask` in a DM with the app, and the DM channel that receives
 * approval prompts and the weekly digest.
 */
export default discordChannel({
  credentials: discordCredentials,
  onCommand(_ctx, interaction) {
    // The backlog conversation can trigger re-triage, so it is limited to maintainers.
    if (!maintainerIds().includes(interaction.user.id)) return null;
    return { auth: defaultDiscordAuth(interaction) };
  },
  events: {
    async "input.requested"(event, channel, ctx) {
      const { channelId, conversationId, interactionToken } = channel.discord;
      let anchored = false;
      for (const request of event.requests) {
        const detail = request.action?.toolName === "apply_triage" ? await describeWrite(request.action.input, `${ctx.session.id}:${ctx.session.turn.id}`) : "";
        const body = {
          allowed_mentions: { parse: [] },
          components: renderInputRequestComponents(request),
          content: (detail ? `${detail}\n\n${request.prompt}` : request.prompt).slice(0, 1_900),
        };
        // A run started from a schedule is anchored to the message that opened it. Discord sends the
        // id of the message the button sits on, so buttons on any later message resolve to no session
        // and the approval is dropped. The prompt replaces the opening message instead.
        if (!anchored && !interactionToken && conversationId) {
          // `request` takes plain JSON, and the rendered components are readonly.
          const json = JSON.parse(JSON.stringify(body)) as Parameters<typeof channel.discord.request>[1];
          await channel.discord.request(`/channels/${channelId}/messages/${conversationId}`, json, { botAuth: true, method: "PATCH" });
          anchored = true;
          continue;
        }
        await channel.discord.post(body);
      }
    },
    // eve acknowledges a click and leaves the message as it is, so the buttons of an answered prompt
    // stay clickable. The prompt sits on the opening message. Its buttons are replaced by the answer
    // when the result shows there was a prompt, and cleared otherwise, which is harmless without one.
    async "action.result"(event, channel) {
      const { channelId, conversationId, interactionToken } = channel.discord;
      if (event.result.kind !== "tool-result" || event.result.toolName !== "apply_triage") return;
      if (interactionToken || !conversationId) return;
      const answer = event.status === "rejected" ? "Cancelled" : event.status === "completed" && wasApproved(event.result.output) ? "Approved" : null;
      const components = answer
        ? [{ type: 1, components: [{ type: 2, style: answer === "Approved" ? 3 : 2, label: answer, custom_id: "nuxi:answered", disabled: true }] }]
        : [];
      await channel.discord
        .request(`/channels/${channelId}/messages/${conversationId}`, { components }, { botAuth: true, method: "PATCH" })
        .catch(() => undefined);
    },
  },
});

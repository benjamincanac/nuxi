import { defaultDiscordAuth, discordChannel, renderInputRequestComponents } from "eve/channels/discord";
import { z } from "zod";

import { env } from "../config";
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
  const plan = (await getPlan(runId, ref)) ?? emptyPlan(ref, runId, true);

  const lines = [`**[${owner}/${repo}#${issueNumber}](<https://github.com/${owner}/${repo}/issues/${issueNumber}>)**`];
  if (plan.setType) lines.push(`Type: ${plan.setType}`);
  if (plan.addLabels.length) lines.push(`Add: ${plan.addLabels.join(", ")}`);
  if (plan.removeLabels.length) lines.push(`Remove: ${plan.removeLabels.join(", ")}`);

  const request = plan.facts.includes("REPRODUCTION_REQUEST") && context ? `\n\n${reproductionRequest(context.reproduction)}` : "";
  const mention = context ? mentionLine(context.config, plan) : "";
  const body = [comment, request, mention && `\n\n${mention}`].filter(Boolean).join("");
  if (body) lines.push("", body.length > 900 ? `${body.slice(0, 900)}…` : body);
  return lines.join("\n");
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
      for (const request of event.requests) {
        const detail = request.action?.toolName === "apply_triage" ? await describeWrite(request.action.input, `${ctx.session.id}:${ctx.session.turn.id}`) : "";
        await channel.discord.post({
          components: renderInputRequestComponents(request),
          content: detail ? `${detail}\n\n${request.prompt}` : request.prompt,
        });
      }
    },
  },
});

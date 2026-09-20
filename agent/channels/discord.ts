import { defaultDiscordAuth, discordChannel } from "eve/channels/discord";

import { env } from "../config";
import { discordCredentials } from "../lib/discord";

function maintainerIds(): string[] {
  return (env("DISCORD_MAINTAINER_IDS") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
}

/**
 * Three uses: the `/ask` command for backlog questions (it also works in a DM with the app),
 * the approvals channel where triage runs park on Approve and Cancel buttons, and the weekly digest.
 */
export default discordChannel({
  credentials: discordCredentials,
  onCommand(_ctx, interaction) {
    // The backlog conversation can trigger re-triage, so it is limited to maintainers.
    if (!maintainerIds().includes(interaction.user.id)) return null;
    return { auth: defaultDiscordAuth(interaction) };
  },
});

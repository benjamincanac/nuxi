import { connectDiscordCredentials } from "@vercel/connect/eve";
import { callDiscordApi } from "eve/channels/discord";

import { discordConnector } from "../config";

export const discordCredentials = connectDiscordCredentials(discordConnector());

/** Posts embeds without starting an agent turn. */
export async function postEmbeds(channelId: string, embeds: Record<string, unknown>[]): Promise<void> {
  const response = await callDiscordApi({
    method: "POST",
    path: `/channels/${channelId}/messages`,
    botToken: discordCredentials.botToken,
    body: JSON.parse(JSON.stringify({ embeds, allowed_mentions: { parse: [] } })),
  });
  if (!response.ok) throw new Error(`Discord ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`);
}

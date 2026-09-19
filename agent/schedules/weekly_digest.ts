import { defineSchedule } from "eve/schedules";

import { isProduction } from "../config";
import { buildDigest, digestEmbeds } from "../lib/digest";
import { postEmbeds } from "../lib/discord";
import { listEnabledRepositories } from "../lib/github";

function parisHour(): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }).format(new Date()));
}

/**
 * Monday 09:00 Europe/Paris. Vercel evaluates cron in UTC, so the schedule fires at 07:00 and
 * 08:00 UTC and only the run that lands on 09:00 in Paris posts, whatever the daylight saving time.
 */
export default defineSchedule({
  cron: "0 7,8 * * 1",
  run({ waitUntil }) {
    if (!isProduction() || parisHour() !== 9) return;
    waitUntil(
      (async () => {
        for (const config of await listEnabledRepositories()) {
          if (!config.discord.digestChannel) continue;
          await postEmbeds(config.discord.digestChannel, digestEmbeds(await buildDigest(config)));
        }
      })(),
    );
  },
});

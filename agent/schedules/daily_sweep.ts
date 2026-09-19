import { defineSchedule } from "eve/schedules";

import { isProduction } from "../config";
import { listEnabledRepositories } from "../lib/github";
import { sweepRepo } from "../lib/sweep";

/**
 * 03:00 UTC. Queues the issues to re-evaluate, `dispatch_queue` runs them.
 * Also where new releases and closed upstream issues are picked up: the GitHub channel
 * has no release hook, so `release.published` is detected here instead.
 */
export default defineSchedule({
  cron: "0 3 * * *",
  run({ waitUntil }) {
    // Previews sweep through the ops route only.
    if (!isProduction()) return;
    waitUntil(
      (async () => {
        for (const config of await listEnabledRepositories()) {
          const summary = await sweepRepo(config);
          console.log("[nuxi] sweep", JSON.stringify(summary));
        }
      })(),
    );
  },
});

import { defineSchedule } from "eve/schedules";

import { isProduction } from "../config";
import { listEnabledRepositories, listInstalledRepositories } from "../lib/github";
import { openSetupPullRequest } from "../lib/setup";
import { sweepRepo } from "../lib/sweep";

/**
 * An installation on "all repositories" of a large organization must not receive a setup
 * pull request per repo. Above this size, setup is on request only, through the ops route or Discord.
 */
const AUTO_SETUP_MAX_REPOSITORIES = 10;

/**
 * 03:00 UTC. Queues the issues to re-evaluate, `dispatch_queue` runs them.
 * Also where new releases and closed upstream issues are picked up: the GitHub channel
 * has no release hook, so `release.published` is detected here instead. The same goes for
 * installs: there is no installation hook, so newly installed repos get their setup PR here.
 */
export default defineSchedule({
  cron: "0 3 * * *",
  run({ waitUntil }) {
    // Previews sweep through the ops route only.
    if (!isProduction()) return;
    waitUntil(
      (async () => {
        const enabled = await listEnabledRepositories();
        for (const config of enabled) {
          // One failing repository must not stop the others, nor the setup pass below.
          const summary = await sweepRepo(config).catch((error: unknown) => ({ repo: `${config.owner}/${config.repo}`, failed: String(error) }));
          console.log("[nuxi] sweep", JSON.stringify(summary));
        }

        if (process.env.NUXI_AUTO_SETUP === "false") return;
        const installed = await listInstalledRepositories();
        if (installed.length > AUTO_SETUP_MAX_REPOSITORIES) return;
        for (const ref of installed) {
          // Idempotent: repos with a config file or a past setup PR, merged or closed, are left alone.
          const result = await openSetupPullRequest(ref).catch((error: unknown) => ({ status: "failed", reason: String(error) }));
          if (result.status !== "configured" && result.status !== "exists") console.log(`[nuxi] setup ${ref.owner}/${ref.repo}`, JSON.stringify(result));
        }
      })(),
    );
  },
});

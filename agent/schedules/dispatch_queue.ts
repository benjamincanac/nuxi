import { defineSchedule } from "eve/schedules";

import { drainAndDispatch } from "../lib/dispatch";
import { DISPATCH_BATCH, runRepoPasses } from "../lib/sweep";

/**
 * Starts the triage sessions queued by the GitHub hooks, the sweep and the ops route, and runs the
 * setup and first-sweep passes the hooks asked for, which are too slow to do inside a webhook.
 */
export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil, appAuth }) {
    waitUntil(runRepoPasses().then(() => drainAndDispatch(to, appAuth, DISPATCH_BATCH)));
  },
});

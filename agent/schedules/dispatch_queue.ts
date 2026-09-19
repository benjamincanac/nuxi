import { defineSchedule } from "eve/schedules";

import { drainAndDispatch } from "../lib/dispatch";
import { DISPATCH_BATCH } from "../lib/sweep";

/** Starts the triage sessions queued by the GitHub hooks, the sweep and the ops route. */
export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil, appAuth }) {
    waitUntil(drainAndDispatch(to, appAuth, DISPATCH_BATCH));
  },
});

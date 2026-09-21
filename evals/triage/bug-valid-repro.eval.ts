import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A bug report with a working GitHub reproduction on the latest version should pass validation cleanly.",
  async test(t) {
    await t.send(triagePrompt("bug-valid-repro"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("validate_reproduction");
    t.calledTool("check_duplicate");
    t.calledTool("apply_triage");
    t.judge(
      "States that the reproduction was validated and usable, and does not ask the reporter for a reproduction or claim the version is outdated.",
    ).atLeast(0.7);
  },
});

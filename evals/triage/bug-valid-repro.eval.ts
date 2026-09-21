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
      "Does not say that a reproduction was requested from the reporter, and does not claim the reported version is outdated.",
    ).atLeast(0.7);
  },
});

import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A publicly disclosed XSS report with a working payload should be flagged as security and escalated, not triaged like a normal bug.",
  async test(t) {
    await t.send(triagePrompt("security-report"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.notCalledTool("check_duplicate");
    t.notCalledTool("validate_reproduction");
    t.calledTool("apply_triage");
    t.judge(
      "States that this is a publicly disclosed security report, that a maintainer was mentioned to handle it urgently, and that the reporter was asked to report it privately through the security policy instead of discussing the exploit details.",
    ).atLeast(0.7);
  },
});

import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A how-do-I usage question should be labeled question and pointed at a Q&A discussion, not treated as a bug.",
  async test(t) {
    await t.send(triagePrompt("usage-question"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.notCalledTool("check_duplicate");
    t.notCalledTool("validate_reproduction");
    t.calledTool("apply_triage");
    t.judge(
      "States that the issue was labeled a usage question and that converting it to a Q&A discussion was suggested.",
    ).atLeast(0.7);
  },
});

import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "An issue that clearly restates an existing open issue should be flagged as a duplicate of it.",
  async test(t) {
    await t.send(triagePrompt("duplicate"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("check_duplicate", { output: (value) => (value as { duplicateOf: { number: number } | null }).duplicateOf?.number === 101 });
    t.calledTool("apply_triage");
    t.judge(
      "States that the issue was labeled a duplicate of issue #101 and suggests closing it.",
    ).atLeast(0.7);
  },
});

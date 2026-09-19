import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A hostile, vague rant with no actionable detail should be escalated to a maintainer instead of triaged automatically.",
  async test(t) {
    await t.send(triagePrompt("ambiguous-rant"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.notCalledTool("check_duplicate");
    t.notCalledTool("validate_reproduction");
    t.calledTool("apply_triage", { output: (value) => (value as { comment: string | null }).comment === null });
    t.judge.autoevals
      .closedQA(
        "States that the issue was left for a maintainer to handle personally, without labeling it or posting a substantive comment to the reporter.",
        { on: t.transcript },
      )
      .atLeast(0.7);
  },
});

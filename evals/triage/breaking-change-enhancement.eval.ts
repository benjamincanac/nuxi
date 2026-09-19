import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "An enhancement request that would need a breaking change should be labeled for the next major version.",
  async test(t) {
    await t.send(triagePrompt("breaking-change-enhancement"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("apply_triage");
    t.judge.autoevals
      .closedQA(
        "States that the v5 label was added to the issue.",
        { on: t.transcript },
      )
      .atLeast(0.7);
  },
});

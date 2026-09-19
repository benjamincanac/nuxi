import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A bug report with no reproduction at all should be labeled needs reproduction.",
  async test(t) {
    await t.send(triagePrompt("bug-no-repro"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("apply_triage");
    t.judge.autoevals
      .closedQA(
        "States that the issue was labeled needs reproduction and that a reproduction was requested from the reporter.",
        { on: t.transcript },
      )
      .atLeast(0.7);
  },
});

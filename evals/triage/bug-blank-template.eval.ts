import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A reproduction link that is just the unmodified starter template should be rejected as not usable.",
  async test(t) {
    await t.send(triagePrompt("bug-blank-template"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("validate_reproduction");
    t.calledTool("apply_triage");
    t.judge.autoevals
      .closedQA(
        "States that the issue was labeled needs reproduction and that a reproduction was requested, because the link provided is an unmodified starter template rather than a real repro.",
        { on: t.transcript },
      )
      .atLeast(0.7);
  },
});

import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A missing aria-sort report should be recognized as an accessibility issue and labeled a11y.",
  async test(t) {
    await t.send(triagePrompt("a11y-report"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("apply_triage");
    t.judge.autoevals
      .closedQA("States that the a11y label was added to the issue.", {
        on: t.transcript,
      })
      .atLeast(0.7);
  },
});

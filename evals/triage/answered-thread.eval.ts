import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A thread where a maintainer answered and the reporter confirmed it works should be labeled answered.",
  async test(t) {
    await t.send(triagePrompt("answered-thread"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("apply_triage");
    t.judge.autoevals
      .closedQA(
        "States that the thread looks resolved, that it was labeled answered, and suggests closing it, based on the maintainer's answer and the reporter's confirmation.",
        { on: t.transcript },
      )
      .atLeast(0.7);
  },
});

import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A thread where a maintainer answered and the reporter confirmed it works should be labeled answered.",
  async test(t) {
    await t.send(triagePrompt("answered-thread"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("apply_triage");
    t.judge(
      "States that the issue was labeled answered and that a maintainer was prompted to consider closing it.",
    ).atLeast(0.7);
  },
});

import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

export default defineEval({
  description: "A reproduction link that is just the unmodified starter template should be rejected as not usable.",
  async test(t) {
    const turn = await t.send(triagePrompt("bug-blank-template"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("validate_reproduction");
    t.calledTool("apply_triage");
    t.judge(
      "Says the link provided is an unmodified starter template and asks for a real reproduction.",
      { on: postedComment(turn) },
    ).atLeast(0.7);
  },
});

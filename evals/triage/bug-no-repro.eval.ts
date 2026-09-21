import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

export default defineEval({
  description: "A bug report with no reproduction at all should be labeled needs reproduction.",
  async test(t) {
    const turn = await t.send(triagePrompt("bug-no-repro"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("apply_triage");
    t.judge(
      "Asks the reporter for a reproduction.",
      { on: postedComment(turn) },
    ).atLeast(0.7);
  },
});

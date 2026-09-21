import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

export default defineEval({
  description: "A crash whose stack trace and behavior point into reka-ui should be labeled upstream and tracked there.",
  async test(t) {
    const turn = await t.send(triagePrompt("upstream-reka"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("track_upstream");
    t.judge(
      "Says the root cause looks upstream in reka-ui and links a matching upstream issue.",
      { on: postedComment(turn) },
    ).atLeast(0.7);
  },
});

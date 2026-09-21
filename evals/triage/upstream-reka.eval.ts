import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A crash whose stack trace and behavior point into reka-ui should be labeled upstream and tracked there.",
  async test(t) {
    await t.send(triagePrompt("upstream-reka"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("track_upstream");
    t.judge(
      "States that the root cause looks upstream in reka-ui and that a matching upstream issue was found and linked.",
    ).atLeast(0.7);
  },
});

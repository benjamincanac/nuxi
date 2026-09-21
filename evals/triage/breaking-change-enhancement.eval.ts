import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "An enhancement request that would need a breaking change should be labeled for the next major version.",
  async test(t) {
    await t.send(triagePrompt("breaking-change-enhancement"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("apply_triage");
    t.judge(
      "Names the v5 label among the labels added or planned for the issue. A dry-run counts.",
    ).atLeast(0.7);
  },
});

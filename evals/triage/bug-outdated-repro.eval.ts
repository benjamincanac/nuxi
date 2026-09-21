import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

export default defineEval({
  description: "A valid reproduction pinned to an older package version should prompt a retest on the latest version.",
  async test(t) {
    const turn = await t.send(triagePrompt("bug-outdated-repro"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("validate_reproduction");
    t.calledTool("apply_triage");
    t.judge(
      "Says the reproduction uses an older version than the latest release and asks the reporter to retest on the latest version.",
      { on: postedComment(turn) },
    ).atLeast(0.7);
  },
});

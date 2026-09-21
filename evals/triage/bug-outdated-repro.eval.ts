import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A valid reproduction pinned to an older package version should prompt a retest on the latest version.",
  async test(t) {
    await t.send(triagePrompt("bug-outdated-repro"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("validate_reproduction");
    t.calledTool("apply_triage");
    t.judge(
      "States that the reproduction uses an older version of the package than the latest release and asks the reporter to retest on the latest version.",
    ).atLeast(0.7);
  },
});

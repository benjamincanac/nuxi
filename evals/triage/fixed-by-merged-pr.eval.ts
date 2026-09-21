import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

export default defineEval({
  description: "A bug already fixed by a merged pull request shipped in a release should be labeled needs verification.",
  async test(t) {
    const turn = await t.send(triagePrompt("fixed-by-merged-pr"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("check_fixed_in_release", { output: (value) => (value as { fixedBy: { release: string } | null }).fixedBy?.release === "v1.4.0" });
    t.calledTool("apply_triage");
    t.judge(
      "Says the issue looks fixed by a merged pull request released in v1.4.0 and asks the reporter to confirm on the latest version.",
      { on: postedComment(turn) },
    ).atLeast(0.7);
  },
});

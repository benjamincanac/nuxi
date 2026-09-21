import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

export default defineEval({
  description: "An issue that clearly restates an existing open issue should be flagged as a duplicate of it.",
  async test(t) {
    const turn = await t.send(triagePrompt("duplicate"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("check_duplicate", { output: (value) => (value as { duplicateOf: { number: number } | null }).duplicateOf?.number === 101 });
    t.calledTool("apply_triage");
    t.judge(
      "Says this looks like a duplicate of #101, links it, and asks a maintainer to consider closing it.",
      { on: postedComment(turn) },
    ).atLeast(0.7);
  },
});

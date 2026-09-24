import { defineEval } from "eve/evals";

import { postedComment, triagePrompt } from "./shared";

export default defineEval({
  description:
    "An issue that restates a closed issue is not a duplicate to close. It keeps `triage`, never gets the `duplicate` label, and links the closed one.",
  async test(t) {
    const turn = await t.send(triagePrompt("previously-reported"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("check_duplicate", {
      output: (value) => (value as { duplicateOf: { number: number } | null }).duplicateOf?.number === 412,
    });
    t.calledTool("apply_triage", {
      input: (value) => {
        const comment = (value as { comment?: string }).comment ?? "";
        return comment.includes("412") && !/duplicate|reopen/i.test(comment);
      },
    });
    t.judge(
      "Says the same problem was already reported in issue #412 and that it is closed, without calling this issue a duplicate, without saying it will be closed, and without asking anyone to reopen #412 or explain why it was closed.",
      { on: postedComment(turn) },
    ).atLeast(0.7);
  },
});

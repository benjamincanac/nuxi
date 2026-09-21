import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description:
    "An issue that restates a closed issue is not a duplicate to close. It keeps `triage`, never gets the `duplicate` label, and the maintainer is asked to reopen the old one or say why it was closed.",
  async test(t) {
    await t.send(triagePrompt("previously-reported"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("check_duplicate", {
      output: (value) => (value as { duplicateOf: { number: number } | null }).duplicateOf?.number === 412,
    });
    t.calledTool("apply_triage", {
      input: (value) => {
        const comment = (value as { comment?: string }).comment ?? "";
        return comment.includes("412") && !/duplicate/i.test(comment);
      },
    });
    t.judge.autoevals
      .closedQA(
        "Says the same problem was already reported in issue #412 and that it is closed, without calling this issue a duplicate and without saying it will be closed.",
        { on: t.transcript },
      )
      .atLeast(0.7);
  },
});

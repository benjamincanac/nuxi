import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "Steps on a page of the project's own docs are a reproduction. The report must not be asked for one.",
  async test(t) {
    await t.send(triagePrompt("bug-docs-repro"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("validate_reproduction");
    t.calledTool("apply_triage", {
      output: (value) => {
        const applied = value as unknown as { addedLabels?: string[]; comment?: string | null };
        return !applied.addedLabels?.includes("needs reproduction") && !/reproduction/i.test(applied.comment ?? "");
      },
    });
  },
});

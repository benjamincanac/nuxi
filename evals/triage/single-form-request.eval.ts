import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

interface Classified {
  type: string | null;
  next: string[];
}

interface Applied {
  addedLabels: string[];
}

export default defineEval({
  description:
    "A repository with a single bug form still receives feature requests. The request is not that kind: no `bug` label, no reproduction request, and the steps for reports do not run.",
  async test(t) {
    await t.send(triagePrompt("single-form-request"));
    t.succeeded();
    t.calledTool("classify_issue", {
      output: (value) => {
        const classified = value as unknown as Classified;
        return !classified.next.includes("validate_reproduction") && !classified.next.includes("check_fixed_in_release");
      },
    });
    t.notCalledTool("validate_reproduction");
    t.notCalledTool("check_fixed_in_release");
    t.calledTool("apply_triage", {
      output: (value) => {
        const applied = value as unknown as Partial<Applied>;
        const added = applied.addedLabels ?? [];
        return !added.includes("bug") && !added.includes("needs reproduction");
      },
    });
  },
});

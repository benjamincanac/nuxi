import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

interface Applied {
  setType: string | null;
  addedLabels: string[];
  removedLabels: string[];
}

export default defineEval({
  description:
    "A repository whose forms mark a bug with the `bug` label and no Issue Type gets that label, no type, and loses its own intake label.",
  async test(t) {
    await t.send(triagePrompt("kind-as-label"));
    t.succeeded();
    t.calledTool("classify_issue");
    t.calledTool("apply_triage", {
      output: (value) => {
        const applied = value as unknown as Applied;
        return (
          applied.setType === null &&
          applied.addedLabels.includes("bug") &&
          applied.addedLabels.includes("needs reproduction") &&
          !applied.addedLabels.includes("enhancement") &&
          applied.removedLabels.includes("needs triage")
        );
      },
    });
  },
});

import { defineEval } from "eve/evals";

import { triagePrompt } from "./shared";

export default defineEval({
  description: "A bug the sandbox reproduces on the latest version is confirmed, so it loses its intake label.",
  async test(t) {
    await t.send(triagePrompt("bug-reproduced"));
    t.succeeded();
    t.calledTool("validate_reproduction");
    t.calledTool("run_sandbox_repro", { output: (value) => (value as unknown as { outcome: string }).outcome === "reproduced" });
    t.calledTool("apply_triage", {
      output: (value) => (value as unknown as { removedLabels: string[] }).removedLabels.includes("triage"),
    });
  },
});

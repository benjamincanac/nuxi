import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  judge: { model: "anthropic/claude-sonnet-5" },
  timeoutMs: 120_000,
});

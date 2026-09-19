import { defineAgent } from "eve";
import { autoModel } from "eve/experimental/evaluate";

export default defineAgent({
  // Jev picks the writing model per turn. Classification never happens here: every closed
  // decision is taken by Jev inside the tools, the model writes the comment and picks the mention template.
  model: autoModel({
    options: {
      "anthropic/claude-sonnet-5":
        "Writing comments for ambiguous, escalated or duplicate issues, reading screenshots, and answering a maintainer's backlog questions",
      "anthropic/claude-haiku-4.5": "Routine issues where Jev results are high-confidence",
    },
  }),
  reasoning: "low",
});

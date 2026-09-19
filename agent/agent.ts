import { defineAgent } from "eve";

export default defineAgent({
  // nuxi never needs bash, file, web or subagent tools: every capability is an authored tool.
  // Fewer tools in the prompt is cheaper and keeps a small model on the pipeline.
  defaultTools: false,
  // Every decision is taken by Jev inside the tools. The model only follows the skill, writes the
  // comment and picks the mention template, so the cheapest model is enough.
  model: "deepseek/deepseek-v4.1-flash",
  reasoning: "none",
});

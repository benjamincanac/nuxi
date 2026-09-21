import { defineTool } from "eve/tools";
import { z } from "zod";

import { searchIssues } from "../lib/github";
import { refuseDuringTriage } from "../lib/tool";

export default defineTool({
  description:
    "Searches issues and pull requests with the GitHub search syntax, for a maintainer's backlog questions. Read-only. Example queries: `repo:owner/name is:issue is:open label:duplicate`, `repo:owner/name is:issue is:open dropdown`.",
  inputSchema: z.object({
    query: z.string().min(1).describe("A GitHub search query. Always scope it with `repo:owner/name`."),
    limit: z.number().int().min(1).max(30).default(10),
  }),
  label: { start: ({ query }) => `Search ${query}` },
  async execute({ query, limit }, ctx) {
    await refuseDuringTriage(ctx);
    const items = await searchIssues(query, limit, ctx.abortSignal);
    return {
      results: items.map((item) => ({
        number: item.number,
        title: item.title,
        state: item.state,
        url: item.html_url,
        labels: item.labels.map((label) => (typeof label === "string" ? label : label.name)),
        thumbsUp: item.reactions?.["+1"] ?? 0,
        updatedAt: item.updated_at,
      })),
    };
  },
});

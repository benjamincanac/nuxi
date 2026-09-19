/**
 * Runs the whole open backlog of a repo in dry-run and writes a CSV.
 *
 *   pnpm backfill <owner/repo> [--config path.yml] [--limit 50] [--out backfill.csv]
 *   pnpm backfill <owner/repo> --url https://<deployment> [--limit 50] [--out backfill.csv]
 *
 * Local mode calls Jev and GitHub from this machine and skips the sandbox step.
 * With `--url` the deployment runs real sessions, sandbox included, and the rows are read back
 * from its decision log. Needs INTERNAL_API_SECRET. Nothing is ever written to GitHub.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { z } from "zod";

import { parseRepoConfig, resolveRepoConfig, type RepoConfig } from "../agent/config";
import { loadTriageContext } from "../agent/lib/context";
import { listOpenIssues, loadRepoConfig } from "../agent/lib/github";
import { runPipeline } from "../agent/lib/pipeline";

function token(): string {
  return process.env.GITHUB_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}
process.env.NUXI_SCRIPT_TOKEN ??= token();

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    limit: { type: "string" },
    out: { type: "string", default: "backfill.csv" },
    url: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

const slug = positionals[0] ?? "";
if (values.help || !/^[\w.-]+\/[\w.-]+$/.test(slug)) {
  console.log("Usage: pnpm backfill <owner/repo> [--config path.yml] [--url https://deployment] [--limit n] [--out file.csv]");
  process.exit(values.help ? 0 : 1);
}
const [owner = "", repo = ""] = slug.split("/");
const limit = values.limit ? Number(values.limit) : undefined;

interface Row {
  issue: number;
  url: string;
  title: string;
  skipped: string;
  escalate: boolean;
  type: string;
  addLabels: string[];
  removeLabels: string[];
  mentions: string[];
  sandbox: string;
  facts: string[];
  probabilities: Record<string, number>;
}

/** Flattens raw Jev answers into `step.question` columns: P(true), selected option probability, or score. */
function probabilities(answers: Record<string, unknown>): Record<string, number> {
  const answer = z.object({
    probability: z.number().optional(),
    score: z.number().optional(),
    choice: z.string().optional(),
    probabilities: z.record(z.string(), z.number()).optional(),
  });
  const out: Record<string, number> = {};
  for (const [step, questions] of Object.entries(answers)) {
    const parsed = z.record(z.string(), answer).safeParse(questions);
    if (!parsed.success) continue;
    for (const [id, value] of Object.entries(parsed.data)) {
      // Area questions are only interesting when they fire.
      if (id.startsWith("area_") && (value.probability ?? 0) < 0.5) continue;
      const number = value.probability ?? value.score ?? (value.choice ? (value.probabilities?.[value.choice] ?? 1) : undefined);
      if (number !== undefined) out[`${step}.${id}${value.choice ? `=${value.choice}` : ""}`] = Math.round(number * 1_000) / 1_000;
    }
  }
  return out;
}

function csv(rows: Row[]): string {
  const cell = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
  const header = ["issue", "url", "title", "skipped", "escalate", "type", "add_labels", "remove_labels", "mentions", "sandbox", "facts", "probabilities"];
  const lines = rows.map((row) =>
    [
      row.issue,
      row.url,
      row.title,
      row.skipped,
      row.escalate,
      row.type,
      row.addLabels.join(" | "),
      row.removeLabels.join(" | "),
      row.mentions.join(" | "),
      row.sandbox,
      row.facts.join(" | "),
      JSON.stringify(row.probabilities),
    ]
      .map(cell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

async function local(): Promise<Row[]> {
  let config: RepoConfig | null;
  if (values.config) {
    const parsed = parseRepoConfig(await readFile(values.config, "utf8"));
    if (!parsed.ok) throw new Error(parsed.error);
    config = resolveRepoConfig(owner, repo, parsed.config);
  } else {
    config = await loadRepoConfig({ owner, repo });
  }
  if (!config) throw new Error(`${slug} has no valid .github/nuxi.yml. Pass --config to use a local file.`);
  config = { ...config, dryRun: true };

  const issues = (await listOpenIssues(config)).slice(0, limit);
  const rows: Row[] = [];
  for (const [index, summary] of issues.entries()) {
    process.stdout.write(`\r${index + 1}/${issues.length} #${summary.issueNumber}   `);
    try {
      const context = await loadTriageContext(summary, undefined, config);
      if (!context) continue;
      const { plan, answers } = await runPipeline(context);
      rows.push({
        issue: summary.issueNumber,
        url: summary.url,
        title: summary.title,
        skipped: plan.skipped ?? "",
        escalate: plan.escalate,
        type: plan.setType ?? "",
        addLabels: plan.addLabels,
        removeLabels: plan.removeLabels,
        mentions: plan.mentions.map((mention) => mention.template),
        sandbox: plan.sandbox?.outcome ?? "not run",
        facts: plan.facts,
        probabilities: probabilities(answers),
      });
    } catch (error) {
      console.error(`\n#${summary.issueNumber} failed:`, error instanceof Error ? error.message : error);
    }
  }
  process.stdout.write("\n");
  return rows;
}

const decisionSchema = z.object({
  issueNumber: z.number(),
  step: z.string(),
  answers: z.unknown(),
  actions: z.unknown(),
});

const appliedSchema = z.object({
  blocked: z.string().nullable(),
  setType: z.string().nullable(),
  addedLabels: z.array(z.string()),
  removedLabels: z.array(z.string()),
  comment: z.string().nullable(),
});

async function remote(base: string): Promise<Row[]> {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) throw new Error("INTERNAL_API_SECRET is required with --url");
  const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };

  const started = await fetch(new URL("/ops/backfill/trigger", base), { method: "POST", headers, body: JSON.stringify({ repo: slug, limit }) });
  if (!started.ok) throw new Error(`Trigger failed: ${started.status} ${await started.text()}`);
  const { queued, since, etaMinutes } = z.object({ queued: z.number(), since: z.string(), etaMinutes: z.number() }).parse(await started.json());
  console.log(`Queued ${queued} issues, about ${etaMinutes} minutes. Polling the decision log.`);

  const byIssue = new Map<number, z.output<typeof decisionSchema>[]>();
  const deadline = Date.now() + (etaMinutes + 30) * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    const response = await fetch(new URL(`/ops/decisions?repo=${encodeURIComponent(slug)}&since=${encodeURIComponent(since)}`, base), { headers });
    if (!response.ok) continue;
    byIssue.clear();
    for (const line of (await response.text()).split("\n").filter(Boolean)) {
      const decision = decisionSchema.parse(JSON.parse(line));
      byIssue.set(decision.issueNumber, [...(byIssue.get(decision.issueNumber) ?? []), decision]);
    }
    const done = [...byIssue.values()].filter((decisions) => decisions.some((decision) => decision.step === "apply")).length;
    process.stdout.write(`\r${done}/${queued} applied   `);
    if (done >= queued) break;
  }
  process.stdout.write("\n");

  return [...byIssue.entries()].map(([issue, decisions]) => {
    const applied = appliedSchema.safeParse(decisions.findLast((decision) => decision.step === "apply")?.actions);
    const sandbox = z.object({ outcome: z.string() }).safeParse(decisions.findLast((decision) => decision.step === "sandbox")?.actions);
    const answers = Object.fromEntries(decisions.filter((decision) => decision.answers).map((decision) => [decision.step, decision.answers]));
    return {
      issue,
      url: `https://github.com/${slug}/issues/${issue}`,
      title: "",
      skipped: applied.success ? (applied.data.blocked ?? "") : "no apply step",
      escalate: applied.success ? (applied.data.blocked?.startsWith("needs_human") ?? false) : false,
      type: applied.success ? (applied.data.setType ?? "") : "",
      addLabels: applied.success ? applied.data.addedLabels : [],
      removeLabels: applied.success ? applied.data.removedLabels : [],
      mentions: [],
      sandbox: sandbox.success ? sandbox.data.outcome : "not run",
      facts: applied.success && applied.data.comment ? [applied.data.comment.replaceAll("\n", " ")] : [],
      probabilities: probabilities(answers),
    };
  });
}

const rows = values.url ? await remote(values.url) : await local();
const out = values.out ?? "backfill.csv";
await writeFile(out, csv(rows.sort((a, b) => a.issue - b.issue)));
console.log(`Wrote ${rows.length} rows to ${out}`);

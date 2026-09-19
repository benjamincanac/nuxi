/**
 * Creates the labels a repo's `.github/nuxi.yml` expects. Never edits or deletes an existing
 * label, only creates the ones that are missing.
 *
 *   pnpm labels <owner/repo> [--config path.yml] [--dry-run]
 *
 * Reads `.github/nuxi.yml` from the repo itself, or a local file when `--config` is given.
 */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { z } from "zod";

import { CONFIG_PATH, componentLabel, parseRepoConfig, upstreamLabel } from "../agent/config";
import { gh, ghText, listComponents } from "../agent/lib/github";


function resolveToken(): void {
  if (process.env.NUXI_SCRIPT_TOKEN) return;
  if (process.env.GITHUB_TOKEN) {
    process.env.NUXI_SCRIPT_TOKEN = process.env.GITHUB_TOKEN;
    return;
  }
  try {
    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    if (token) process.env.NUXI_SCRIPT_TOKEN = token;
  } catch {
    // No token available. Requests below fail with a clear GitHub auth error.
  }
}
resolveToken();


interface LabelDef {
  name: string;
  color: string;
  description: string;
}

const FIXED_LABELS: LabelDef[] = [
  { name: "duplicate", color: "cfd3d7", description: "This issue or pull request already exists" },
  { name: "answered", color: "c5def5", description: "Answered and unlikely to need further action" },
  { name: "question", color: "d876e3", description: "Further information is requested" },
  { name: "needs verification", color: "fbca04", description: "Needs confirmation the issue still reproduces" },
  { name: "has pr", color: "0e8a16", description: "A pull request addresses this" },
  { name: "a11y", color: "5319e7", description: "Accessibility issue" },
  { name: "needs reproduction", color: "e99695", description: "Needs a minimal reproduction to act on" },
  { name: "triage", color: "ededed", description: "Needs triage" },
  { name: "stale", color: "eeeeee", description: "No recent activity" },
];

const labelSchema = z.object({
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
});

async function listExistingLabels(
  owner: string,
  repo: string,
): Promise<Map<string, z.output<typeof labelSchema>>> {
  const labels = new Map<string, z.output<typeof labelSchema>>();
  for (let page = 1; page <= 10; page++) {
    const batch = await gh(z.array(labelSchema), `/repos/${owner}/${repo}/labels?per_page=100&page=${page}`, {
      owner,
    });
    for (const label of batch) labels.set(label.name.toLowerCase(), label);
    if (batch.length < 100) break;
  }
  return labels;
}

async function createLabel(owner: string, repo: string, label: LabelDef): Promise<void> {
  await gh(z.unknown(), `/repos/${owner}/${repo}/labels`, {
    owner,
    method: "POST",
    body: { name: label.name, color: label.color, description: label.description },
  });
}

function printUsage(): void {
  console.log(
    "Usage: pnpm labels <owner/repo> [--config path.yml] [--dry-run]\n\n" +
      "Creates the labels a repo's .github/nuxi.yml expects. Only creates labels that are\n" +
      "missing; never edits or deletes an existing one.",
  );
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  printUsage();
  process.exit(0);
}

const slug = positionals[0];
if (!slug) {
  printUsage();
  process.exit(1);
}

const [owner, repo] = slug.split("/");
if (!owner || !repo) {
  console.error(`Expected <owner/repo>, got "${slug}"`);
  process.exit(1);
}

const source = values.config
  ? await readFile(values.config, "utf8")
  : await ghText(`/repos/${owner}/${repo}/contents/${CONFIG_PATH}`, { owner });

if (source === null) {
  console.error(`No ${CONFIG_PATH} found in ${slug}. Pass --config to validate a local file instead.`);
  process.exit(1);
}

const parsed = parseRepoConfig(source);
if (!parsed.ok) {
  console.error(`Invalid config:\n\n${parsed.error}`);
  process.exit(1);
}
const config = parsed.config;

const desired: LabelDef[] = [...FIXED_LABELS];

if (config.nextMajor) {
  desired.push({
    name: config.nextMajor.label,
    color: "b60205",
    description: "Breaking change targeted at the next major version",
  });
}

for (const upstream of config.upstreams) {
  desired.push({
    name: upstreamLabel(upstream),
    color: "1d76db",
    description: `Blocked on ${upstream}`,
  });
}

if (config.components) {
  const componentsSlug = config.componentsSource ?? slug;
  const [componentsOwner = owner, componentsRepo = repo] = componentsSlug.split("/");
  const components = await listComponents({ owner: componentsOwner, repo: componentsRepo }, config.components);
  for (const component of components) {
    desired.push({
      name: componentLabel(component),
      color: "bfd4f2",
      description: `Scoped to the ${component} component`,
    });
  }
}

const seen = new Set<string>();
const uniqueDesired = desired.filter((label) => {
  const key = label.name.toLowerCase();
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const existing = await listExistingLabels(owner, repo);
const created: string[] = [];
const present: string[] = [];

for (const label of uniqueDesired) {
  if (existing.has(label.name.toLowerCase())) {
    present.push(label.name);
    continue;
  }
  if (values["dry-run"]) {
    console.log(`[dry-run] would create "${label.name}"`);
  } else {
    await createLabel(owner, repo, label);
  }
  created.push(label.name);
}

console.log(`\n${slug}: ${created.length} ${values["dry-run"] ? "to create" : "created"}, ${present.length} already present.`);
if (created.length) console.log(`${values["dry-run"] ? "To create" : "Created"}: ${created.join(", ")}`);
if (present.length) console.log(`Present: ${present.join(", ")}`);

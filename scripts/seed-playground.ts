/**
 * Copies a sample of issues from one repo into a playground repo, for testing triage without
 * touching real traffic.
 *
 *   pnpm seed --from <owner/repo> --to <owner/repo> [--count 30]
 *                                    [--issues 1,2,3] [--dry-run]
 *
 * Copies title, body, labels (created in the target if missing) and comments, rendered as
 * quoted blocks. Idempotent: every copy carries a hidden `<!-- nuxi-seed:owner/repo#n -->`
 * marker in its body, and issues already carrying that marker are skipped on a rerun.
 *
 * Without `--issues`, picks a mix: some `triage`, some `needs reproduction`, some
 * `enhancement`, some closed `duplicate` issues (together with the issue they duplicate, when
 * a "Duplicate of #123" reference can be found in their comments or body), and some closed
 * threads with 3+ comments (answered threads).
 *
 * @-mentions in copied text are neutralized with a zero width space so nobody gets notified.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { z } from "zod";

import { gh, getIssue, searchIssues, type Issue, type IssueComment, type RepoRef } from "../agent/lib/github";


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



const ZWSP = "​";

function mention(login: string): string {
  return `@${ZWSP}${login}`;
}

function neutralizeMentions(text: string): string {
  return text.replace(/@(\w[\w-]*)/g, (_match, login: string) => mention(login));
}

function quoteComment(comment: IssueComment): string {
  const date = comment.createdAt.slice(0, 10);
  const quotedBody = neutralizeMentions(comment.body)
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  return `> **${mention(comment.author)}** on ${date}:\n>\n${quotedBody}`;
}

function marker(from: RepoRef, issueNumber: number): string {
  return `<!-- nuxi-seed:${from.owner}/${from.repo}#${issueNumber} -->`;
}

function buildBody(from: RepoRef, issue: Issue): string {
  const parts = [neutralizeMentions(issue.body || "_No description provided._")];
  for (const comment of issue.comments) parts.push(quoteComment(comment));
  parts.push(`Copied from ${issue.url}`);
  parts.push(marker(from, issue.issueNumber));
  return parts.join("\n\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const labelSchema = z.object({ name: z.string(), color: z.string(), description: z.string().nullable() });

async function loadExistingLabelNames(owner: string, repo: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (let page = 1; page <= 10; page++) {
    const batch = await gh(z.array(labelSchema), `/repos/${owner}/${repo}/labels?per_page=100&page=${page}`, {
      owner,
    });
    for (const label of batch) names.add(label.name.toLowerCase());
    if (batch.length < 100) break;
  }
  return names;
}

async function ensureLabel(
  owner: string,
  repo: string,
  name: string,
  existing: Set<string>,
  dryRun: boolean,
): Promise<void> {
  if (existing.has(name.toLowerCase())) return;
  if (dryRun) {
    console.log(`[dry-run] would create label "${name}" in ${owner}/${repo}`);
  } else {
    await gh(z.unknown(), `/repos/${owner}/${repo}/labels`, {
      owner,
      method: "POST",
      body: { name, color: "ededed", description: "Copied from the source repo while seeding the playground" },
    });
  }
  existing.add(name.toLowerCase());
}

const issueListItemSchema = z.object({
  number: z.number(),
  body: z.string().nullable(),
  pull_request: z.unknown().optional(),
});

/** owner/repo#n markers already present in the target repo's issue bodies. */
async function loadExistingMarkers(owner: string, repo: string): Promise<Set<string>> {
  const markers = new Set<string>();
  for (let page = 1; page <= 10; page++) {
    const batch = await gh(
      z.array(issueListItemSchema),
      `/repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}`,
      { owner },
    );
    for (const issue of batch) {
      if (issue.pull_request !== undefined) continue;
      const match = issue.body?.match(/<!-- nuxi-seed:(\S+) -->/);
      if (match?.[1]) markers.add(match[1]);
    }
    if (batch.length < 100) break;
  }
  return markers;
}

const createdIssueSchema = z.object({ html_url: z.string(), number: z.number() });

async function createIssue(
  owner: string,
  repo: string,
  title: string,
  body: string,
  labels: string[],
): Promise<{ url: string; number: number }> {
  const created = await gh(createdIssueSchema, `/repos/${owner}/${repo}/issues`, {
    owner,
    method: "POST",
    body: { title, body, labels },
  });
  return { url: created.html_url, number: created.number };
}

interface Bucket {
  query: string;
  take: number;
  findDuplicateOriginal?: boolean;
}

/** A mix of open triage/reproduction/enhancement issues plus closed duplicate and answered threads. */
async function selectIssueNumbers(from: RepoRef, count: number): Promise<number[]> {
  const numbers: number[] = [];
  const add = (n: number): void => {
    if (numbers.length < count && !numbers.includes(n)) numbers.push(n);
  };

  const repoQuery = `repo:${from.owner}/${from.repo}`;
  const buckets: Bucket[] = [
    { query: `${repoQuery} is:issue is:open label:triage`, take: Math.ceil(count * 0.3) },
    { query: `${repoQuery} is:issue is:open label:"needs reproduction"`, take: Math.ceil(count * 0.2) },
    { query: `${repoQuery} is:issue is:open label:enhancement`, take: Math.ceil(count * 0.2) },
    {
      query: `${repoQuery} is:issue is:closed label:duplicate`,
      take: Math.ceil(count * 0.15),
      findDuplicateOriginal: true,
    },
    { query: `${repoQuery} is:issue is:closed comments:>=3`, take: Math.ceil(count * 0.15) },
  ];

  for (const bucket of buckets) {
    if (numbers.length >= count) break;
    let items: { number: number }[] = [];
    try {
      items = await searchIssues(bucket.query, bucket.take);
    } catch {
      continue; // the label or search may not exist for this repo, skip the category
    }
    for (const item of items) {
      if (numbers.length >= count) break;
      add(item.number);
      if (!bucket.findDuplicateOriginal) continue;
      try {
        const full = await getIssue({ ...from, issueNumber: item.number });
        const text = `${full.body}\n${full.comments.map((comment) => comment.body).join("\n")}`;
        const match = text.match(/duplicate of #(\d+)/i);
        if (match?.[1]) add(Number.parseInt(match[1], 10));
      } catch {
        // ignore lookup failures, the duplicate itself is still copied
      }
    }
  }

  if (numbers.length < count) {
    try {
      const items = await searchIssues(`${repoQuery} is:issue is:open`, count);
      for (const item of items) add(item.number);
    } catch {
      // nothing else to fall back on
    }
  }

  return numbers.slice(0, count);
}

function printUsage(): void {
  console.log(
    "Usage: pnpm seed --from <owner/repo> --to <owner/repo>\n" +
      "                                 [--count 30] [--issues 1,2,3] [--dry-run]",
  );
}

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    count: { type: "string", default: "30" },
    issues: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  printUsage();
  process.exit(0);
}

if (!values.from || !values.to) {
  printUsage();
  process.exit(1);
}

const [fromOwner, fromRepo] = values.from.split("/");
const [toOwner, toRepo] = values.to.split("/");
if (!fromOwner || !fromRepo) {
  console.error(`Expected --from <owner/repo>, got "${values.from}"`);
  process.exit(1);
}
if (!toOwner || !toRepo) {
  console.error(`Expected --to <owner/repo>, got "${values.to}"`);
  process.exit(1);
}

const from: RepoRef = { owner: fromOwner, repo: fromRepo };
const dryRun = values["dry-run"] ?? false;
const count = Number.parseInt(values.count ?? "30", 10) || 30;

const issueNumbers = values.issues
  ? values.issues
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((n) => Number.isFinite(n))
  : await selectIssueNumbers(from, count);

if (!issueNumbers.length) {
  console.log("No issues to copy.");
  process.exit(0);
}

// A dry run works before the target repository exists.
const missingTarget = (error: unknown): Set<string> => {
  if (dryRun) return new Set<string>();
  throw error;
};
const existingMarkers = await loadExistingMarkers(toOwner, toRepo).catch(missingTarget);
const existingLabels = await loadExistingLabelNames(toOwner, toRepo).catch(missingTarget);

let copied = 0;
let skipped = 0;

for (const issueNumber of issueNumbers) {
  const key = `${fromOwner}/${fromRepo}#${issueNumber}`;
  if (existingMarkers.has(key)) {
    console.log(`skip ${key} (already seeded)`);
    skipped++;
    continue;
  }

  const issue = await getIssue({ ...from, issueNumber });
  if (issue.isPullRequest) {
    console.log(`skip ${key} (pull request)`);
    continue;
  }

  for (const label of issue.labels) {
    await ensureLabel(toOwner, toRepo, label, existingLabels, dryRun);
  }

  const title = neutralizeMentions(issue.title);
  const body = buildBody(from, issue);

  if (dryRun) {
    console.log(`[dry-run] would copy ${key} -> ${toOwner}/${toRepo}: "${title}" (${issue.labels.length} labels)`);
  } else {
    const created = await createIssue(toOwner, toRepo, title, body, issue.labels);
    console.log(`copied ${key} -> ${created.url}`);
    await sleep(750);
  }
  copied++;
}

console.log(`\n${copied} ${dryRun ? "to copy" : "copied"}, ${skipped} skipped (already seeded).`);

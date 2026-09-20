import { stringify } from "yaml";
import { z } from "zod";

import { CONFIG_PATH, parseRepoConfig, type RepoConfigInput } from "../config";
import { gh, ghText, GitHubRequestError, type RepoRef } from "./github";

export const SETUP_BRANCH = "nuxi/setup";

/**
 * Only a layout fact is proposed as areas: a monorepo's packages. What else counts as an area depends
 * on what the project is, a components directory means one thing in a UI library and nothing in an app,
 * so the maintainer declares those.
 */
const AREA_CANDIDATES = [{ kind: "package", glob: "packages/*" }];

/** Labels the bot owns. A stale workflow that only targets these is fully replaced. */
const OWNED_LABELS = new Set(["triage", "needs reproduction", "needs verification", "stale"]);

/** Labels that wait on a maintainer. A stale workflow that stays must not close these. */
const EXEMPT_LABELS = ["question", "duplicate", "answered", "needs verification", "needs reproduction"];

const repoSchema = z.object({
  default_branch: z.string(),
  homepage: z.string().nullable().optional(),
  archived: z.boolean().default(false),
  fork: z.boolean().default(false),
  owner: z.object({ login: z.string(), type: z.string() }),
});

const treeSchema = z.object({ tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() })) });
const labelSchema = z.object({ name: z.string() });
const contributorSchema = z.object({ login: z.string(), type: z.string() });

const packageJsonSchema = z.object({
  name: z.string().optional(),
  private: z.boolean().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

const registrySchema = z.object({
  repository: z.union([z.string(), z.object({ url: z.string().optional() })]).optional(),
});

export interface WorkflowFinding {
  path: string;
  sha: string;
  action: "remove" | "keep";
  reason: string;
}

export interface SetupProposal {
  slug: string;
  defaultBranch: string;
  config: RepoConfigInput;
  yaml: string;
  notes: string[];
  workflows: WorkflowFinding[];
}

function repoPath(ref: RepoRef): string {
  return `/repos/${ref.owner}/${ref.repo}`;
}

async function detectMaintainers(ref: RepoRef, tree: Set<string>, owner: z.output<typeof repoSchema>["owner"], signal?: AbortSignal): Promise<string[]> {
  const codeownersPath = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].find((path) => tree.has(path));
  if (codeownersPath) {
    const source = (await ghText(`${repoPath(ref)}/contents/${codeownersPath}`, { owner: ref.owner, signal })) ?? "";
    // Teams (`@org/team`) cannot be @-mentioned by an app in a useful way, keep users only.
    const users = [...source.matchAll(/(?<![\w/])@([\w-]+)(?![\w/-])/g)].map((match) => match[1] ?? "").filter(Boolean);
    if (users.length) return [...new Set(users)].slice(0, 3);
  }
  if (owner.type === "User") return [owner.login];
  const contributors = await gh(z.array(contributorSchema), `${repoPath(ref)}/contributors?per_page=10`, { owner: ref.owner, signal });
  return contributors.filter((contributor) => contributor.type === "User").slice(0, 2).map((contributor) => contributor.login);
}

async function resolveUpstream(name: string, dependencies: string[], signal?: AbortSignal): Promise<string | null> {
  // Most specific rule first: `nuxt` must resolve to the `nuxt` package, not to `@nuxt/eslint`.
  const dependency =
    dependencies.find((candidate) => candidate === name) ??
    dependencies.find((candidate) => candidate.endsWith(`/${name}`)) ??
    dependencies.find((candidate) => candidate === `@${name}/core`) ??
    dependencies.find((candidate) => candidate.startsWith(`@${name}/`));
  if (!dependency) return null;
  const response = await fetch(`https://registry.npmjs.org/${dependency.replace("/", "%2F")}/latest`, { signal }).catch(() => null);
  if (!response?.ok) return null;
  const parsed = registrySchema.safeParse(await response.json());
  if (!parsed.success) return null;
  const url = typeof parsed.data.repository === "string" ? parsed.data.repository : parsed.data.repository?.url;
  return /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#.*)?$/.exec(url ?? "")?.[1] ?? null;
}

function listOption(source: string, key: string): string[] {
  const match = new RegExp(`^\\s*${key}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, "m").exec(source);
  // Block scalars and sequences are not parsed. They read as "no labels", which keeps the workflow.
  if (!match?.[1] || /^\s*[|>-]/.test(match[1])) return [];
  return match[1].split(",").map((label) => label.trim()).filter(Boolean);
}

/** Known automations that overlap with the bot. Anything else is left alone. */
export function inspectWorkflow(path: string, sha: string, source: string): WorkflowFinding | null {
  const uses = [...source.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)/g)].map((match) => (match[1] ?? "").toLowerCase());

  if (uses.includes("hebilicious/reproduire")) {
    return { path, sha, action: "remove", reason: "Posts the reproduction request. nuxi posts its own when it applies `needs reproduction`, keeping both means two comments." };
  }

  if (uses.includes("actions/stale")) {
    const targets = [...listOption(source, "only-labels"), ...listOption(source, "any-of-labels"), ...listOption(source, "only-issue-labels"), ...listOption(source, "any-of-issue-labels")];
    // `actions/stale` covers pull requests unless told otherwise, and nuxi never handles those.
    // `days-before-stale: -1` turns both off when no pull request specific value overrides it.
    const pullRequestsOff =
      /days-before-pr-stale:\s*-1/.test(source) ||
      /days-before-pr-close:\s*-1/.test(source) ||
      (/days-before-stale:\s*-1/.test(source) && !/days-before-pr-stale:/.test(source));
    const handlesPullRequests = !pullRequestsOff;
    if (!handlesPullRequests && targets.length > 0 && targets.every((label) => OWNED_LABELS.has(label))) {
      return { path, sha, action: "remove", reason: `Closes issues labeled ${targets.map((label) => `\`${label}\``).join(", ")} after a delay. nuxi follows up and mentions a maintainer instead, and never closes.` };
    }
    return {
      path,
      sha,
      action: "keep",
      reason: `Uses \`actions/stale\` ${handlesPullRequests ? "on pull requests or on every issue" : "on labels nuxi does not manage"}, so it stays. Add \`exempt-issue-labels: '${EXEMPT_LABELS.join(",")}'\` so it never closes an issue that waits on a maintainer.`,
    };
  }

  return null;
}

/** Reads the repository and drafts its `.github/nuxi.yml`. Writes nothing. */
export async function proposeSetup(ref: RepoRef, signal?: AbortSignal): Promise<SetupProposal> {
  const options = { owner: ref.owner, signal };
  const repo = await gh(repoSchema, repoPath(ref), options);
  const [{ tree }, labels, branches] = await Promise.all([
    gh(treeSchema, `${repoPath(ref)}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`, options),
    gh(z.array(labelSchema), `${repoPath(ref)}/labels?per_page=100`, options),
    gh(z.array(labelSchema), `${repoPath(ref)}/branches?per_page=100`, options),
  ]);
  const blobs = new Map(tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry.sha]));
  const paths = new Set(blobs.keys());
  const labelNames = labels.map((label) => label.name);
  const notes: string[] = [];

  const config: RepoConfigInput = { dryRun: true, maintainers: await detectMaintainers(ref, paths, repo.owner, signal) };
  if (config.maintainers.length === 0) {
    config.maintainers = [repo.owner.login];
    notes.push("`maintainers` could not be detected. Replace the placeholder with the people to mention.");
  }

  const matches = (glob: string) => {
    const [directory = "", extension = ""] = glob.split("*");
    const names = new Set<string>();
    for (const path of paths) {
      if (!path.startsWith(directory)) continue;
      const [first = "", ...rest] = path.slice(directory.length).split("/");
      // A file pattern matches files of that directory. A bare `dir/*` matches its sub-directories.
      if (extension ? rest.length === 0 && first.endsWith(extension) : rest.length > 0) names.add(first);
    }
    return names.size;
  };
  const areas = AREA_CANDIDATES.filter((candidate) => matches(candidate.glob) >= 2);
  // No label template is proposed: a label per area is opt-in.
  if (areas.length) config.areas = areas;

  const packageSource = paths.has("package.json") ? await ghText(`${repoPath(ref)}/contents/package.json`, options) : null;
  const parsedPackage = packageSource ? packageJsonSchema.safeParse(JSON.parse(packageSource)) : null;
  const pkg = parsedPackage?.success ? parsedPackage.data : null;
  // Same charset as the schema. A legacy name outside it becomes a note, not a failed setup.
  if (pkg?.name && !pkg.private && /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(pkg.name)) config.package = { name: pkg.name };
  else notes.push("No published npm package was found, so reproduction version checks and sandbox runs stay off.");

  const dependencies = Object.keys({ ...pkg?.devDependencies, ...pkg?.peerDependencies, ...pkg?.dependencies });
  const upstreams: string[] = [];
  for (const label of labelNames.filter((name) => name.startsWith("upstream/"))) {
    const slug = await resolveUpstream(label.slice("upstream/".length), dependencies, signal);
    if (slug) upstreams.push(slug);
    else notes.push(`The \`${label}\` label exists but its repository could not be resolved. Add it to \`upstreams\` as \`owner/repo\`.`);
  }
  if (upstreams.length) config.upstreams = upstreams;

  const majors = labelNames.filter((name) => /^v\d+$/.test(name)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  const nextLabel = majors.find((label) => branches.some((branch) => branch.name === label));
  if (nextLabel) {
    config.nextMajor = { label: nextLabel, branch: nextLabel };
    notes.push(`\`nextMajor.package\` is empty. Set it to an install spec for builds of the \`${nextLabel}\` branch, such as a pkg.pr.new URL with \`{sha}\`, to let the sandbox compare against it.`);
  }

  const reproduireTemplate = [...paths].find((path) => path.startsWith(".github/reproduire/") && path.endsWith(".md"));
  const hasForm = [...paths].some((path) => /^\.github\/ISSUE_TEMPLATE\/[^/]+\.ya?ml$/.test(path) && !path.endsWith("/config.yml"));
  if (!hasForm) notes.push("No issue form was found. nuxi reads the reproduction guide and starter links from the form's reproduction field. Without one, set `reproduction` in this file.");

  const securityPath = ["SECURITY.md", ".github/SECURITY.md", "docs/SECURITY.md"].find((path) => paths.has(path));
  if (securityPath) config.securityPolicy = `https://github.com/${ref.owner}/${ref.repo}/blob/${repo.default_branch}/${securityPath}`;
  else if ((await ghText(`/repos/${ref.owner}/.github/contents/SECURITY.md`, { signal }).catch(() => null)) !== null) {
    config.securityPolicy = `https://github.com/${ref.owner}/.github/blob/main/SECURITY.md`;
  }
  if (repo.homepage?.startsWith("https://")) config.help = repo.homepage;

  const workflows: WorkflowFinding[] = [];
  for (const [path, sha] of blobs) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) continue;
    const source = await ghText(`${repoPath(ref)}/contents/${path}`, options);
    const finding = source ? inspectWorkflow(path, sha, source) : null;
    if (finding) workflows.push(finding);
  }
  // The reproduire template is dead weight once its workflow goes.
  if (reproduireTemplate && workflows.some((finding) => finding.action === "remove" && finding.reason.startsWith("Posts the reproduction"))) {
    workflows.push({ path: reproduireTemplate, sha: blobs.get(reproduireTemplate) ?? "", action: "remove", reason: "Only used by the reproduire workflow. The request now comes from `reproduction` in `.github/nuxi.yml`." });
  }

  const yaml = `# nuxi triage config. Reference: https://github.com/benjamincanac/nuxi#configuration\n${stringify(config, { lineWidth: 0 })}`;
  const check = parseRepoConfig(yaml);
  if (!check.ok) throw new Error(`Generated config is invalid:\n${check.error}`);

  return { slug: `${ref.owner}/${ref.repo}`, defaultBranch: repo.default_branch, config, yaml, notes, workflows };
}

export function setupPullRequestBody(proposal: SetupProposal, manual: WorkflowFinding[]): string {
  const removed = proposal.workflows.filter((finding) => finding.action === "remove" && !manual.includes(finding));
  const kept = proposal.workflows.filter((finding) => finding.action === "keep");
  const lines = [
    "This adds the [nuxi](https://github.com/benjamincanac/nuxi) triage config for this repository. Everything in it was detected from the repository, review it like any other config file.",
    "",
    "`dryRun: true` means nuxi logs what it would do and writes nothing. Set it to `false` when the decisions look right. It never closes, transfers or converts an issue, and never removes a label a human applied.",
  ];
  if (proposal.notes.length) lines.push("", "### To check", "", ...proposal.notes.map((note) => `- ${note}`));
  if (removed.length) {
    lines.push("", "### Removed automation", "", "These overlap with what nuxi does. They are removed in the same PR, so merge it when you are ready to switch `dryRun` off, or drop the deletions from this branch to keep them for now.", "", "| File | Why |", "| --- | --- |", ...removed.map((finding) => `| \`${finding.path}\` | ${finding.reason} |`));
  }
  if (manual.length) {
    lines.push("", "### To remove by hand", "", "The app has no permission to edit workflow files here, so these were left in place.", "", "| File | Why |", "| --- | --- |", ...manual.map((finding) => `| \`${finding.path}\` | ${finding.reason} |`));
  }
  if (kept.length) lines.push("", "### Kept", "", "| File | Note |", "| --- | --- |", ...kept.map((finding) => `| \`${finding.path}\` | ${finding.reason} |`));
  lines.push("", "There is no label to create. nuxi creates each of its labels the first time it applies it.");
  return lines.join("\n");
}

const refSchema = z.object({ object: z.object({ sha: z.string() }) });
const pullSchema = z.object({ html_url: z.string(), number: z.number() });

export type SetupResult =
  | { status: "opened" | "exists"; url: string; removed: string[]; manual: string[] }
  | { status: "configured" | "skipped"; reason: string };

/**
 * Opens one pull request with the config and the workflow removals, from the `nuxi/setup` branch.
 * Idempotent: a repo that has the file, or an open setup PR, is left alone. Never touches the default branch.
 */
export async function openSetupPullRequest(ref: RepoRef, signal?: AbortSignal): Promise<SetupResult> {
  const options = { owner: ref.owner, signal };
  if ((await ghText(`${repoPath(ref)}/contents/${CONFIG_PATH}`, options)) !== null) {
    return { status: "configured", reason: `${CONFIG_PATH} already exists.` };
  }

  const existing = await gh(z.array(pullSchema), `${repoPath(ref)}/pulls?state=all&head=${ref.owner}:${SETUP_BRANCH}&per_page=1`, options);
  if (existing[0]) return { status: "exists", url: existing[0].html_url, removed: [], manual: [] };

  const repo = await gh(repoSchema, repoPath(ref), options);
  if (repo.archived || repo.fork) return { status: "skipped", reason: repo.archived ? "Archived repository." : "Fork." };

  const proposal = await proposeSetup(ref, signal);
  const base = await gh(refSchema, `${repoPath(ref)}/git/ref/heads/${encodeURIComponent(proposal.defaultBranch)}`, options);
  await gh(z.unknown(), `${repoPath(ref)}/git/refs`, { ...options, method: "POST", body: { ref: `refs/heads/${SETUP_BRANCH}`, sha: base.object.sha } }).catch((error: unknown) => {
    // 422: the branch is left over from a closed PR. Reuse it.
    if (!(error instanceof GitHubRequestError) || error.status !== 422) throw error;
  });

  // A run interrupted before the PR was opened leaves the file on the branch. Updating needs its sha.
  const leftover = await gh(z.object({ sha: z.string() }), `${repoPath(ref)}/contents/${CONFIG_PATH}?ref=${encodeURIComponent(SETUP_BRANCH)}`, options).catch(
    (error: unknown) => {
      if (error instanceof GitHubRequestError && error.status === 404) return null;
      throw error;
    },
  );
  await gh(z.unknown(), `${repoPath(ref)}/contents/${CONFIG_PATH}`, {
    ...options,
    method: "PUT",
    body: {
      message: "chore(github): add nuxi triage config",
      branch: SETUP_BRANCH,
      content: Buffer.from(proposal.yaml).toString("base64"),
      ...(leftover ? { sha: leftover.sha } : {}),
    },
  });

  const manual: WorkflowFinding[] = [];
  for (const finding of proposal.workflows.filter((candidate) => candidate.action === "remove")) {
    try {
      await gh(z.unknown(), `${repoPath(ref)}/contents/${finding.path}`, {
        ...options,
        method: "DELETE",
        body: { message: `chore(github): remove ${finding.path.split("/").pop()}`, branch: SETUP_BRANCH, sha: finding.sha },
      });
    } catch (error) {
      // 403 and 404: without the Workflows permission GitHub refuses edits under .github/workflows.
      // 409 and 422: a leftover branch holds another version of the file, or it is already gone.
      // Either way the PR still opens and lists the file for a manual removal.
      if (!(error instanceof GitHubRequestError) || ![403, 404, 409, 422].includes(error.status)) throw error;
      manual.push(finding);
    }
  }

  const pull = await gh(pullSchema, `${repoPath(ref)}/pulls`, {
    ...options,
    method: "POST",
    // The pull request does more than add the file, so it is not the commit's subject.
    body: { title: "chore(github): set up nuxi triage", head: SETUP_BRANCH, base: proposal.defaultBranch, body: setupPullRequestBody(proposal, manual) },
  });

  return {
    status: "opened",
    url: pull.html_url,
    removed: proposal.workflows.filter((finding) => finding.action === "remove" && !manual.includes(finding)).map((finding) => finding.path),
    manual: manual.map((finding) => finding.path),
  };
}

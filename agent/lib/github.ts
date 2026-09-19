import { getToken } from "@vercel/connect";
import { z } from "zod";

import {
  CONFIG_PATH,
  githubConnector,
  parseRepoConfig,
  resolveRepoConfig,
  type RepoConfig,
} from "../config";

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface IssueRef extends RepoRef {
  issueNumber: number;
}

const connectInstallations = z.record(z.string(), z.string());

/**
 * Optional `{ "<owner>": "<connect installation id>" }` map. Only needed once the app is
 * installed on more than one account and the default installation is not the right one.
 */
function connectInstallationId(owner: string): string | undefined {
  const raw = process.env.GITHUB_CONNECT_INSTALLATIONS;
  if (!raw) return undefined;
  const parsed = connectInstallations.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data[owner] : undefined;
}

export async function githubToken(owner?: string): Promise<string> {
  // Scripts run outside Vercel and may use a personal token instead of Connect.
  if (process.env.NUXI_SCRIPT_TOKEN) return process.env.NUXI_SCRIPT_TOKEN;
  const installationId = owner ? connectInstallationId(owner) : undefined;
  return getToken(githubConnector(), {
    subject: { type: "app" },
    ...(installationId ? { installationId } : {}),
  });
}

export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`GitHub ${status} on ${path}: ${body.slice(0, 300)}`);
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  accept?: string;
  owner?: string;
  signal?: AbortSignal;
}

async function rawRequest(path: string, options: RequestOptions = {}): Promise<Response> {
  const token = await githubToken(options.owner);
  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method ?? "GET",
    headers: {
      accept: options.accept ?? "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "nuxi-triage",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  return response;
}

export async function gh<T extends z.ZodType>(
  schema: T,
  path: string,
  options: RequestOptions = {},
): Promise<z.output<T>> {
  const response = await rawRequest(path, options);
  if (!response.ok) throw new GitHubRequestError(response.status, path, await response.text());
  if (response.status === 204) return schema.parse(null);
  return schema.parse(await response.json());
}

export async function ghText(path: string, options: RequestOptions = {}): Promise<string | null> {
  const response = await rawRequest(path, { ...options, accept: "application/vnd.github.raw" });
  if (response.status === 404) return null;
  if (!response.ok) throw new GitHubRequestError(response.status, path, await response.text());
  return response.text();
}

export async function graphql<T extends z.ZodType>(
  schema: T,
  query: string,
  variables: Record<string, unknown>,
  options: Pick<RequestOptions, "owner" | "signal"> = {},
): Promise<z.output<T>> {
  const envelope = z.object({
    data: z.unknown().optional(),
    errors: z.array(z.object({ message: z.string() })).optional(),
  });
  const result = await gh(envelope, "/graphql", {
    ...options,
    method: "POST",
    body: { query, variables },
  });
  if (result.errors?.length) {
    throw new Error(`GitHub GraphQL: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return schema.parse(result.data);
}

async function paginate<T extends z.ZodType>(
  item: T,
  path: string,
  options: RequestOptions & { maxPages?: number } = {},
): Promise<z.output<T>[]> {
  const out: z.output<T>[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= (options.maxPages ?? 10); page++) {
    const batch = await gh(z.array(item), `${path}${separator}per_page=100&page=${page}`, options);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

const userSchema = z.object({ login: z.string(), type: z.string().default("User") });
const labelSchema = z.union([z.string(), z.object({ name: z.string() })]);

const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  html_url: z.string(),
  user: userSchema.nullable(),
  author_association: z.string().default("NONE"),
  labels: z.array(labelSchema),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable().optional(),
  comments: z.number().default(0),
  reactions: z.object({ "+1": z.number() }).partial().optional(),
  pull_request: z.unknown().optional(),
  type: z.object({ name: z.string() }).nullable().optional(),
});

const commentSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  user: userSchema.nullable(),
  author_association: z.string().default("NONE"),
  created_at: z.string(),
});

export interface IssueComment {
  id: number;
  author: string;
  authorType: string;
  authorAssociation: string;
  body: string;
  createdAt: string;
}

export interface Issue extends IssueRef {
  title: string;
  body: string;
  state: string;
  url: string;
  author: string;
  authorType: string;
  authorAssociation: string;
  labels: string[];
  type: string | null;
  createdAt: string;
  updatedAt: string;
  thumbsUp: number;
  isPullRequest: boolean;
  comments: IssueComment[];
}

function toIssue(ref: RepoRef, raw: z.output<typeof issueSchema>, comments: IssueComment[]): Issue {
  return {
    ...ref,
    issueNumber: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    url: raw.html_url,
    author: raw.user?.login ?? "ghost",
    authorType: raw.user?.type ?? "User",
    authorAssociation: raw.author_association,
    labels: raw.labels.map((label) => (typeof label === "string" ? label : label.name)),
    type: raw.type?.name ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    thumbsUp: raw.reactions?.["+1"] ?? 0,
    isPullRequest: raw.pull_request !== undefined,
    comments,
  };
}

function toComment(raw: z.output<typeof commentSchema>): IssueComment {
  return {
    id: raw.id,
    author: raw.user?.login ?? "ghost",
    authorType: raw.user?.type ?? "User",
    authorAssociation: raw.author_association,
    body: raw.body ?? "",
    createdAt: raw.created_at,
  };
}

export async function getIssue(ref: IssueRef, signal?: AbortSignal): Promise<Issue> {
  const base = `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}`;
  const raw = await gh(issueSchema, base, { owner: ref.owner, signal });
  // Comments are listed oldest first. On long threads only the last pages matter.
  const lastPage = Math.max(1, Math.ceil(raw.comments / 100));
  const pages = [lastPage - 2, lastPage - 1, lastPage].filter((page) => page >= 1);
  const batches = await Promise.all(
    pages.map((page) => gh(z.array(commentSchema), `${base}/comments?per_page=100&page=${page}`, { owner: ref.owner, signal })),
  );
  return toIssue(ref, raw, batches.flat().map(toComment));
}

/** Open issues carrying any of the given labels, without comments. */
export async function listOpenIssues(
  ref: RepoRef,
  labels: string[] = [],
  signal?: AbortSignal,
): Promise<Issue[]> {
  const seen = new Map<number, Issue>();
  const queries = labels.length ? labels : [""];
  for (const label of queries) {
    const filter = label ? `&labels=${encodeURIComponent(label)}` : "";
    const batch = await paginate(
      issueSchema,
      `/repos/${ref.owner}/${ref.repo}/issues?state=open${filter}`,
      { owner: ref.owner, signal, maxPages: 20 },
    );
    for (const raw of batch) {
      if (raw.pull_request === undefined) seen.set(raw.number, toIssue(ref, raw, []));
    }
  }
  return [...seen.values()];
}

const searchSchema = z.object({ items: z.array(issueSchema) });

export async function searchIssues(query: string, limit: number, signal?: AbortSignal): Promise<z.output<typeof issueSchema>[]> {
  const result = await gh(
    searchSchema,
    `/search/issues?q=${encodeURIComponent(query)}&per_page=${Math.min(limit, 100)}`,
    { signal },
  );
  return result.items;
}

export async function searchCount(query: string, signal?: AbortSignal): Promise<number> {
  const result = await gh(z.object({ total_count: z.number() }), `/search/issues?q=${encodeURIComponent(query)}&per_page=1`, { signal });
  return result.total_count;
}

const installationRepositoriesSchema = z.object({
  repositories: z.array(z.object({ name: z.string(), owner: z.object({ login: z.string() }), archived: z.boolean().default(false) })),
});

/** Repositories the app installation can access. A repo without a valid config file is ignored later. */
export async function listInstalledRepositories(signal?: AbortSignal): Promise<RepoRef[]> {
  const result = await gh(installationRepositoriesSchema, "/installation/repositories?per_page=100", { signal });
  return result.repositories.filter((repo) => !repo.archived).map((repo) => ({ owner: repo.owner.login, repo: repo.name }));
}

/** Installed repositories with a valid `.github/nuxi.yml`. */
export async function listEnabledRepositories(signal?: AbortSignal): Promise<RepoConfig[]> {
  // Public repos can be followed read-only before the app is installed on them.
  const extra = (process.env.NUXI_EXTRA_REPOS ?? "")
    .split(",")
    .map((slug) => slug.trim().split("/"))
    .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]))
    .map(([owner, repo]) => ({ owner, repo }));
  const refs = [...(await listInstalledRepositories(signal)), ...extra];
  const unique = refs.filter((ref, index) => refs.findIndex((other) => `${other.owner}/${other.repo}` === `${ref.owner}/${ref.repo}`) === index);
  const configs = await Promise.all(unique.map((ref) => loadRepoConfig(ref, signal)));
  return configs.filter((config): config is RepoConfig => config !== null);
}

const timelineEventSchema = z.object({
  event: z.string().optional(),
  created_at: z.string().optional(),
  actor: userSchema.nullable().optional(),
  label: z.object({ name: z.string() }).optional(),
  source: z
    .object({
      issue: z
        .object({
          number: z.number(),
          title: z.string(),
          html_url: z.string(),
          pull_request: z.object({ merged_at: z.string().nullable().optional() }).optional(),
          repository: z.object({ full_name: z.string() }).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type TimelineEvent = z.output<typeof timelineEventSchema>;

export function getTimeline(ref: IssueRef, signal?: AbortSignal): Promise<TimelineEvent[]> {
  return paginate(
    timelineEventSchema,
    `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}/timeline`,
    { owner: ref.owner, signal, maxPages: 10 },
  );
}

export function isBot(login: string, type: string): boolean {
  return type === "Bot" || login.endsWith("[bot]");
}

/** Labels currently on the issue that were applied by a human. The bot never removes those. */
export function humanAppliedLabels(timeline: TimelineEvent[]): Set<string> {
  const appliedBy = new Map<string, boolean>();
  for (const event of timeline) {
    if (!event.label) continue;
    if (event.event === "labeled") {
      appliedBy.set(event.label.name, !isBot(event.actor?.login ?? "", event.actor?.type ?? ""));
    } else if (event.event === "unlabeled") {
      appliedBy.delete(event.label.name);
    }
  }
  return new Set([...appliedBy].filter(([, human]) => human).map(([name]) => name));
}

const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  body: z.string().nullable(),
  published_at: z.string().nullable(),
  prerelease: z.boolean(),
  draft: z.boolean(),
});

export type Release = z.output<typeof releaseSchema>;

export async function listReleases(ref: RepoRef, signal?: AbortSignal): Promise<Release[]> {
  const releases = await gh(
    z.array(releaseSchema),
    `/repos/${ref.owner}/${ref.repo}/releases?per_page=30`,
    { owner: ref.owner, signal },
  );
  return releases.filter((release) => !release.draft);
}

const treeSchema = z.object({
  tree: z.array(z.object({ path: z.string(), type: z.string() })),
});

const repoSchema = z.object({ default_branch: z.string() });

/** Component names (PascalCase) matching a single-level glob such as `src/runtime/components/*.vue`. */
export async function listComponents(ref: RepoRef, glob: string, signal?: AbortSignal): Promise<string[]> {
  const { default_branch } = await gh(repoSchema, `/repos/${ref.owner}/${ref.repo}`, { owner: ref.owner, signal });
  const { tree } = await gh(
    treeSchema,
    `/repos/${ref.owner}/${ref.repo}/git/trees/${default_branch}?recursive=1`,
    { owner: ref.owner, signal },
  );
  const pattern = new RegExp(
    `^${glob
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")}$`,
  );
  return tree
    .filter((entry) => entry.type === "blob" && pattern.test(entry.path))
    .map((entry) => entry.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "")
    .filter((name) => name.length > 0)
    .sort();
}

const CACHE_TTL_MS = 5 * 60_000;
const configCache = new Map<string, { expires: number; value: RepoConfig | null }>();
const componentCache = new Map<string, { expires: number; value: string[] }>();

/** Returns `null` when the file is missing or invalid, which disables triage for the repo. */
export async function loadRepoConfig(ref: RepoRef, signal?: AbortSignal): Promise<RepoConfig | null> {
  const key = `${ref.owner}/${ref.repo}`.toLowerCase();
  const cached = configCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  let value: RepoConfig | null = null;
  const source = await ghText(`/repos/${ref.owner}/${ref.repo}/contents/${CONFIG_PATH}`, {
    owner: ref.owner,
    signal,
  });
  if (source !== null) {
    const parsed = parseRepoConfig(source);
    if (parsed.ok) value = resolveRepoConfig(ref.owner, ref.repo, parsed.config);
    else console.warn(`[nuxi] invalid ${CONFIG_PATH} in ${key}, triage disabled:\n${parsed.error}`);
  }
  configCache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}

export async function loadComponents(config: RepoConfig, signal?: AbortSignal): Promise<string[]> {
  if (!config.components) return [];
  const source = config.componentsSource ?? `${config.owner}/${config.repo}`;
  const key = `${source}:${config.components}`;
  const cached = componentCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const [owner = "", repo = ""] = source.split("/");
  const value = await listComponents({ owner, repo }, config.components, signal);
  componentCache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}

// Writes. Only `applyPlan` in lib/apply.ts calls these.

export async function addLabels(ref: IssueRef, labels: string[]): Promise<void> {
  if (!labels.length) return;
  await gh(z.unknown(), `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}/labels`, {
    owner: ref.owner,
    method: "POST",
    body: { labels },
  });
}

export async function removeLabel(ref: IssueRef, label: string): Promise<void> {
  const response = await rawRequest(
    `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}/labels/${encodeURIComponent(label)}`,
    { owner: ref.owner, method: "DELETE" },
  );
  if (!response.ok && response.status !== 404) {
    throw new GitHubRequestError(response.status, "labels", await response.text());
  }
}

export async function addComment(ref: IssueRef, body: string): Promise<string> {
  const created = await gh(
    z.object({ html_url: z.string() }),
    `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}/comments`,
    { owner: ref.owner, method: "POST", body: { body } },
  );
  return created.html_url;
}

export async function setIssueType(ref: IssueRef, type: string): Promise<void> {
  await gh(z.unknown(), `/repos/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}`, {
    owner: ref.owner,
    method: "PATCH",
    body: { type },
  });
}

const pinnedSchema = z.object({
  repository: z.object({
    pinnedIssues: z.object({ nodes: z.array(z.object({ issue: z.object({ number: z.number() }) })) }),
  }),
});

export async function listPinnedIssues(ref: RepoRef, signal?: AbortSignal): Promise<number[]> {
  const data = await graphql(
    pinnedSchema,
    `query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) { pinnedIssues(first: 10) { nodes { issue { number } } } }
    }`,
    { owner: ref.owner, repo: ref.repo },
    { owner: ref.owner, signal },
  );
  return data.repository.pinnedIssues.nodes.map((node) => node.issue.number);
}

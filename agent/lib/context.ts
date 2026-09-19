import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { repoConfigSchema, resolveRepoConfig, type RepoConfig } from "../config";
import {
  getIssue,
  getTimeline,
  humanAppliedLabels,
  listPinnedIssues,
  loadComponents,
  loadRepoConfig,
  type Issue,
  type IssueRef,
} from "./github";

export const FIXTURE_OWNER = "fixture";

const commentSchema = z.object({
  id: z.number().default(0),
  author: z.string(),
  authorType: z.string().default("User"),
  authorAssociation: z.string().default("NONE"),
  body: z.string(),
  createdAt: z.string().default("2026-01-01T00:00:00Z"),
});

const candidateSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  url: z.string(),
  body: z.string().default(""),
});

const fixedCandidateSchema = z.object({
  id: z.string(),
  summary: z.string(),
  url: z.string(),
  release: z.string().nullable(),
});

const reproductionSchema = z.object({
  url: z.string(),
  kind: z.enum(["stackblitz", "codesandbox", "github", "snippet"]),
  resolves: z.boolean(),
  usesPackage: z.boolean().nullable(),
  blankTemplate: z.boolean(),
  version: z.string().nullable(),
  repository: z.object({ owner: z.string(), repo: z.string(), ref: z.string().nullable() }).nullable(),
});

export type SimilarCandidate = z.output<typeof candidateSchema>;
export type FixedCandidate = z.output<typeof fixedCandidateSchema>;
export type ReproductionCheck = z.output<typeof reproductionSchema>;

/** Offline issue used by the evals. Lives in `evals/data/<repo>.json`, addressed as `fixture/<repo>#1`. */
const fixtureSchema = z.object({
  config: repoConfigSchema,
  components: z.array(z.string()),
  latestVersion: z.string().default("1.0.0"),
  issue: z.object({
    title: z.string(),
    body: z.string(),
    author: z.string(),
    authorAssociation: z.string().default("NONE"),
    labels: z.array(z.string()).default(["triage"]),
    type: z.string().nullable().default(null),
    createdAt: z.string().default("2026-01-01T00:00:00Z"),
    comments: z.array(commentSchema).default([]),
  }),
  similar: z.array(candidateSchema).default([]),
  fixedCandidates: z.array(fixedCandidateSchema).default([]),
  upstreamCandidates: z.array(candidateSchema).default([]),
  reproduction: reproductionSchema.nullable().default(null),
  sandboxLogs: z.object({ latest: z.string(), next: z.string().nullable() }).nullable().default(null),
});

export type Fixture = z.output<typeof fixtureSchema>;

export interface TriageContext {
  config: RepoConfig;
  issue: Issue;
  components: string[];
  humanLabels: Set<string>;
  lastHumanActivity: number | null;
  pinned: boolean;
  fixture: Fixture | null;
}

async function loadFixture(ref: IssueRef): Promise<TriageContext> {
  const path = join(process.cwd(), "evals", "data", `${ref.repo}.json`);
  const fixture = fixtureSchema.parse(JSON.parse(await readFile(path, "utf8")));
  // Fixtures never write, whatever their config says.
  const config = { ...resolveRepoConfig(ref.owner, ref.repo, fixture.config), dryRun: true };
  return {
    config,
    issue: {
      ...ref,
      ...fixture.issue,
      state: "open",
      url: `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.issueNumber}`,
      authorType: "User",
      updatedAt: fixture.issue.createdAt,
      thumbsUp: 0,
      isPullRequest: false,
    },
    components: fixture.components,
    humanLabels: new Set(),
    lastHumanActivity: null,
    pinned: false,
    fixture,
  };
}

/** Returns `null` when triage is disabled for the repo. */
export async function loadTriageContext(
  ref: IssueRef,
  signal?: AbortSignal,
  /** Local config for scripts that run against a repo that does not carry the file yet. */
  override?: RepoConfig,
): Promise<TriageContext | null> {
  if (ref.owner === FIXTURE_OWNER) return loadFixture(ref);

  const config = override ?? (await loadRepoConfig(ref, signal));
  if (!config) return null;

  const [issue, timeline, components, pinned] = await Promise.all([
    getIssue(ref, signal),
    getTimeline(ref, signal),
    loadComponents(config, signal),
    listPinnedIssues(ref, signal).catch(() => [] as number[]),
  ]);

  const humanTimes: number[] = [];
  for (const event of timeline) {
    const human = event.actor && event.actor.type !== "Bot" && !event.actor.login.endsWith("[bot]");
    if (human && (event.event === "labeled" || event.event === "unlabeled") && event.created_at) {
      // The issue template applies `triage` as the reporter when the issue is created.
      if (event.actor?.login !== issue.author) humanTimes.push(Date.parse(event.created_at));
    }
  }
  for (const comment of issue.comments) {
    if (comment.authorType !== "Bot" && comment.author !== issue.author) {
      humanTimes.push(Date.parse(comment.createdAt));
    }
  }

  return {
    config,
    issue,
    components,
    humanLabels: humanAppliedLabels(timeline),
    lastHumanActivity: humanTimes.length ? Math.max(...humanTimes) : null,
    pinned: pinned.includes(ref.issueNumber),
    fixture: null,
  };
}

const HOUR_MS = 60 * 60_000;

/** Reason to leave the issue alone, or `null`. `force` is an explicit @-mention and skips the activity guard. */
export function skipReason(context: TriageContext, force: boolean): string | null {
  const { issue, config } = context;
  if (issue.isPullRequest) return "pull request";
  if (issue.state !== "open") return "closed";
  if (config.maintainers.some((login) => login.toLowerCase() === issue.author.toLowerCase())) {
    return "authored by a maintainer";
  }
  if (issue.author.toLowerCase().startsWith("renovate")) return "authored by renovate";
  if (context.pinned) return "pinned";
  if (!force && context.lastHumanActivity && Date.now() - context.lastHumanActivity < HOUR_MS) {
    return "a human labeled or commented in the last hour";
  }
  return null;
}

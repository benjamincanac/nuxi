import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { repoConfigSchema, resolveRepoConfig, toArea, type Area, type RepoConfig } from "../config";
import {
  getIssue,
  getTimeline,
  humanAppliedLabels,
  listPinnedIssues,
  loadAreas,
  loadRepoConfig,
  type Issue,
  type IssueRef,
} from "./github";
import { DEFAULT_KINDS, loadIntakeLabels, loadIssueKinds, loadReproductionSettings, reproductionFromConfig, type IssueKind, type ReproductionSettings } from "./issue-forms";

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
  kind: z.enum(["stackblitz", "codesandbox", "github", "playground", "snippet"]),
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
  latestVersion: z.string().default("1.0.0"),
  /** What the issue forms of a real repository would give. Fixtures have no forms to read. */
  intakeLabels: z.array(z.string()).default(["triage"]),
  /** Kinds a real repository would declare in its forms. Defaults to forms that set an Issue Type of the same name. */
  kinds: z
    .array(z.object({ name: z.string(), description: z.string().default(""), type: z.string().nullable().default(null), labels: z.array(z.string()).default([]), report: z.boolean().default(false) }))
    .default(DEFAULT_KINDS.map((kind) => ({ ...kind, type: kind.name }))),
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
});

export type Fixture = z.output<typeof fixtureSchema>;

export interface TriageContext {
  config: RepoConfig;
  /** This run must not write: a backfill, a preview deployment or a fixture. The repository config has no say. */
  dryRun: boolean;
  issue: Issue;
  areas: Area[];
  /** Where reproductions start from, read from the repo's issue forms. */
  reproduction: ReproductionSettings;
  /** Labels several issue forms apply. A decision removes them. Empty when the repository has none. */
  intakeLabels: string[];
  /** Kinds of issue the repository declares in its forms. */
  kinds: IssueKind[];
  humanLabels: Set<string>;
  lastHumanActivity: number | null;
  pinned: boolean;
  fixture: Fixture | null;
}

async function loadFixture(ref: IssueRef): Promise<TriageContext> {
  const path = join(process.cwd(), "evals", "data", `${ref.repo}.json`);
  const fixture = fixtureSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const config = resolveRepoConfig(ref.owner, ref.repo, fixture.config);
  return {
    config,
    // Fixtures never write.
    dryRun: true,
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
    // Fixtures list their areas by name, there is no repository to glob.
    areas: config.areas.flatMap((group) => group.names.map((name) => toArea(name, group))),
    reproduction: reproductionFromConfig(config),
    intakeLabels: fixture.intakeLabels,
    kinds: fixture.kinds,
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

  const [issue, timeline, areas, pinned, reproduction, intakeLabels, kinds] = await Promise.all([
    getIssue(ref, signal),
    getTimeline(ref, signal),
    loadAreas(config, signal),
    listPinnedIssues(ref, signal).catch(() => [] as number[]),
    loadReproductionSettings(config, signal),
    loadIntakeLabels(config, signal),
    loadIssueKinds(config, signal),
  ]);

  const humanTimes: number[] = [];
  for (const event of timeline) {
    const human = event.actor && event.actor.type !== "Bot" && !event.actor.login.endsWith("[bot]");
    if (human && (event.event === "labeled" || event.event === "unlabeled") && event.created_at) {
      // The issue forms apply their labels as the reporter when the issue is created.
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
    areas,
    reproduction,
    intakeLabels,
    kinds,
    humanLabels: humanAppliedLabels(timeline),
    lastHumanActivity: humanTimes.length ? Math.max(...humanTimes) : null,
    pinned: pinned.includes(ref.issueNumber),
    fixture: null,
    dryRun: false,
  };
}

const HOUR_MS = 60 * 60_000;

/** Reason to leave the issue alone, or `null`. `force` is an explicit @-mention and skips the activity guard. */
export function skipReason(context: TriageContext, force: boolean): string | null {
  const { issue, config } = context;
  if (issue.isPullRequest) return "pull request";
  if (issue.state !== "open") return "closed";
  if (!config.triageMaintainerIssues && config.maintainers.some((login) => login.toLowerCase() === issue.author.toLowerCase())) {
    return "authored by a maintainer";
  }
  if (issue.author.toLowerCase().startsWith("renovate")) return "authored by renovate";
  if (context.pinned) return "pinned";
  if (!force && context.lastHumanActivity && Date.now() - context.lastHumanActivity < HOUR_MS) {
    return "a human labeled or commented in the last hour";
  }
  return null;
}

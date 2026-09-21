import type { ReproductionCheck } from "./context";
import type { IssueRef } from "./github";
import { getPlan, savePlan } from "./store";

export const MENTION_TEMPLATES = {
  convert_to_discussion: "this looks like a usage question, consider converting it to a Q&A discussion.",
  close_duplicate: "this looks like a duplicate, consider closing it.",
  previously_reported: "the same thing was reported before and that issue is closed, worth reopening it or saying why it was closed.",
  close_answered: "this looks resolved, consider closing it.",
  verify_fixed: "this looks fixed in a release but the reporter has not confirmed.",
  upstream_closed: "the linked upstream issue was closed, worth a retest or a dependency bump.",
  needs_reproduction_idle: "still no reproduction after the follow-up.",
  stale: "this looks obsolete.",
  enhancement_pr: "a community pull request targets this enhancement.",
  security: "this looks like a publicly disclosed security report and needs your attention now.",
} as const;

export type MentionTemplate = keyof typeof MENTION_TEMPLATES;

export interface PlannedMention {
  template: MentionTemplate;
  /** One sentence of evidence. Also carries the English summary of a non-English issue. */
  detail: string;
}

export type SandboxOutcome =
  | "reproduced"
  | "not_on_next"
  | "no_longer_reproduces"
  | "inconclusive"
  | "failed"
  | "skipped";

export interface SandboxResult {
  outcome: SandboxOutcome;
  latestVersion: string | null;
  summary: string;
}

/** Everything the run intends to do to one issue. Tools add to it, `apply_triage` executes it. */
export interface TriagePlan {
  issue: IssueRef;
  runId: string;
  dryRun: boolean;
  setType: string | null;
  addLabels: string[];
  removeLabels: string[];
  mentions: PlannedMention[];
  /** Slugs of the areas Jev found involved. Recorded whether or not the repo labels them. */
  areas: string[];
  /** Facts the comment must convey. The writing model rephrases them and adds nothing. */
  facts: string[];
  /** `needs_human`: `triage` stays, nothing is written. */
  escalate: boolean;
  /** Security report: the mention is the only comment. */
  security: boolean;
  skipped: string | null;
  sandbox: SandboxResult | null;
  /** Issue Type after classification, existing or proposed. */
  type: string | null;
  reproduction: ReproductionCheck | null;
  latestVersion: string | null;
  steps: string[];
}

export function emptyPlan(issue: IssueRef, runId: string, dryRun: boolean): TriagePlan {
  return {
    issue: { owner: issue.owner, repo: issue.repo, issueNumber: issue.issueNumber },
    runId,
    dryRun,
    setType: null,
    addLabels: [],
    removeLabels: [],
    mentions: [],
    areas: [],
    facts: [],
    escalate: false,
    security: false,
    skipped: null,
    sandbox: null,
    type: null,
    reproduction: null,
    latestVersion: null,
    steps: [],
  };
}

export interface PlanPatch {
  setType?: string;
  addLabels?: string[];
  removeLabels?: string[];
  mentions?: PlannedMention[];
  areas?: string[];
  facts?: string[];
  escalate?: boolean;
  security?: boolean;
  skipped?: string;
  sandbox?: SandboxResult;
  type?: string;
  reproduction?: ReproductionCheck;
  latestVersion?: string;
  /** A duplicate needs no reproduction: drops the planned `needs reproduction` and its request. */
  supersedesReproduction?: boolean;
}

export function mergePlan(plan: TriagePlan, step: string, patch: PlanPatch): TriagePlan {
  const unique = (values: string[]) => [...new Set(values)];
  const drop = patch.supersedesReproduction === true;
  const mentions = [...plan.mentions];
  for (const mention of patch.mentions ?? []) {
    if (!mentions.some((existing) => existing.template === mention.template)) mentions.push(mention);
  }
  return {
    ...plan,
    setType: patch.setType ?? plan.setType,
    addLabels: unique([...plan.addLabels, ...(patch.addLabels ?? [])]).filter((label) => !drop || label !== "needs reproduction"),
    removeLabels: unique([...plan.removeLabels, ...(patch.removeLabels ?? [])]),
    mentions,
    areas: unique([...plan.areas, ...(patch.areas ?? [])]),
    facts: [...plan.facts, ...(patch.facts ?? [])].filter((fact) => !drop || fact !== "REPRODUCTION_REQUEST"),
    escalate: plan.escalate || (patch.escalate ?? false),
    security: plan.security || (patch.security ?? false),
    skipped: patch.skipped ?? plan.skipped,
    sandbox: patch.sandbox ?? plan.sandbox,
    type: patch.type ?? plan.type,
    reproduction: patch.reproduction ?? plan.reproduction,
    latestVersion: patch.latestVersion ?? plan.latestVersion,
    steps: unique([...plan.steps, step]),
  };
}

export async function updatePlan(
  runId: string,
  issue: IssueRef,
  dryRun: boolean,
  step: string,
  patch: PlanPatch,
): Promise<TriagePlan> {
  const current = (await getPlan(issue)) ?? emptyPlan(issue, runId, dryRun);
  const next = mergePlan(current, step, patch);
  await savePlan(runId, next);
  return next;
}

export function hasWrites(plan: TriagePlan): boolean {
  return (
    plan.setType !== null ||
    plan.addLabels.length > 0 ||
    plan.removeLabels.length > 0 ||
    plan.mentions.length > 0 ||
    plan.facts.length > 0
  );
}

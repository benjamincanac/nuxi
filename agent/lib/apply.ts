import { createHash } from "node:crypto";

import { isProduction, type RepoConfig } from "../config";
import { addComment, addLabels, removeLabel, setIssueType } from "./github";
import { MENTION_TEMPLATES, type TriagePlan } from "./plan";
import { getLastAnnounced, isPreviewWriteAllowed, recordDecision, setLastAnnounced } from "./store";

export const MAX_COMMENT_WORDS = 80;

const MANAGED_LABELS = new Set([
  "duplicate",
  "answered",
  "question",
  "needs verification",
  "needs reproduction",
  "has pr",
  "a11y",
  "stale",
]);

/** Short templated request, built from the repo's `reproduction` config. */
export function reproductionRequest(config: RepoConfig): string {
  const { guide, templates } = config.reproduction;
  const ask = `Would you be able to provide a ${guide ? `[reproduction](${guide})` : "reproduction"}? 🙏`;
  if (templates.length === 0) return `${ask} Please keep it as minimal as possible.`;
  const links = templates.map((template) => `[${template.name}](${template.url})`).join(" or ");
  return `${ask} You can start from the ${links} template and keep it as minimal as possible.`;
}

export function isAllowedLabel(config: RepoConfig, label: string): boolean {
  return (
    MANAGED_LABELS.has(label) ||
    label === config.nextMajor?.label ||
    label.startsWith("upstream/") ||
    label.startsWith("component: ")
  );
}

export function countWords(text: string): number {
  // Links count as their text, not their URL.
  const visible = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "link");
  return visible.split(/\s+/).filter(Boolean).length;
}

export function mentionLine(config: RepoConfig, plan: TriagePlan): string {
  if (plan.mentions.length === 0) return "";
  const handles = config.maintainers.map((login) => `@${login}`).join(" ");
  const reasons = plan.mentions.map((mention) => `${MENTION_TEMPLATES[mention.template]} ${mention.detail}`.trim());
  return `cc ${handles}: ${reasons.join(" ")}`;
}

export function buildComment(config: RepoConfig, plan: TriagePlan, written: string): string {
  const parts: string[] = [];
  if (plan.security) {
    // Fixed wording. Nothing the model writes is posted next to a disclosed vulnerability.
    const where = config.securityPolicy ? `following our [security policy](${config.securityPolicy})` : "through the repository's security policy";
    parts.push(`Thanks for the report. Please report security issues privately ${where} rather than in a public issue.`);
  } else if (written.trim()) parts.push(written.trim());
  if (plan.facts.includes("REPRODUCTION_REQUEST")) parts.push(reproductionRequest(config));
  const mention = mentionLine(config, plan);
  if (mention) parts.push(mention);
  return parts.join("\n\n");
}

export interface AppliedActions {
  dryRun: boolean;
  blocked: string | null;
  setType: string | null;
  addedLabels: string[];
  removedLabels: string[];
  keptHumanLabels: string[];
  comment: string | null;
  commentUrl: string | null;
}

/** The only place that writes to an issue. */
export async function applyPlan(
  config: RepoConfig,
  plan: TriagePlan,
  written: string,
  humanLabels: ReadonlySet<string>,
  currentLabels: readonly string[],
): Promise<AppliedActions> {
  const addedLabels = plan.addLabels.filter((label) => isAllowedLabel(config, label) && !currentLabels.includes(label));
  const removable = plan.removeLabels.filter((label) => currentLabels.includes(label));
  // `triage` comes from the issue template, so it counts as applied by the reporter. It is the one label the bot owns.
  const removedLabels = removable.filter((label) => label === "triage" || !humanLabels.has(label));
  const keptHumanLabels = removable.filter((label) => !removedLabels.includes(label));
  const comment = plan.escalate ? "" : buildComment(config, plan, written);

  const actions: AppliedActions = {
    dryRun: plan.dryRun,
    blocked: null,
    setType: plan.escalate ? null : plan.setType,
    addedLabels: plan.escalate ? [] : addedLabels,
    removedLabels: plan.escalate ? [] : removedLabels,
    keptHumanLabels,
    comment: comment || null,
    commentUrl: null,
  };

  if (plan.escalate) actions.blocked = "needs_human: left in triage for a maintainer";
  else if (plan.skipped) actions.blocked = `skipped: ${plan.skipped}`;
  else if (!isProduction() && !plan.dryRun && !(await isPreviewWriteAllowed(plan.issue))) {
    actions.blocked = "not a production deployment and not triggered explicitly";
  }

  // The bot's own comment bumps `updated_at`, which makes the next sweep look at the issue again.
  // Same facts and mentions as last time means there is nothing new to say.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([plan.facts, plan.mentions.map((mention) => mention.template)]))
    .digest("hex");
  const repeated = comment !== "" && plan.facts.length + plan.mentions.length > 0 && (await getLastAnnounced(plan.issue)) === fingerprint;
  if (repeated) actions.comment = null;

  const write = !plan.dryRun && actions.blocked === null;
  if (write) {
    if (actions.setType) await setIssueType(plan.issue, actions.setType);
    await addLabels(plan.issue, actions.addedLabels);
    for (const label of actions.removedLabels) await removeLabel(plan.issue, label);
    if (actions.comment) {
      actions.commentUrl = await addComment(plan.issue, actions.comment);
      await setLastAnnounced(plan.issue, fingerprint);
    }
  } else {
    console.log(`[nuxi] ${plan.dryRun ? "dry-run" : "blocked"} ${plan.issue.owner}/${plan.issue.repo}#${plan.issue.issueNumber}`, JSON.stringify(actions));
  }

  await recordDecision({
    at: new Date().toISOString(),
    repo: `${plan.issue.owner}/${plan.issue.repo}`,
    issueNumber: plan.issue.issueNumber,
    step: "apply",
    answers: null,
    actions,
    dryRun: !write,
    runId: plan.runId,
  });

  return actions;
}

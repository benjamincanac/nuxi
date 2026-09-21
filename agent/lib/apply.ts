import { createHash } from "node:crypto";

import { isProduction, type RepoConfig } from "../config";
import { addComment, addLabels, ensureLabel, removeLabel, setIssueType } from "./github";
import type { ReproductionSettings } from "./issue-forms";
import { labelStyle } from "./labels";
import { MENTION_TEMPLATES, type TriagePlan } from "./plan";
import { getLastAnnounced, isPreviewWriteAllowed, recordDecision, setLastAnnounced } from "./store";

export const MAX_COMMENT_WORDS = 80;

/** Short templated request, built from what the repo's issue form says about reproductions. */
export function reproductionRequest(settings: ReproductionSettings): string {
  const { guide, templates } = settings;
  const ask = `Would you be able to provide a ${guide ? `[reproduction](${guide})` : "reproduction"}? 🙏`;
  if (templates.length === 0) return `${ask} Please keep it as minimal as possible.`;
  const links = templates.map((template) => `[${template.name.replace(/^the\s+/i, "")}](${template.url})`);
  const list = links.length > 1 ? `${links.slice(0, -1).join(", ")} or ${links.at(-1)}` : links[0];
  return `${ask} You can start from ${list}, and keep it as minimal as possible.`;
}

/** The bot only ever applies its own labels. `closed-by-bot`, priorities and the rest belong to maintainers. */
export function isAllowedLabel(config: RepoConfig, label: string): boolean {
  return labelStyle(config, label) !== null;
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

export function buildComment(config: RepoConfig, plan: TriagePlan, written: string, reproduction: ReproductionSettings): string {
  const parts: string[] = [];
  if (plan.security) {
    // Fixed wording. Nothing the model writes is posted next to a disclosed vulnerability.
    const where = config.securityPolicy ? `following our [security policy](${config.securityPolicy})` : "through the repository's security policy";
    parts.push(`Thanks for the report. Please report security issues privately ${where} rather than in a public issue.`);
  } else if (written.trim()) parts.push(written.trim());
  if (plan.facts.includes("REPRODUCTION_REQUEST")) parts.push(reproductionRequest(reproduction));
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
  reproduction: ReproductionSettings,
  intakeLabels: readonly string[],
): Promise<AppliedActions> {
  const addedLabels = plan.addLabels.filter((label) => isAllowedLabel(config, label) && !currentLabels.includes(label));
  const removable = plan.removeLabels.filter((label) => currentLabels.includes(label));
  // Intake labels come from the issue forms, so they count as applied by the reporter. They are the only ones of those the bot removes.
  const removedLabels = removable.filter((label) => intakeLabels.includes(label) || !humanLabels.has(label));
  const keptHumanLabels = removable.filter((label) => !removedLabels.includes(label));
  const comment = plan.escalate ? "" : buildComment(config, plan, written, reproduction);

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
    if (actions.setType && !(await setIssueType(plan.issue, actions.setType))) actions.setType = null;
    // Labels are created on first use, with their color and description. An existing label is never edited.
    for (const label of actions.addedLabels) {
      const style = labelStyle(config, label);
      if (style) await ensureLabel(plan.issue, label, style.color, style.description).catch(() => undefined);
    }
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

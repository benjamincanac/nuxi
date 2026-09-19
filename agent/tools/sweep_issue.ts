import { defineTool } from "eve/tools";

import { staleQuestions } from "../lib/jev/questions";
import { getTimeline, listReleases } from "../lib/github";
import { ask, clip } from "../lib/jev";
import { updatePlan, type PlanPatch } from "../lib/plan";
import { issueState } from "../lib/steps/classify";
import { markOnce, recordDecision } from "../lib/store";
import { issueInput, requireContext, runId } from "../lib/tool";

const DAY_MS = 24 * 60 * 60_000;

function daysSince(date: string | undefined): number {
  return date ? (Date.now() - Date.parse(date)) / DAY_MS : 0;
}

export default defineTool({
  description:
    "Daily sweep step for one issue. Applies the time based rules: follow up once on `needs reproduction`, mention maintainers when it stays idle, mention them when a `needs verification` issue gets no confirmation, and ask Jev whether a long idle `triage` issue is still relevant. Returns the tools to call next.",
  inputSchema: issueInput,
  label: { start: ({ owner, repo, issueNumber }) => `Sweep ${owner}/${repo}#${issueNumber}` },
  async execute(ref, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const { config, issue } = context;
    const { followUpDays, mentionDays, staleDays } = config.sweep;
    // Dry runs never consume the once-only markers.
    const once = (marker: string) => (config.dryRun ? Promise.resolve(true) : markOnce(ref, marker));

    const timeline = await getTimeline(ref, ctx.abortSignal);
    const labeledAt = (label: string) =>
      timeline.findLast((event) => event.event === "labeled" && event.label?.name === label)?.created_at;
    const reporterReplied = (since: string | undefined) =>
      issue.comments.some((comment) => comment.author === issue.author && (!since || comment.createdAt > since));

    let patch: PlanPatch = {};
    let next: string[] = [];
    let answers: unknown = null;

    if (issue.labels.includes("needs reproduction")) {
      const since = labeledAt("needs reproduction");
      const age = daysSince(since);
      if (reporterReplied(since)) next = ["classify_issue"];
      else if (age >= mentionDays && (await once("reproduction-mention"))) {
        patch = { mentions: [{ template: "needs_reproduction_idle", detail: `No reproduction after ${Math.floor(age)} days.` }] };
      } else if (age >= followUpDays && age < mentionDays && (await once("reproduction-follow-up"))) {
        patch = { facts: ["Friendly follow-up: a reproduction is still needed to look into this. REPRODUCTION_REQUEST is not repeated, just ask."] };
      }
    } else if (issue.labels.includes("needs verification")) {
      const since = labeledAt("needs verification");
      if (reporterReplied(since)) next = ["classify_issue"];
      else if (daysSince(since) >= followUpDays && (await once("verification-mention"))) {
        const evidence = issue.comments.findLast((comment) => comment.authorType === "Bot")?.body ?? "";
        patch = { mentions: [{ template: "verify_fixed", detail: clip(evidence.split("\n")[0] ?? "", 200) }] };
      }
    } else if (issue.labels.includes("triage") && daysSince(issue.updatedAt) >= staleDays) {
      const releases = (await listReleases(ref, ctx.abortSignal))
        .filter((release) => release.published_at && release.published_at > issue.createdAt)
        .slice(0, 10)
        .map((release) => ({ tag: release.tag_name, notes: clip(release.body ?? "", 1_500) }));
      const result = await ask(staleQuestions, { issue: issueState(context), releases }, ctx.abortSignal);
      answers = result;
      if (1 - result.still_relevant.probability >= config.thresholds.labels) {
        patch = {
          addLabels: issue.labels.includes("stale") ? [] : ["stale"],
          mentions: [{ template: "stale", detail: `Idle for ${Math.floor(daysSince(issue.updatedAt))} days and likely obsolete given the releases since.` }],
        };
      } else next = ["classify_issue"];
    } else {
      next = ["classify_issue"];
    }

    await updatePlan(runId(ctx), ref, config.dryRun, "sweep_issue", patch);
    await recordDecision({
      at: new Date().toISOString(),
      repo: `${ref.owner}/${ref.repo}`,
      issueNumber: ref.issueNumber,
      step: "sweep",
      answers,
      actions: patch,
      dryRun: config.dryRun,
      runId: runId(ctx),
    });
    return { facts: patch.facts ?? [], mentions: (patch.mentions ?? []).map((mention) => mention.template), next };
  },
});

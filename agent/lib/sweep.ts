import { isEnabled, type RepoConfig } from "../config";
import { listOpenIssues, listReleases, type Issue } from "./github";
import { kindOf, loadIntakeLabels, loadIssueKinds, type IssueKind } from "./issue-forms";
import { closedUpstreamPairs } from "./steps/upstream";
import { alreadyEvaluated, enqueue, getClassified, getLastSeenRelease, setLastSeenRelease, trackUpstreamPair, type Classified, type QueueItem } from "./store";

const DAY_MS = 24 * 60 * 60_000;
/** Labels tia applies that wait on someone. The intake labels of the repository are swept too. */
const SWEEP_LABELS = ["needs reproduction", "needs verification"];

/** Sessions started per minute by `schedules/dispatch_queue`. */
export const DISPATCH_BATCH = 5;

/**
 * A release re-opens one question and one only: is this fixed. It is worth asking about an open
 * report of the repository's own, and not about an issue that already waits on someone.
 * What classification remembered wins: it also knows the issues a maintainer took over, and the
 * kind of an issue the repository does not mark. An issue tia never classified is judged on its marks.
 */
export function releaseCheckApplies(
  config: RepoConfig,
  issue: Pick<Issue, "labels" | "type">,
  kinds: readonly IssueKind[],
  classified: Classified | null,
): boolean {
  if (!isEnabled(config, "fixed")) return false;
  if (issue.labels.includes("needs reproduction") || issue.labels.includes("needs verification")) return false;
  return classified?.releaseCheck ?? kindOf(issue, kinds)?.report === true;
}

function thresholdsCrossed(issue: Issue, config: RepoConfig): number {
  const idleDays = (Date.now() - Date.parse(issue.updatedAt)) / DAY_MS;
  const { followUpDays, mentionDays, staleDays } = config.sweep;
  return [followUpDays, mentionDays, staleDays].filter((days) => idleDays >= days).length;
}

export interface SweepSummary {
  repo: string;
  queued: number;
  unchanged: number;
  newRelease: string | null;
  upstreamClosed: number;
}

/**
 * Queues every issue with an intake label, `needs reproduction` or `needs verification` that changed
 * or crossed a follow-up threshold, as a `sweep`. An issue that did neither but may be affected by a
 * release published since the last sweep is queued as a `release`, which only re-checks the fix.
 */
export async function sweepRepo(config: RepoConfig, options: { force?: boolean; limit?: number; explicit?: boolean; stagger?: boolean } = {}): Promise<SweepSummary> {
  const repo = `${config.owner}/${config.repo}`;
  const [intakeLabels, kinds] = await Promise.all([loadIntakeLabels(config), loadIssueKinds(config)]);
  const [issues, releases, lastSeen] = await Promise.all([
    listOpenIssues(config, [...intakeLabels, ...SWEEP_LABELS]),
    listReleases(config),
    getLastSeenRelease(repo),
  ]);

  const latest = releases.find((release) => !release.prerelease)?.tag_name ?? null;
  const newRelease = latest !== null && latest !== lastSeen ? latest : null;
  const base: Pick<QueueItem, "owner" | "repo" | "explicit"> = { owner: config.owner, repo: config.repo, explicit: options.explicit };

  let queued = 0;
  let unchanged = 0;
  for (const issue of issues.slice(0, options.limit ?? issues.length)) {
    // The release is deliberately not part of the fingerprint. It changes whether the issue is
    // fixed, nothing about the issue itself, so a publish must not re-triage the whole backlog.
    const fingerprint = `${issue.updatedAt}:${thresholdsCrossed(issue, config)}`;
    const changed = options.force === true || !(await alreadyEvaluated(issue, fingerprint));
    // An unchanged issue is only worth a session when the release could have fixed it.
    if (!changed && !(newRelease && releaseCheckApplies(config, issue, kinds, await getClassified(issue)))) {
      unchanged++;
      continue;
    }
    // Spread over time so the queue starts a few sessions per minute.
    const delay = options.stagger === false ? 0 : Math.floor(queued / DISPATCH_BATCH) * 60_000;
    await enqueue({ ...base, issueNumber: issue.issueNumber, reason: changed ? "sweep" : "release", notBefore: Date.now() + delay });
    queued++;
  }

  const closed = await closedUpstreamPairs(repo);
  for (const pair of closed) {
    await enqueue({
      ...base,
      issueNumber: pair.issueNumber,
      reason: "upstream_closed",
      text: `${pair.upstreamUrl} is closed.`,
      notBefore: Date.now(),
    });
    if (!config.dryRun) await trackUpstreamPair({ ...pair, notifiedClosed: true });
  }

  if (newRelease) await setLastSeenRelease(repo, newRelease);
  return { repo, queued, unchanged, newRelease, upstreamClosed: closed.length };
}

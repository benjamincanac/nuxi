import type { RepoConfig } from "../config";
import { listOpenIssues, listReleases, type Issue } from "./github";
import { loadIntakeLabels } from "./issue-forms";
import { closedUpstreamPairs } from "./steps/upstream";
import { alreadyEvaluated, enqueue, getLastSeenRelease, setLastSeenRelease, trackUpstreamPair, type QueueItem } from "./store";

const DAY_MS = 24 * 60 * 60_000;
/** Labels nuxi applies that wait on someone. The intake labels of the repository are swept too. */
const SWEEP_LABELS = ["needs reproduction", "needs verification"];

/** Sessions started per minute by `schedules/dispatch_queue`. */
export const DISPATCH_BATCH = 5;

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
 * Queues every issue with an intake label, `needs reproduction` or `needs verification` that changed,
 * crossed a follow-up threshold, or may be affected by a release published since the last sweep.
 */
export async function sweepRepo(config: RepoConfig, options: { force?: boolean; limit?: number; explicit?: boolean; stagger?: boolean } = {}): Promise<SweepSummary> {
  const repo = `${config.owner}/${config.repo}`;
  const intakeLabels = await loadIntakeLabels(config);
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
    const fingerprint = `${issue.updatedAt}:${latest ?? ""}:${thresholdsCrossed(issue, config)}`;
    if (!options.force && (await alreadyEvaluated(issue, fingerprint))) {
      unchanged++;
      continue;
    }
    // Spread over time so the queue starts a few sessions per minute.
    const delay = options.stagger === false ? 0 : Math.floor(queued / DISPATCH_BATCH) * 60_000;
    await enqueue({ ...base, issueNumber: issue.issueNumber, reason: newRelease ? "release" : "sweep", notBefore: Date.now() + delay });
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

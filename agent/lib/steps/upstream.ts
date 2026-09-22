import { z } from "zod";

import { duplicateQuestions } from "../jev/questions";
import type { SimilarCandidate, TriageContext } from "../context";
import { gh } from "../github";
import { ask, choiceConfidence, RECENT_COMMENTS } from "../jev";
import type { PlanPatch } from "../plan";
import { listUpstreamPairs, trackUpstreamPair, type UpstreamPair } from "../store";
import { issueState } from "./classify";
import { findSimilarIssues } from "./duplicate";

export interface UpstreamOutcome {
  answers: unknown;
  upstream: string;
  match: SimilarCandidate | null;
  patch: PlanPatch;
}

/** Searches the upstream repo for the same problem and persists the pair when one is found. */
export async function trackUpstream(context: TriageContext, upstream: string, signal?: AbortSignal): Promise<UpstreamOutcome> {
  const { config, issue } = context;
  if (!config.upstreams.includes(upstream)) throw new Error(`${upstream} is not a configured upstream`);

  const [owner = "", repo = ""] = upstream.split("/");
  const candidates = context.fixture?.upstreamCandidates ?? (await findSimilarIssues({ owner, repo }, issue.title, null, 5, signal));
  if (candidates.length === 0) return { answers: null, upstream, match: null, patch: {} };

  const answers = await ask(duplicateQuestions(candidates), { issue: issueState(context, RECENT_COMMENTS), candidates }, signal);
  const match = candidates.find((candidate) => `#${candidate.number}` === answers.duplicate_of.choice) ?? null;
  const confident =
    match !== null &&
    answers.is_duplicate.probability >= config.thresholds.labels &&
    choiceConfidence(answers.duplicate_of) >= config.thresholds.labels;
  if (!confident || !match) return { answers, upstream, match: null, patch: {} };

  if (!context.dryRun) {
    await trackUpstreamPair({
      repo: `${issue.owner}/${issue.repo}`,
      issueNumber: issue.issueNumber,
      upstreamRepo: upstream,
      upstreamIssueNumber: match.number,
      upstreamUrl: match.url,
      notifiedClosed: false,
    });
  }

  return {
    answers,
    upstream,
    match,
    patch: { facts: [`The root cause looks upstream in ${upstream}, tracked in ${match.url}. Link it.`] },
  };
}

const stateSchema = z.object({ state: z.string() });

/** Tracked pairs whose upstream issue closed and that were not reported yet. */
export async function closedUpstreamPairs(repo: string, signal?: AbortSignal): Promise<UpstreamPair[]> {
  const pairs = (await listUpstreamPairs()).filter((pair) => pair.repo.toLowerCase() === repo.toLowerCase() && !pair.notifiedClosed);
  const closed: UpstreamPair[] = [];
  for (const pair of pairs) {
    const upstream = await gh(stateSchema, `/repos/${pair.upstreamRepo}/issues/${pair.upstreamIssueNumber}`, { signal }).catch(() => null);
    if (upstream?.state === "closed") closed.push(pair);
  }
  return closed;
}

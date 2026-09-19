import { componentLabel, isEnabled, upstreamLabel } from "../../config";
import {
  classifyQuestions,
  componentQuestionId,
  componentQuestions,
  upstreamQuestion,
} from "../jev/questions";
import type { TriageContext } from "../context";
import { ask, choiceConfidence, clipBody, clipComments } from "../jev";
import type { PlanPatch, SandboxResult } from "../plan";

export type NextStep =
  | "validate_reproduction"
  | "run_sandbox_repro"
  | "track_upstream"
  | "check_fixed_in_release"
  | "check_duplicate";

export interface ClassifyOutcome {
  answers: unknown;
  patch: PlanPatch;
  next: NextStep[];
  type: string | null;
}

export function issueState(context: TriageContext, sandboxResult?: SandboxResult | null) {
  const { issue } = context;
  return {
    title: issue.title,
    body: clipBody(issue.body),
    authorAssociation: issue.authorAssociation,
    existingLabels: issue.labels,
    comments: clipComments(issue.comments).map((comment) => ({
      author: comment.author,
      authorAssociation: comment.authorAssociation,
      isReporter: comment.author === issue.author,
      body: comment.body,
    })),
    ...(sandboxResult ? { sandboxResult: { outcome: sandboxResult.outcome, summary: sandboxResult.summary } } : {}),
  };
}

export async function classify(context: TriageContext, signal?: AbortSignal): Promise<ClassifyOutcome> {
  const { config, issue, components } = context;
  const t = config.thresholds;

  const answers = await ask(
    {
      ...classifyQuestions,
      upstream: upstreamQuestion(config.upstreams),
      ...componentQuestions(components, config.package?.componentPrefix),
    },
    issueState(context),
    signal,
  );

  // Below the threshold the type is unknown, and the Bug only steps do not run on a guess.
  const type = issue.type ?? (choiceConfidence(answers.type) >= t.labels ? answers.type.choice : null);
  const patch: PlanPatch = { addLabels: [], removeLabels: [], facts: [], mentions: [] };
  const labels = patch.addLabels ?? [];
  const facts = patch.facts ?? [];
  const mentions = patch.mentions ?? [];
  const next: NextStep[] = [];
  let decided = false;

  const summary = answers.is_english.probability < 0.5 ? ` The issue is not written in English: "${issue.title}".` : "";

  if (answers.is_security.probability >= t.labels) {
    return {
      answers,
      type,
      next: [],
      patch: {
        security: true,
        mentions: [{ template: "security", detail: `Publicly disclosed security report.${summary}` }],
        facts: [
          `Ask the author to report it privately${config.securityPolicy ? ` following ${config.securityPolicy}` : " through the repository's security policy"}. Do not discuss the details.`,
        ],
      },
    };
  }

  if (answers.needs_human.probability >= t.needs_human) {
    return { answers, type, next: [], patch: { escalate: true } };
  }

  if (isEnabled(config, "type") && !issue.type && type) patch.setType = type;

  // A decision already on the issue is not announced twice: re-evaluations stay silent about it.
  const has = (label: string) => issue.labels.includes(label);

  if (has("question")) {
    decided = true;
  } else if (isEnabled(config, "question") && answers.is_question.probability >= t.labels) {
    labels.push("question");
    mentions.push({ template: "convert_to_discussion", detail: `Usage question.${summary}` });
    facts.push(`This reads as a usage question. A Q&A discussion is a better place for it${config.help ? `, and ${config.help} may already answer it` : ""}. A maintainer may convert it.`);
    decided = true;
  } else {
    const upstream = answers.upstream.choice;
    if (isEnabled(config, "upstream") && upstream !== "none" && choiceConfidence(answers.upstream) >= t.labels) {
      if (!has(upstreamLabel(upstream))) {
        labels.push(upstreamLabel(upstream));
        next.push("track_upstream");
      }
      decided = true;
    }

    // A resolved thread wins over everything below: nobody needs a reproduction for a solved problem.
    const resolved = has("answered") || (isEnabled(config, "answered") && answers.is_answered.probability >= t.answered);
    if (resolved) {
      if (!has("answered")) {
        labels.push("answered");
        mentions.push({ template: "close_answered", detail: `The thread looks resolved.${summary}` });
      }
      decided = true;
    }

    // Asking for a reproduction ends the run. "Please reproduce" next to "this is fixed" or
    // "this is a duplicate" in the same comment would contradict itself.
    let waitsForReproduction = false;
    if (!resolved && type === "Bug" && isEnabled(config, "reproduction")) {
      if (answers.has_reproduction.probability < t.has_reproduction) {
        waitsForReproduction = true;
        if (!has("needs reproduction")) {
          labels.push("needs reproduction");
          facts.push("REPRODUCTION_REQUEST");
        }
        decided = true;
      } else {
        next.push("validate_reproduction");
        if (isEnabled(config, "sandbox") && config.package) next.push("run_sandbox_repro");
      }
    }

    if (!resolved && !waitsForReproduction) {
      if (isEnabled(config, "fixed") && type === "Bug" && !has("needs verification")) next.push("check_fixed_in_release");
      if (isEnabled(config, "duplicate") && !has("duplicate")) next.push("check_duplicate");
    }

    if (!resolved && !waitsForReproduction && isEnabled(config, "breaking") && config.nextMajor && answers.needs_breaking_change.probability >= t.labels) {
      labels.push(config.nextMajor.label);
      decided = true;
    }
  }

  if (isEnabled(config, "a11y") && answers.is_a11y.probability >= t.labels) labels.push("a11y");

  if (isEnabled(config, "component")) {
    const byId = answers as Record<string, { type: string; probability?: number }>;
    for (const name of components) {
      const probability = byId[componentQuestionId(name)]?.probability ?? 0;
      if (probability >= t.labels) labels.push(componentLabel(name));
    }
  }

  patch.addLabels = labels.filter((label) => !issue.labels.includes(label));
  if (decided) patch.removeLabels = ["triage"];

  return { answers, patch, next, type };
}

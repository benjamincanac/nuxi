import { env } from "../config";
import type { Experimental_EvaluationQuestion as Question, JSONValue } from "ai";
import { evaluate } from "eve/ai";

/** Resolved through AI Gateway. */
export function jevModel(): string {
  return env("JEV_MODEL") ?? "typesafe-ai/jev";
}

export async function ask<const Q extends Record<string, Question>>(
  questions: Q,
  state: Exclude<JSONValue, null | number | boolean>,
  abortSignal?: AbortSignal,
) {
  const result = await evaluate({ model: jevModel(), state, questions, abortSignal });
  return result.answers;
}

interface ChoiceAnswer<C extends string> {
  choice: C;
  probabilities?: Record<C, number>;
}

/** Probability of the selected option. Providers without a distribution count as certain. */
export function choiceConfidence<C extends string>(answer: ChoiceAnswer<C>): number {
  return answer.probabilities?.[answer.choice] ?? 1;
}

const MAX_BODY = 8_000;
const MAX_COMMENT = 1_500;
const MAX_COMMENTS = 30;

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

export function clipBody(text: string): string {
  return clip(text, MAX_BODY);
}

export function clipComments<T extends { body: string }>(comments: readonly T[]): T[] {
  return comments.slice(-MAX_COMMENTS).map((comment) => ({ ...comment, body: clip(comment.body, MAX_COMMENT) }));
}

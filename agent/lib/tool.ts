import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";

import { env, requireApproval } from "../config";
import { FIXTURE_OWNER, loadTriageContext, type TriageContext } from "./context";
import { loadRepoConfig, type IssueRef } from "./github";
import { isDryRunForced, isTriageRun } from "./store";

export const issueInput = z.object({
  owner: z.string().min(1).describe("Repository owner"),
  repo: z.string().min(1).describe("Repository name"),
  issueNumber: z.number().int().positive(),
});

/** One plan per turn. A session is reused for every event on the same issue thread. */
export function runId(ctx: { session: { id: string; turn: { id: string } } }): string {
  return `${ctx.session.id}:${ctx.session.turn.id}`;
}

export async function requireContext(ref: IssueRef, signal?: AbortSignal): Promise<TriageContext> {
  const context = await loadTriageContext(ref, signal);
  if (!context) throw new Error(`Triage is disabled for ${ref.owner}/${ref.repo}: no valid .github/nuxi.yml.`);
  if (!context.config.dryRun && (await isDryRunForced(ref))) context.config = { ...context.config, dryRun: true };
  return context;
}

/**
 * Backlog tools answer a maintainer's questions. Inside a triage run they are a detour, and a small
 * model will take it, so they refuse once the run has a plan.
 */
export async function refuseDuringTriage(ctx: { session: { id: string; turn: { id: string } } }): Promise<void> {
  if (await isTriageRun(runId(ctx))) {
    throw new Error("Not available during a triage run. Follow the triage skill and finish with apply_triage.");
  }
}

/**
 * Who may press Approve. `NUXI_APPROVER_IDS` is a comma separated list of principal ids:
 * `discord:<user>` in a direct message, `discord:<guild>:<user>` in a server, or `github:<user id>`.
 * Anyone in the channel may approve when unset.
 */
export function approverResponse({ responder }: { responder: { principalId: string } }) {
  const approvers = (env("NUXI_APPROVER_IDS") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (approvers.length === 0 || approvers.includes(responder.principalId)) return { status: "allowed" as const };
  return { status: "rejected" as const, reason: "Only a maintainer can approve triage writes." };
}

/** Pauses for a maintainer before a real write. Dry runs write nothing, so they never ask. */
export async function writeApproval<T>({ toolInput }: ApprovalContext<T>): Promise<ApprovalStatus> {
  const input = issueInput.safeParse(toolInput);
  if (!input.success) return "user-approval";
  if (input.data.owner === FIXTURE_OWNER) return "not-applicable";
  const config = await loadRepoConfig(input.data);
  if (!config) return { type: "denied", reason: "Triage is disabled for this repository." };
  if (config.dryRun || (await isDryRunForced(input.data))) return "not-applicable";
  return requireApproval() ? "user-approval" : "not-applicable";
}

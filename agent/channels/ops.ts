import { timingSafeEqual } from "node:crypto";

import { defineChannel, GET, POST } from "eve/channels";
import { z } from "zod";

import { buildDigest, digestEmbeds } from "../lib/digest";
import { postEmbeds } from "../lib/discord";
import { getTokenResponse } from "@vercel/connect";

import { githubConnector, isProduction } from "../config";
import { dispatch, drainAndDispatch } from "../lib/dispatch";
import { gh, listOpenIssues, loadRepoConfig } from "../lib/github";
import { openSetupPullRequest, proposeSetup } from "../lib/setup";
import { DISPATCH_BATCH, sweepRepo } from "../lib/sweep";
import { enqueue, listDecisions } from "../lib/store";

const OPS_AUTH = {
  authenticator: "ops",
  principalType: "service",
  principalId: "nuxi:ops",
  attributes: {},
} as const;

const triggerBody = z.object({
  // No leading dot: `..` would walk the API path.
  repo: z.string().regex(/^[\w-][\w.-]*\/[\w-][\w.-]*$/),
  issueNumber: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(1_000).optional(),
  /** Without it a preview deployment logs what it would do and writes nothing. */
  write: z.boolean().default(false),
});

function authorized(request: Request): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  const header = request.headers.get("authorization") ?? "";
  if (!secret || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Manual triggers for previews and backfills: `triage`, `sweep`, `backfill` and `digest`.
 * The path sits outside `/eve/v1`, which eve reserves for its own routes.
 */
export default defineChannel({
  routes: [
    POST("/ops/:id/trigger", async (request, { params, to, waitUntil }) => {
      if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
      const body = triggerBody.safeParse(await request.json().catch(() => null));
      if (!body.success) return Response.json({ error: z.prettifyError(body.error) }, { status: 400 });

      const [owner = "", repo = ""] = body.data.repo.split("/");

      // Reports what the deployment's GitHub credentials can actually see. For setup and support.
      if (params.id === "check") {
        const connector = githubConnector();
        // Never return the token itself, only what identifies it.
        const minted = await getTokenResponse(connector, { subject: { type: "app" } }).catch((error: unknown) => String(error));
        const token =
          typeof minted === "string"
            ? minted
            : { installationId: minted.installationId, expiresAt: new Date(minted.expiresAt).toISOString() };
        const visible = await gh(z.object({ full_name: z.string(), private: z.boolean() }), `/repos/${owner}/${repo}`).catch(
          (error: unknown) => String(error),
        );
        return Response.json({ environment: process.env.VERCEL_ENV ?? "local", connector, token, repository: visible });
      }

      // The one trigger that runs on a repository without a config, since it creates it.
      if (params.id === "setup") {
        if (!body.data.write) return Response.json(await proposeSetup({ owner, repo }));
        return Response.json(await openSetupPullRequest({ owner, repo }));
      }

      const config = await loadRepoConfig({ owner, repo });
      if (!config) return Response.json({ error: `Triage is disabled for ${body.data.repo}: no valid .github/nuxi.yml.` }, { status: 404 });
      const explicit = body.data.write;
      const production = isProduction();

      switch (params.id) {
        case "triage": {
          if (!body.data.issueNumber) return Response.json({ error: "issueNumber is required" }, { status: 400 });
          const item = { owner, repo, issueNumber: body.data.issueNumber, reason: "manual" as const, notBefore: Date.now(), explicit, dryRun: !explicit };
          return Response.json({ dispatched: await dispatch(to, OPS_AUTH, item) });
        }
        case "sweep": {
          const summary = await sweepRepo(config, { force: true, limit: body.data.limit, explicit, stagger: production });
          if (!production) waitUntil(drainAndDispatch(to, OPS_AUTH, summary.queued + summary.upstreamClosed));
          return Response.json(summary);
        }
        case "backfill": {
          // Whole open backlog, always dry-run. Results are read back from the decision log.
          const since = new Date().toISOString();
          const issues = (await listOpenIssues(config)).slice(0, body.data.limit ?? 1_000);
          waitUntil(
            (async () => {
              for (const [index, issue] of issues.entries()) {
                const delay = production ? Math.floor(index / DISPATCH_BATCH) * 60_000 : 0;
                await enqueue({ owner, repo, issueNumber: issue.issueNumber, reason: "manual", dryRun: true, notBefore: Date.now() + delay });
              }
              // Cron only runs on production. Elsewhere the route drains its own queue.
              if (!production) await drainAndDispatch(to, OPS_AUTH, issues.length);
            })(),
          );
          return Response.json({ queued: issues.length, since, etaMinutes: Math.ceil(issues.length / DISPATCH_BATCH) });
        }
        case "digest": {
          const digest = await buildDigest(config);
          if (explicit && config.discord.digestChannel) await postEmbeds(config.discord.digestChannel, digestEmbeds(digest));
          return Response.json(digest);
        }
        default:
          return Response.json({ error: `Unknown trigger ${params.id}`, available: ["triage", "sweep", "backfill", "digest", "setup", "check"] }, { status: 404 });
      }
    }),

    GET("/ops/decisions", async (request) => {
      if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
      const url = new URL(request.url);
      const repo = url.searchParams.get("repo")?.toLowerCase();
      const since = url.searchParams.get("since") ?? "";
      const decisions = (await listDecisions()).filter((decision) => (!repo || decision.repo.toLowerCase() === repo) && decision.at >= since);
      // JSONL, the format used to tune thresholds.
      return new Response(decisions.map((decision) => JSON.stringify(decision)).join("\n"), {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    }),
  ],
});

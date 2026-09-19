import type { Experimental_EvaluationQuestion as Question } from "ai";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import type { RepoConfig } from "../../config";
import type { ReproductionCheck, TriageContext } from "../context";
import { gh, githubToken } from "../github";
import { ask, clip } from "../jev";
import type { SandboxOutcome, SandboxResult } from "../plan";
import { issueState } from "./classify";

/** Whole run, both installs and builds included. */
export const SANDBOX_TIMEOUT_MS = 8 * 60_000;

/** Only the npm registry, plus the host serving the next major build. The repo tarball is uploaded from the app runtime. */
export function sandboxNetworkPolicy(nextPackage: string | null): { allow: string[] } {
  const allow = ["registry.npmjs.org"];
  if (nextPackage?.startsWith("https://")) allow.push(new URL(nextPackage).hostname);
  return { allow };
}

type Runner = Pick<SandboxSession, "run" | "writeBinaryFile" | "setNetworkPolicy">;

const sandboxQuestions = {
  reproduced_latest: {
    type: "boolean",
    instructions:
      "Do the install and build logs on the latest published version show the problem described in the issue (same error, same failing type, same crash)? A clean build of a project whose bug is only visible in the browser is not a reproduction.",
  },
  reproduced_next: {
    type: "boolean",
    instructions:
      "Do the install and build logs on the next major build show the problem described in the issue? False when there are no such logs.",
  },
  verifiable: {
    type: "boolean",
    instructions:
      "Can the problem described in the issue be observed from install, typecheck or build logs at all? False for visual, interaction or runtime-only browser bugs.",
  },
} as const satisfies Record<string, Question>;

const commitSchema = z.object({ sha: z.string() });

/** Install spec of the next major build, or `null` when the repo has none configured. */
async function nextMajorPackage(config: RepoConfig, signal?: AbortSignal): Promise<string | null> {
  const next = config.nextMajor;
  if (!next?.branch || !next.package) return null;
  const source = config.componentsSource ?? `${config.owner}/${config.repo}`;
  const { sha } = await gh(commitSchema, `/repos/${source}/commits/${encodeURIComponent(next.branch)}`, { signal });
  return next.package.replace("{sha}", sha.slice(0, 7));
}

async function downloadTarball(repository: NonNullable<ReproductionCheck["repository"]>, signal?: AbortSignal): Promise<Uint8Array> {
  const ref = repository.ref ? `/${encodeURIComponent(repository.ref)}` : "";
  const response = await fetch(`https://api.github.com/repos/${repository.owner}/${repository.repo}/tarball${ref}`, {
    headers: { authorization: `Bearer ${await githubToken()}`, "user-agent": "nuxi-triage" },
    redirect: "follow",
    signal,
  });
  if (!response.ok) throw new Error(`Could not download ${repository.owner}/${repository.repo}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("Reproduction repository is larger than 25 MB");
  return bytes;
}

async function build(runner: Runner, directory: string, name: string, spec: string, signal: AbortSignal): Promise<string> {
  // Scripts are disabled on install: the reproduction is untrusted code.
  const steps = [
    `npm pkg set "dependencies.${name}=${spec}"`,
    "npm install --ignore-scripts --no-audit --no-fund --loglevel=error",
    "if npm pkg get scripts.typecheck | grep -q '\"'; then npm run typecheck; fi",
    "npm run build",
  ];
  const logs: string[] = [];
  for (const command of steps) {
    const result = await runner.run({ command, workingDirectory: directory, abortSignal: signal });
    logs.push(`$ ${command}\nexit ${result.exitCode}\n${clip(result.stdout, 2_000)}\n${clip(result.stderr, 4_000)}`);
    if (result.exitCode !== 0) break;
  }
  return logs.join("\n\n");
}

function outcome(latest: boolean, next: boolean, hasNext: boolean, verifiable: boolean): SandboxOutcome {
  if (!verifiable) return "inconclusive";
  if (latest && (next || !hasNext)) return "reproduced";
  if (latest) return "not_on_next";
  return "no_longer_reproduces";
}

const SUMMARIES: Record<SandboxOutcome, string> = {
  reproduced: "Reproduced on the latest published version.",
  not_on_next: "Reproduced on the latest published version, not on the next major build.",
  no_longer_reproduces: "No longer reproduces on the latest version.",
  inconclusive: "The project installs and builds, the problem cannot be observed from build logs.",
  failed: "The sandbox run failed.",
  skipped: "No repository based reproduction to run.",
};

export async function runSandboxRepro(
  context: TriageContext,
  reproduction: ReproductionCheck | null,
  latestVersion: string | null,
  getRunner: () => Promise<Runner>,
  parentSignal?: AbortSignal,
): Promise<{ answers: unknown; result: SandboxResult }> {
  const skipped = (summary: string): { answers: null; result: SandboxResult } => ({
    answers: null,
    result: { outcome: "skipped", latestVersion, summary },
  });

  const { config } = context;
  let logs: { latest: string; next: string | null } | null = context.fixture?.sandboxLogs ?? null;

  if (!logs) {
    if (context.fixture || !reproduction?.repository || !config.package || !latestVersion) return skipped(SUMMARIES.skipped);
    const name = config.package.name;

    const timeout = AbortSignal.timeout(SANDBOX_TIMEOUT_MS);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    try {
      const [tarball, next] = await Promise.all([downloadTarball(reproduction.repository, signal), nextMajorPackage(config, signal)]);
      const runner = await getRunner();
      await runner.setNetworkPolicy(sandboxNetworkPolicy(next));
      await runner.run({ command: "mkdir -p repro", abortSignal: signal });
      await runner.writeBinaryFile({ path: "repro/source.tgz", content: tarball, abortSignal: signal });
      const prepare = await runner.run({
        command: "rm -rf latest next && mkdir latest next && tar -xzf source.tgz -C latest --strip-components=1 && tar -xzf source.tgz -C next --strip-components=1",
        workingDirectory: "repro",
        abortSignal: signal,
      });
      if (prepare.exitCode !== 0) throw new Error(prepare.stderr);
      logs = {
        latest: await build(runner, "repro/latest", name, latestVersion, signal),
        next: next ? await build(runner, "repro/next", name, next, signal) : null,
      };
    } catch (error) {
      const reason = timeout.aborted ? "timed out" : error instanceof Error ? error.message : String(error);
      return { answers: null, result: { outcome: "failed", latestVersion, summary: `${SUMMARIES.failed} (${clip(reason, 200)})` } };
    }
  }

  const answers = await ask(sandboxQuestions, { issue: issueState(context), logs }, parentSignal);
  const resolved = outcome(
    answers.reproduced_latest.probability >= 0.5,
    answers.reproduced_next.probability >= 0.5,
    logs.next !== null,
    answers.verifiable.probability >= 0.5,
  );
  return { answers, result: { outcome: resolved, latestVersion, summary: SUMMARIES[resolved] } };
}

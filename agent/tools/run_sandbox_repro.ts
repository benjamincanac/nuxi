import { defineTool } from "eve/tools";

import { getPlan, recordDecision } from "../lib/store";
import { updatePlan } from "../lib/plan";
import { latestPackageVersion } from "../lib/steps/reproduction";
import { runSandboxRepro } from "../lib/steps/sandbox";
import { issueInput, requireContext, runId } from "../lib/tool";

export default defineTool({
  description:
    "Runs the validated reproduction in the sandbox against the latest published version of the package and against the next major build when the repo configures one, with a hard timeout and npm-only network. Call it after validate_reproduction. Records the outcome in the run's plan.",
  inputSchema: issueInput,
  label: { start: ({ owner, repo, issueNumber }) => `Run reproduction of ${owner}/${repo}#${issueNumber}` },
  async execute(ref, ctx) {
    const context = await requireContext(ref, ctx.abortSignal);
    const plan = await getPlan(runId(ctx), ref);
    const latestVersion =
      plan?.latestVersion ??
      context.fixture?.latestVersion ??
      (context.config.package ? await latestPackageVersion(context.config.package.name, ctx.abortSignal) : null);

    const { answers, result } = await runSandboxRepro(
      context,
      plan?.reproduction ?? null,
      latestVersion,
      () => ctx.getSandbox(),
      ctx.abortSignal,
    );

    const reportable = result.outcome !== "skipped" && result.outcome !== "failed";
    await updatePlan(runId(ctx), ref, context.config.dryRun, "run_sandbox_repro", {
      sandbox: result,
      facts: reportable ? [`Sandbox: ${result.summary}`] : [],
    });
    await recordDecision({
      at: new Date().toISOString(),
      repo: `${ref.owner}/${ref.repo}`,
      issueNumber: ref.issueNumber,
      step: "sandbox",
      answers,
      actions: result,
      dryRun: context.config.dryRun,
      runId: runId(ctx),
    });
    return result;
  },
});

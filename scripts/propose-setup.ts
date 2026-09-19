/**
 * Prints the setup pull request nuxi would open on a repository. Read-only.
 *
 *   pnpm propose-setup <owner/repo>
 */
import { execFileSync } from "node:child_process";

import { proposeSetup, setupPullRequestBody } from "../agent/lib/setup";

process.env.NUXI_SCRIPT_TOKEN ??= process.env.GITHUB_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

const slug = process.argv[2] ?? "";
if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) {
  console.log("Usage: pnpm propose-setup <owner/repo>");
  process.exit(1);
}
const [owner = "", repo = ""] = slug.split("/");

const proposal = await proposeSetup({ owner, repo });
console.log(`# .github/nuxi.yml\n\n${proposal.yaml}\n# Pull request body\n\n${setupPullRequestBody(proposal, [])}`);

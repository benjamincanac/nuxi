import githubExtension from "@github-tools/eve-extension";

import { githubConnector, requireApproval } from "../config";

/**
 * Read access to GitHub for the pipeline and for backlog questions, exposed as `github__<tool>`.
 * The extension is the durable way to mount GitHub Tools on eve, `@github-tools/sdk/eve` is deprecated.
 *
 * Every write tool of the presets is excluded. Triage writes go through `apply_triage`, which is
 * where dry-run, the human label rule and the single comment per run are enforced. A generic
 * `closeIssue` or `removeLabel` in the model's hands would bypass all three.
 */
export default githubExtension({
  connector: githubConnector,
  preset: ["issue-triage", "repo-explorer"],
  exclude: [
    "createIssue",
    "closeIssue",
    "updateIssue",
    "addIssueComment",
    "updateIssueComment",
    "deleteIssueComment",
    "addLabels",
    "removeLabel",
    "createLabel",
    "updateLabel",
    "deleteLabel",
    "addAssignees",
    "removeAssignees",
    "addIssueReaction",
    "addCommentReaction",
    // Gists need a user token. Installation tokens minted by Connect get a 403.
    "listGists",
    "getGist",
    "listGistComments",
  ],
  // Applies to any write tool re-enabled later by trimming the list above.
  requireApproval: requireApproval(),
});

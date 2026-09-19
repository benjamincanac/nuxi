# nuxi

An [eve](https://eve.dev) agent that triages GitHub issues. It runs as the `nuxi[bot]` GitHub App through [Vercel Connect](https://vercel.com/docs/connect), reads its configuration from each repository's `.github/nuxi.yml`, and moves issues out of `triage` by taking one decision per issue.

It never closes, transfers or converts an issue, and never removes a label a human applied. Anything irreversible is handed to the repository's maintainers with an @-mention.

## How it works

```
GitHub webhook ─▶ channels/github.ts ─▶ Redis queue ─▶ schedules/dispatch_queue.ts ─▶ session
daily sweep ────────────────────────────▲                                              │
ops route ──────────────────────────────┘                                              ▼
                                classify_issue ─▶ track_upstream ─▶ validate_reproduction ─▶ run_sandbox_repro
                                                ─▶ check_fixed_in_release ─▶ check_duplicate ─▶ apply_triage
```

Every closed decision is taken by Jev (`typesafe-ai/jev`) through the AI SDK's `experimental_evaluate`, inside the tools. Question sets live in [`agent/lib/jev/questions.ts`](agent/lib/jev/questions.ts). Tools compare the probabilities with the thresholds of the repository, record the resulting actions in a plan, and persist the raw answers next to them. The model never sees a probability. It writes the comment and nothing else, and `autoModel` picks Sonnet or Haiku per turn.

[`apply_triage`](agent/tools/apply_triage.ts) is the only tool that writes to GitHub. It enforces dry-run, the 80 word limit, one comment per run, the label allow-list, and the rule that human applied labels stay. The GitHub Tools extension is mounted read-only for that reason, see [`agent/extensions/github.ts`](agent/extensions/github.ts).

Runs that need an approval start in the Discord approvals channel, where eve renders the prompt as buttons and resumes the session on click. Dry runs and runs with approvals turned off happen silently on the issue thread. When approvals are required and the repository has no approvals channel, the run is forced to dry-run, because eve's GitHub channel would otherwise post the approval prompt as a public comment.

Text written by GitHub users never reaches the model's turn prompt. An @-mention is reduced by Jev to one boolean, triage request or not. A triage request re-runs the pipeline. Anything else gets one sentence pointing to `help`.

## Configuration

Each repository owns its config in `.github/nuxi.yml`, reviewed through pull requests like `renovate.json`. The agent reads it through the GitHub API at event time and caches it for 5 minutes. A missing or invalid file means triage is disabled for that repository. Nothing in the agent code is specific to one repository.

```yaml
# Log intended actions and probabilities, write nothing. Defaults to true when absent.
dryRun: true
# Required. Mentioned for irreversible decisions. Their own issues are skipped.
maintainers: [benjamincanac]

# Glob of component files. One Jev question and one `component: <kebab-name>` label per match.
components: src/runtime/components/*.vue
# Read components, and the next major branch, from another repository.
componentsSource: nuxt/ui

# Root cause candidates. Each gets an `upstream/<repo>` label.
upstreams:
  - unovue/reka-ui
  - tailwindlabs/tailwindcss

# npm package the repository publishes. Without it version checks and sandbox runs are skipped.
package:
  name: "@nuxt/ui"
  componentPrefix: U      # how users write components, UButton

# Breaking changes get `label`. The sandbox also builds against `branch` when `package` is set.
nextMajor:
  label: v5
  branch: v5
  package: https://pkg.pr.new/@nuxt/ui@{sha}

# Builds the reproduction request. `blank` lists link fragments that point at an unmodified starter.
reproduction:
  guide: https://nuxt.com/docs/community/reporting-bugs/#create-a-minimal-reproduction
  templates:
    - { name: Nuxt, url: https://codesandbox.io/p/devbox/nuxt-ui-xgrzw5 }
  blank: [nuxt-ui-xgrzw5, nuxt-ui-templates/starter]

# Where public security reports are redirected.
securityPolicy: https://github.com/nuxt/.github/blob/main/SECURITY.md
# Where general questions are pointed when the bot is mentioned for something that is not triage.
help: https://nuxt.com

# Decisions to run. Remove one to turn it off.
decisions: [type, question, upstream, reproduction, sandbox, fixed, duplicate, answered, breaking, a11y, component, pr]

# Overrides of the defaults in agent/config.ts.
thresholds:
  labels: 0.8
  has_reproduction: 0.6
  duplicate: 0.85
  answered: 0.85
  is_fixed: 0.8
  needs_human: 0.5

sweep: { followUpDays: 14, mentionDays: 30, staleDays: 60 }

discord:
  digestChannel: ""       # falls back to DISCORD_DIGEST_CHANNEL_ID
  approvalsChannel: ""    # falls back to DISCORD_APPROVALS_CHANNEL_ID
```

Full examples: [`examples/nuxt-ui.nuxi.yml`](examples/nuxt-ui.nuxi.yml) and [`examples/playground.nuxi.yml`](examples/playground.nuxi.yml). Validate a file with `pnpm validate-config path/to/nuxi.yml`, or on pull requests with the action in [`action/validate-config`](action/validate-config/action.yml).

Global settings are environment variables only, documented in [`.env.example`](.env.example).

## Vercel Connect

Two GitHub connectors keep previews away from the production app: `github/nuxi` in production, `github/nuxi-preview` for local dev and previews. `GITHUB_CONNECTOR` overrides the choice. There is no `GITHUB_TOKEN`, app private key or webhook secret in the environment.

```sh
pnpm install
vercel link
vercel env pull

# Production app, with webhooks forwarded to the GitHub channel.
vercel connect create github --name nuxi
vercel connect attach github/nuxi --environment production --triggers --trigger-path /eve/v1/github

# Preview and local dev app. No triggers: previews are driven through the ops route.
vercel connect create github --name nuxi-preview
vercel connect attach github/nuxi-preview --environment preview --environment development
```

The GitHub App needs read and write on Issues, read on Pull requests, Contents and Metadata, and the `issues`, `issue_comment` and `pull_request` events. Install it from the Connect dashboard on your personal account with the playground repository only. Reading a public repository such as `nuxt/ui` needs no installation. When the bot is validated, install the same app on the target organization. No code change, the repositories are picked up as soon as they carry a valid `.github/nuxi.yml`.

If another project later needs GitHub access under the nuxi identity, attach `github/nuxi` to it instead of creating a second app.

For Discord, `pnpm eve add channel/discord` creates the connector, registers `/ask` and points the application's Interactions Endpoint URL at Connect. Keep the existing `agent/channels/discord.ts`, do not pass `--overwrite`. The eve Discord channel works over HTTP interactions, so the conversation happens through `/ask`, in a channel or in a DM with the app.

The full walkthrough, Discord included, is in [`docs/SETUP.md`](docs/SETUP.md).

Deploy with `pnpm run deploy`. Add Upstash Redis from the Vercel Marketplace and set `INTERNAL_API_SECRET`.

## Labels

```sh
pnpm labels <owner/repo> [--dry-run]
```

Idempotent. Creates `duplicate`, `answered`, `question`, `needs verification`, `has pr`, `a11y`, `triage`, `needs reproduction`, `stale`, the next major label, one `upstream/<repo>` per upstream and one `component: <kebab-name>` per component. Existing labels are never edited. The bot never applies `closed-by-bot`, priority labels or anything outside that list.

## Sandbox

For bugs with a repository based reproduction, `run_sandbox_repro` downloads the repository tarball from the app runtime, uploads it into the session's sandbox, then installs and builds it twice: against the latest published version of the package, and against a build of the next major branch when configured. Sessions start with `deny-all` egress ([`agent/sandbox.ts`](agent/sandbox.ts)). The tool opens `registry.npmjs.org` and the host of the next major build right before installing. Installs run with `--ignore-scripts`, and the whole run has an 8 minute hard timeout.

Jev reads the logs and answers whether the problem shows up. Only install, typecheck and build problems can be observed this way. Visual and interaction bugs come back as `inconclusive` and are not mentioned in the comment. StackBlitz projects and CodeSandbox devboxes are checked for a working link only, since neither exposes a stable API to read their files.

Domain allow-lists need the Vercel Sandbox or microsandbox backend. With Docker locally the run reports `failed`.

## Playground workflow

1. Create the playground repository, install the preview app on it, and commit [`examples/playground.nuxi.yml`](examples/playground.nuxi.yml) as `.github/nuxi.yml`.
2. `pnpm labels <you>/nuxi-triage-playground`
3. `pnpm seed --from nuxt/ui --to <you>/nuxi-triage-playground --count 30` copies a mix of issues with their comments as quoted blocks and a link back. Mentions are neutralized. Running it again skips what is already there.
4. Dry-run the real backlog: `pnpm backfill nuxt/ui --config examples/nuxt-ui.nuxi.yml`. It writes `backfill.csv` with the proposed actions and probabilities per issue. Add `--url https://<preview>` to run it on a deployment, sandbox included.
5. Trigger real writes on the playground from a preview:

```sh
curl -X POST https://<preview>/ops/triage/trigger \
  -H "authorization: Bearer $INTERNAL_API_SECRET" -H "content-type: application/json" \
  -d '{ "repo": "<you>/nuxi-triage-playground", "issueNumber": 12, "write": true }'
```

Triggers: `triage`, `sweep`, `backfill`, `digest`. A preview never writes unless the request carries `"write": true`. `GET /ops/decisions?repo=&since=` exports the decision log as JSONL for threshold tuning.

## Schedules

| Schedule | When | What |
| --- | --- | --- |
| `dispatch_queue` | every minute | Starts up to 5 queued sessions. |
| `daily_sweep` | 03:00 UTC | Re-evaluates `triage`, `needs reproduction` and `needs verification` issues that changed or crossed a threshold. Picks up new releases and closed upstream issues. |
| `weekly_digest` | Monday 09:00 Europe/Paris | One Discord message per repository: issues waiting on a maintainer by reason, duplicates detected, component clusters, top enhancements by 👍, sandbox results, totals. |

## Evals

`pnpm eval` runs the fixtures in [`evals/`](evals). A fixture is a JSON file addressed as `fixture/<name>#1`. It carries its own config, issue, similar issues and release candidates, so evals call Jev and the model but never GitHub.

## Differences with the original brief

- eve 0.58 has no `eve/ai` or `eve/models`. Jev is called with `experimental_evaluate` from `ai`, model routing uses `autoModel` from `eve/experimental/evaluate`, and approvals use a policy built on `eve/tools/approval` since there is no `auto()` helper.
- The GitHub channel has `onIssue`, `onComment` and `onPullRequest`, and no release hook. Releases are detected by the daily sweep.
- eve reserves `/eve/v1/*`, so the ops routes live under `/ops`.
- Evals live in `evals/`, where `eve eval` discovers them, and use `t.judge.autoevals`.
- `@github-tools/sdk/eve` is deprecated and not durable across workflow replays. The agent mounts `@github-tools/eve-extension` with the same presets.

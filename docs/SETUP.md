# Deploy and set up nuxi

From an empty Vercel account to a bot that triages a playground repository, then a real one. Count about an hour. Every step says how to check it worked before moving on.

You need:

- Node 24 and pnpm
- The Vercel CLI, 56.4 or later: `pnpm add -g vercel`
- A Vercel team on the Pro plan. `dispatch_queue` runs every minute and Hobby only allows daily cron jobs.
- A GitHub account where you can create and install a GitHub App
- A Discord server where you can add a bot

## 1. Link the project

```sh
git clone https://github.com/benjamincanac/nuxi.git
cd nuxi
pnpm install
vercel link
vercel env pull
```

`vercel env pull` writes `.env.local` with a `VERCEL_OIDC_TOKEN`. That token authenticates both AI Gateway and Vercel Connect from your machine, so there is no API key to create. It expires after 12 hours, run `vercel env pull` again when calls start failing with 401.

Check: `pnpm typecheck` and `pnpm build` pass.

## 2. Run the evals

This is the first time Jev and the models actually run, so do it before anything touches GitHub.

```sh
pnpm eval
```

The 13 fixtures in `evals/data` never call GitHub. If `typesafe-ai/jev` is not available on your gateway, set `JEV_MODEL` to another evaluation model and note that thresholds were chosen for Jev.

Check: evals report `passed` or `scored`. A `failed` eval prints the tool calls it expected.

## 3. Add Redis

In the Vercel dashboard, open the project, then Storage, then add Upstash for Redis from the Marketplace and connect it to all environments. It injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

```sh
vercel env pull
```

Redis holds the event queue, the decision log with raw Jev answers, the once-only markers for follow-ups, and the upstream issue pairs. Without it the agent falls back to memory, which is fine locally and useless on Vercel.

## 4. Set the secrets

```sh
openssl rand -hex 32 | vercel env add INTERNAL_API_SECRET production
openssl rand -hex 32 | vercel env add INTERNAL_API_SECRET preview
```

Keep the preview value at hand, you will use it with `curl` below. Everything else in [`.env.example`](../.env.example) is optional at this point.

## 5. Create the preview GitHub App

Two apps keep tests away from production. Start with the preview one.

```sh
vercel connect create github --name nuxi-preview
vercel connect attach github/nuxi-preview --environment preview --environment development
```

`create` opens the browser and creates the GitHub App for you through Connect. When it asks for permissions, the agent needs:

| Permission | Access |
| --- | --- |
| Issues | Read and write |
| Pull requests | Read and write |
| Contents | Read and write |
| Workflows | Read and write |
| Metadata | Read |

Issues write is what triage uses. The other three write permissions exist for one thing, the setup pull request of step 12: Contents to push the `nuxi/setup` branch, Pull requests to open it, Workflows to delete the workflow files nuxi replaces. nuxi never pushes to a default branch. Without Workflows the PR still opens, with the config only, and its body lists the files to delete by hand. With Contents and Pull requests left on read, skip the automatic PR and commit the file yourself.

No trigger is attached to this connector. Previews never react to webhooks, they are driven through the ops route.

Then open the app from the Connect dashboard and install it on your personal account, limited to the playground repository from the next step.

Check: `vercel connect list` shows `github/nuxi-preview` attached to the project.

## 6. Prepare the playground

Create an empty public repository, for example `<you>/nuxi-triage-playground`, and install the preview app on it. Then:

```sh
# The config, with dryRun: false and components read from nuxt/ui
mkdir -p /tmp/playground/.github
cp examples/playground.nuxi.yml /tmp/playground/.github/nuxi.yml
# edit `maintainers`, commit and push that file to the playground repository

pnpm labels <you>/nuxi-triage-playground
pnpm seed --from nuxt/ui --to <you>/nuxi-triage-playground --count 30
```

The scripts authenticate with `GITHUB_TOKEN`, or with `gh auth token` when it is not set. `seed` copies issues with their comments as quoted blocks, neutralizes every @-mention, and skips what it already copied when you run it again. Add `--dry-run` to either script to see what it would do.

Check: the playground has 30 issues and the `component: *` labels.

## 7. Dry-run the real backlog from your machine

Nothing is deployed yet and nothing is written. This runs the pipeline locally, without the sandbox step, against the public `nuxt/ui` issues.

```sh
pnpm backfill nuxt/ui --config examples/nuxt-ui.nuxi.yml --limit 20
```

Open `backfill.csv`. Each row has the proposed labels, mentions, facts, and the probabilities behind them. This is the file to read when tuning `thresholds`.

## 8. Deploy a preview

```sh
vercel deploy
```

Use a preview first, not `pnpm run deploy`, which goes to production. Note the URL, then trigger one issue. Without `"write": true` the run is forced to dry-run:

```sh
export NUXI_URL=https://<preview-url>
export INTERNAL_API_SECRET=<preview value>

curl -X POST $NUXI_URL/ops/triage/trigger \
  -H "authorization: Bearer $INTERNAL_API_SECRET" -H "content-type: application/json" \
  -d '{ "repo": "<you>/nuxi-triage-playground", "issueNumber": 1 }'
```

If the preview is behind Vercel Deployment Protection, add a bypass token header or disable protection for this project.

Read what it decided:

```sh
curl "$NUXI_URL/ops/decisions?repo=<you>/nuxi-triage-playground" -H "authorization: Bearer $INTERNAL_API_SECRET"
```

Check: one line per step (`classify`, `duplicate`, `apply`, and so on), the last one with `"dryRun": true` and the actions it would have taken. Session logs are under Observability, then Logs.

## 9. Set up Discord

Do this before allowing writes. With approvals on, which is the default, a run that wants to write and has no Discord approvals channel is forced to dry-run. eve's GitHub channel would otherwise post the approval prompt as a public comment.

### Create the bot

1. Go to <https://discord.com/developers/applications> and create an application named `nuxi`.
2. In Bot, reset and copy the token. No privileged intent is needed.
3. In Installation, keep Guild Install, add the `bot` and `applications.commands` scopes, and the Send Messages, Embed Links and Read Message History permissions. Open the install link and add the bot to your server. Enable User Install too if you want `/ask` in a DM with the app.

### Create the connector

The guided setup does everything in one go: creates the Connect client, attaches `/eve/v1/discord` as its trigger, registers the `/ask` command, and points the application's Interactions Endpoint URL at Connect.

```sh
pnpm eve add channel/discord
```

Paste the bot token when asked and keep `/ask` as the command. The project already has `agent/channels/discord.ts`. Do not pass `--overwrite`: the generated file would drop the maintainer check. If the setup names the connector something other than `discord/nuxi`, set `DISCORD_CONNECTOR` to its UID.

If you prefer to do it by hand, these are the same steps:

```sh
echo '{"botToken":"<token>"}' | vercel connect create discord --connector-type discord --data @- --name nuxi --triggers -F json
vercel connect attach discord/nuxi --environment production --triggers --trigger-path /eve/v1/discord

# Register /ask with a required `message` option
curl -X PUT "https://discord.com/api/v10/applications/<application id>/commands" \
  -H "Authorization: Bot <token>" -H "Content-Type: application/json" \
  -d '[{"name":"ask","description":"Ask nuxi about the backlog","type":1,"options":[{"name":"message","description":"What do you want to know?","type":3,"required":true}]}]'
```

Then, in the Developer Portal under General Information, set the Interactions Endpoint URL to `https://connect.vercel.com/trigger/<connector id>`, with the `id` printed by `vercel connect create`. Connect verifies Discord's signature and forwards the interaction to `/eve/v1/discord`. It is not the deployment URL.

Connect forwards triggers to the environment you attached, production here. To test Discord on a preview, attach again with `--environment preview --triggers --trigger-branch <branch> --trigger-path /eve/v1/discord`. A connector holds up to three trigger destinations.

### Channels and ids

Create two channels, for example `#nuxi-digest` and `#nuxi-approvals`, and make sure the bot can post in both. Turn on Developer Mode in Discord, then right click to copy ids.

```sh
vercel env add DISCORD_DIGEST_CHANNEL_ID production      # channel id
vercel env add DISCORD_APPROVALS_CHANNEL_ID production   # channel id
vercel env add DISCORD_MAINTAINER_IDS production         # your user id, comma separated for several
vercel env add NUXI_APPROVER_IDS production              # discord:<server id>:<user id>
```

`DISCORD_MAINTAINER_IDS` limits who can use `/ask`. `NUXI_APPROVER_IDS` limits who can press Approve. Leave it unset and anyone who sees the approvals channel can approve. A repository can override both channels under `discord` in its `.github/nuxi.yml`.

## 10. Create the production GitHub App

```sh
vercel connect create github --name nuxi
vercel connect attach github/nuxi --environment production --triggers --trigger-path /eve/v1/github
```

Same permissions as the preview app, plus these webhook events: Issues, Issue comment, Pull request. Connect receives and verifies the webhooks, then forwards them to `/eve/v1/github`. There is no webhook secret or private key to store.

Install it on your personal account with the playground repository. The app answers to `@nuxi` in comments. GitHub shows it as `nuxi[bot]` and may not autocomplete the mention.

## 11. Deploy to production

```sh
pnpm run deploy
```

Check, in the Vercel dashboard under Settings, then Cron Jobs: `dispatch_queue` every minute, `daily_sweep` at 03:00 UTC, `weekly_digest` on Monday at 07:00 and 08:00 UTC. Only the run that lands on 09:00 in Paris posts.

Then test the whole loop on the playground:

1. Open a new issue without a reproduction. Within about a minute a message appears in `#nuxi-approvals` with Approve and Cancel.
2. Approve. The issue gets `needs reproduction`, loses `triage`, and receives one comment.
3. Reply on the issue with a repository link. The bot picks up the comment, removes the label and runs the pipeline again.
4. Comment `@nuxi can you triage this again?` on another issue.
5. In Discord, `/ask message: what's waiting on me?`.
6. Post a digest now instead of waiting for Monday:

```sh
curl -X POST https://<production-url>/ops/digest/trigger \
  -H "authorization: Bearer <production secret>" -H "content-type: application/json" \
  -d '{ "repo": "<you>/nuxi-triage-playground", "write": true }'
```

## 12. Go to a real repository

1. See what nuxi would propose, without writing anything: `pnpm propose-setup <owner>/<repo>`. It prints the detected `.github/nuxi.yml` and the pull request body, including the workflows it would remove.
2. Install the production app on the organization, limited to that repository. No code change and no redeploy.
3. nuxi opens one pull request from the `nuxi/setup` branch. It contains the config with `dryRun: true`, and deletes the workflows nuxi replaces: `Hebilicious/reproduire`, and `actions/stale` jobs that only target `triage`, `needs reproduction` or `stale`. A stale workflow that covers pull requests or other labels is kept, and the body gives the `exempt-issue-labels` to add. The daily sweep opens it at 03:00 UTC. To get it now:

   ```sh
   curl -X POST https://<production-url>/ops/setup/trigger \
     -H "authorization: Bearer <production secret>" -H "content-type: application/json" \
     -d '{ "repo": "<owner>/<repo>", "write": true }'
   ```

   Without `"write": true` the route returns the proposal as JSON. On Discord, `/ask message: set up <owner>/<repo>` does the same behind an approval. A repository that already has the file, or a setup pull request in any state, is left alone, so closing the PR is a final no. The automatic path is off when the installation covers more than 10 repositories, or with `NUXI_AUTO_SETUP=false`.
4. Review the PR. Fix what the "To check" section lists, add `package.componentPrefix` and `nextMajor.package` if they apply, and compare with [`examples/nuxt-ui.nuxi.yml`](../examples/nuxt-ui.nuxi.yml). If you want to keep the old workflows while nuxi runs dry, drop the deletion commits from the branch and remove the files later. Merge. The repository is picked up within 5 minutes.
5. `pnpm labels <owner>/<repo> --dry-run`, then without the flag.
6. Let it run dry for a few days. Read `GET /ops/decisions?repo=<owner>/<repo>&since=<iso date>` or run `pnpm backfill <owner>/<repo> --url https://<production-url>` for a CSV that includes sandbox runs. Adjust `thresholds` in the repository's file.
7. Set `dryRun: false`. Writes still wait for your approval in Discord.
8. When you trust it, set `NUXI_REQUIRE_APPROVAL=false` and redeploy.

To have later edits of the file checked on pull requests, add this workflow to the repository:

```yaml
# .github/workflows/nuxi-config.yml
name: nuxi config
on:
  pull_request:
    paths: ['.github/nuxi.yml']
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: benjamincanac/nuxi/action/validate-config@main
```

To follow a public repository before the app is installed on it, set `NUXI_EXTRA_REPOS=<owner>/<repo>`. It still needs the config file in that repository, so this is mostly useful for forks and mirrors.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Nothing happens after opening an issue | No valid `.github/nuxi.yml` on the default branch. Run `pnpm validate-config`. Also check Cron Jobs: on Hobby the queue drains once a day. |
| Decisions show `"dryRun": true` though the file says `false` | Approvals are required and no approvals channel is set, or the run came from a preview without `"write": true`. The logs say which. |
| `blocked: "not a production deployment and not triggered explicitly"` | Expected on previews. Send `"write": true`. |
| `/ask` answers nothing | Your Discord user id is not in `DISCORD_MAINTAINER_IDS`, or the Interactions Endpoint URL points at the deployment instead of Connect. |
| Approve does nothing | Your principal id is not in `NUXI_APPROVER_IDS`. The format is `discord:<server id>:<user id>`. |
| 401 from Jev or Connect locally | `VERCEL_OIDC_TOKEN` expired. Run `vercel env pull`. |
| 403 on a GitHub write | The app lacks Issues write, or is not installed on that repository. |
| Sandbox outcome is always `failed` locally | Docker only supports allow-all or deny-all egress. Domain allow-lists need Vercel Sandbox, so test the sandbox on a deployment. |
| Wrong installation used once the app is on several accounts | Set `GITHUB_CONNECT_INSTALLATIONS` to map the owner to its Connect installation id. |

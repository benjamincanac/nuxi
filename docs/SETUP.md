# Deploy and set up nuxi

Everything is done from the terminal, inside a clone of this repository.

You need:

- Node 24 and pnpm.
- The [Vercel CLI](https://vercel.com/docs/cli), logged in: `pnpm add -g vercel`, then `vercel login`.
- The [GitHub CLI](https://cli.github.com), logged in: `gh auth login`. The local scripts use its token.
- A Vercel team on the Pro plan, with Vercel Sandbox available. One schedule runs every minute, which Hobby rejects at deploy time, and the build prewarms a sandbox.
- A GitHub account where you can create a GitHub App and a repository.
- A Discord account. A server is optional, a direct message with the app is enough.

## 1. Create the project

```sh
git clone https://github.com/benjamincanac/nuxi.git && cd nuxi
pnpm install

# Asks for a team and a project. Creates the project when it does not exist.
vercel link

# Writes .env.local with VERCEL_OIDC_TOKEN, which authenticates AI Gateway and Connect locally.
# Works before anything is deployed: the token is issued to the project.
# It expires after 12 hours. Pull again when local calls return 401.
vercel env pull

# Check
pnpm typecheck && pnpm build
```

## 2. Run the evals

```sh
# First real run of Jev and the models. The fixtures never call GitHub.
# `passed` and `scored` are both fine. `scored` means every gate passed and the judge
# disliked the wording of a summary, which varies between runs.
pnpm eval

# A single one
pnpm eval triage/duplicate
```

## 3. Add Redis and the secret

```sh
# Pick Redis when asked. It holds the event queue, the decision log and the once-only markers.
vercel integration add upstash -e production -e preview

# Protects the /ops routes. Print it as well: Vercel stores it as sensitive and never shows it again,
# and the curl calls below need it.
export INTERNAL_API_SECRET=$(openssl rand -hex 32) && echo $INTERNAL_API_SECRET
echo $INTERNAL_API_SECRET | vercel env add INTERNAL_API_SECRET production,preview

# Check: KV_REST_API_URL, KV_REST_API_TOKEN and INTERNAL_API_SECRET, for Preview and Production.
# None of them is a Development variable, so `vercel env pull` fetches nothing new.
# Local runs use an in-memory store on purpose.
vercel env ls
```

## 4. Create the playground

```sh
gh repo create nuxi-playground --public
gh repo clone <you>/nuxi-playground /tmp/nuxi-playground

# nuxi ignores a repository without .github/nuxi.yml.
# Change `maintainers` in the file if you are not benjamincanac.
mkdir -p /tmp/nuxi-playground/.github
cp examples/playground.nuxi.yml /tmp/nuxi-playground/.github/nuxi.yml
git -C /tmp/nuxi-playground add .github/nuxi.yml
git -C /tmp/nuxi-playground commit -m "chore: add nuxi config"
git -C /tmp/nuxi-playground push -u origin HEAD

# Copies issues with their comments and labels, neutralizes @-mentions, skips what is already there.
# There is no label to create for nuxi, it creates its labels when it first applies them.
pnpm seed --from nuxt/ui --to <you>/nuxi-playground --count 30
```

## 5. Create the preview GitHub app

Two GitHub apps keep tests away from production. Previews and local runs use this one, production uses the one from step 9.

```sh
# Opens the browser on the connector form, see below.
vercel connect create github --name nuxi-preview

# Which deployments may ask this connector for tokens.
vercel connect attach github/nuxi-preview -e preview -e development

# Check
vercel connect list
```

In the form, keep **Managed**, pick your account as the namespace, and leave **Triggers** empty since previews never react to webhooks. Under **Permissions**, select **Deselect all**, then set:

| Permission | Level | Used for |
| --- | --- | --- |
| `issues` | write | Labels, the Issue Type, comments |
| `pull_requests` | write | Reading linked pull requests, opening the setup pull request |
| `contents` | write | Reading `.github/nuxi.yml` and issue forms, pushing the `nuxi/setup` branch |
| `workflows` | write | Removing the workflows nuxi replaces, in the setup pull request |
| `metadata` | read | Required by GitHub |

Set **App Name** to the GitHub App slug you want, `nuxiai` here. It has to be free across GitHub users, organizations and apps, and it is what people mention and what comments are signed with, `@nuxiai` and `nuxiai[bot]`. Keep **Connector Name** as the UID the code looks up, `nuxi-preview` or `nuxi`. Then match `BOT_NAME` in [`agent/channels/github.ts`](../agent/channels/github.ts).

GitHub then asks where to install the app. Pick **Only select repositories** and the playground.

Only `issues` write is used by triage. The rest is for the setup pull request of step 11. If you plan to write `.github/nuxi.yml` by hand, `pull_requests` and `contents` on read are enough and `workflows` is not needed.

## 6. Dry-run a real backlog

```sh
# Runs the pipeline on your machine against public issues. Writes nothing.
# --config because nuxt/ui has no .github/nuxi.yml yet.
pnpm backfill nuxt/ui --config examples/nuxt-ui.nuxi.yml --limit 20

# One row per issue: proposed actions and the probabilities behind them.
# This is what you read to tune `thresholds`.
open backfill.csv
```

## 7. Test on a preview

```sh
# Deploys your working tree as a preview. No commit, production untouched.
vercel deploy
curl https://<preview-url>/eve/v1/health

export NUXI_URL=https://<preview-url>
export INTERNAL_API_SECRET=<value from step 3>

# Previews receive no webhook. They are driven through the /ops routes.
# A preview never writes by default. To let it write on the playground, add "write": true
# and set NUXI_REQUIRE_APPROVAL=false for Preview, since approvals only exist in production.
# Behind Deployment Protection, also send the x-vercel-protection-bypass header.
curl -X POST $NUXI_URL/ops/triage/trigger \
  -H "authorization: Bearer $INTERNAL_API_SECRET" -H "content-type: application/json" \
  -d '{ "repo": "<you>/nuxi-playground", "issueNumber": 1 }'

# Check: one JSON line per step, ending with `apply`, "dryRun": true and the intended actions.
curl "$NUXI_URL/ops/decisions?repo=<you>/nuxi-playground" -H "authorization: Bearer $INTERNAL_API_SECRET"
```

## 8. Set up Discord

Writes in production wait for an approval in Discord, with Approve and Cancel buttons. Without a channel to ask in, runs that want to write are forced to dry-run: eve's GitHub channel would otherwise post the approval prompt as a public comment on the issue.

A server is optional. A direct message with the app works for one maintainer and is the shortest path.

```sh
# Asks for the bot token, from an application created at
# https://discord.com/developers/applications. Creates the discord/nuxi connector,
# registers /ask, and points the Interactions Endpoint URL at Connect.
# Do not pass --overwrite: the existing agent/channels/discord.ts has the maintainer check.
pnpm eve add channel/discord

# The connector needs a token in every environment you run from, not just production.
vercel connect attach discord/nuxi -e production -e preview -e development
```

Then install the app. In **Installation**, keep **User Install**, add the `applications.commands` scope, open the install link and add it to your account. For a server, use **Guild Install** with `bot` and `applications.commands`, Send Messages and Embed Links, and create `#nuxi-digest` and `#nuxi-approvals`.

Turn on **Developer Mode** in Discord's advanced settings to copy ids. Send the app a direct message and copy the channel id of that conversation. Both channel variables can hold it.

```sh
vercel env add DISCORD_APPROVALS_CHANNEL_ID production
vercel env add DISCORD_DIGEST_CHANNEL_ID production

# Your Discord user id. Who can use /ask.
vercel env add DISCORD_MAINTAINER_IDS production

# Who can press Approve. `discord:<user id>` in a direct message,
# `discord:<server id>:<user id>` in a server. Unset, anyone who sees the prompt can.
vercel env add NUXI_APPROVER_IDS production

# Check
vercel connect list
```

## 9. Create the production GitHub app

```sh
# Same form and permissions as step 5. Install it on the playground too.
# Without --trigger-event a GitHub connector only forwards pull_request,
# and nuxi would never hear about a new issue.
vercel connect create github --name nuxi --triggers \
  --trigger-event issues --trigger-event issue_comment --trigger-event pull_request

# Connect verifies GitHub's signature and forwards the webhooks to this path.
# There is no webhook secret or private key to store.
vercel connect attach github/nuxi -e production --triggers --trigger-path /eve/v1/github

# Check
vercel connect list
```

## 10. Deploy to production

```sh
# Once the repository is connected to the Vercel project, pushing to main deploys.
git push

# Without that connection, or to deploy the working tree
pnpm run deploy
```

> [!IMPORTANT]
> The production deployment has to be created after steps 3, 8 and 9. A deployment keeps the variables it was built with, and a GitHub installation token is minted for the repositories selected at that moment. Redeploy after changing either.

Then, on the playground:

1. Open an issue without a reproduction. Within a minute or two the approvals channel shows the run, then an Approve prompt with what it would write.
2. Approve. The issue gets `needs reproduction`, loses `triage`, and receives one comment.
3. Reply with a repository link. nuxi removes the label and runs again.
4. Comment `@nuxiai can you triage this again?` on another issue.
5. In Discord, `/ask message: what's waiting on me?`.

```sh
# The digest, now instead of Monday 09:00 Paris.
curl -X POST https://<production-url>/ops/digest/trigger \
  -H "authorization: Bearer $INTERNAL_API_SECRET" -H "content-type: application/json" \
  -d '{ "repo": "<you>/nuxi-playground", "write": true }'
```

## 11. Go to a real repository

```sh
# Prints the config nuxi would propose and the workflows it would remove. Writes nothing.
pnpm propose-setup <owner>/<repo>

# Install the nuxi app on the repository. The daily sweep then opens the setup pull request
# at 03:00 UTC, unless the app is installed on more than 10 repositories or NUXI_AUTO_SETUP=false.
# To open it right away:
curl -X POST https://<production-url>/ops/setup/trigger \
  -H "authorization: Bearer $INTERNAL_API_SECRET" -H "content-type: application/json" \
  -d '{ "repo": "<owner>/<repo>", "write": true }'
```

1. Review the pull request and fix what its "To check" section lists. It starts with `dryRun: true`. Closing it is a final no, nuxi never opens it again.
2. Merge. The repository is picked up within 5 minutes.
3. Let it run dry for a few days, then adjust `thresholds` in the repository's file.
4. Set `dryRun: false`. Writes still wait for your approval in Discord.
5. When you trust it, set `NUXI_REQUIRE_APPROVAL=false` and redeploy.

```sh
# What it decided while dry
curl "https://<production-url>/ops/decisions?repo=<owner>/<repo>&since=<iso date>" \
  -H "authorization: Bearer $INTERNAL_API_SECRET"

# Or as a CSV, sandbox runs included
pnpm backfill <owner>/<repo> --url https://<production-url>
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Nothing happens after opening an issue | No valid `.github/nuxi.yml` on the default branch, check with `pnpm validate-config`. Or the connector was created without the `issues` event. |
| `"dryRun": true` though the file says `false` | No approvals channel is set, or the run came from a preview. |
| `/ask` answers nothing | Your id is not in `DISCORD_MAINTAINER_IDS`. |
| Approve does nothing | Your principal id is not in `NUXI_APPROVER_IDS`. |
| 401 locally | `VERCEL_OIDC_TOKEN` expired, run `vercel env pull`. |
| 403 on a GitHub write | The app lacks the permission. |
| 404 on a repository the deployment reads | The app is not installed on it, or the installation does not select it. Check <https://github.com/settings/installations>. |
| `A dev server is already running` | Delete `.eve/dev-server-state.v1.json`. |

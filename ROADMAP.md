# Roadmap

Nothing here is built. It is what running nuxi for a whole organization would take, written down while it was fresh. [`README.md`](README.md) and [`SETUP.md`](SETUP.md) describe what exists.

## Running nuxi for an organization

nuxi runs today as one person's deployment: the GitHub App, the Vercel project and the Discord app all belong to a single account, and every repository it triages bills that account. This is what changes when several maintainers use it on their own repositories. Nothing here is required for a single maintainer, and nothing in the agent code needs to know which organization it serves.

### What already works

| Need | How |
| --- | --- |
| A new repository | Install the app, merge `.github/nuxi.yml`. Nothing to deploy. |
| A new account | Add its login to `NUXI_ALLOWED_OWNERS`. Installations are learned from the first webhook. |
| Their own approvals and digest | `discord.approvalsChannel` and `discord.digestChannel` in their repository's config. |
| Who can approve | Whoever can see that channel. |
| Their own thresholds | `thresholds` in their repository's config. |

A maintainer who owns a repository under an allowed account can therefore adopt nuxi without asking anyone, which is the property to preserve.

### What has to change

#### 1. Ownership

Transfer the GitHub App to the organization, and the Vercel project with it. Today an install on a repository someone else owns needs an owner of that account to approve a request from a personal app, and every run bills a personal account. An organization owned app is installed by the people who already administer the repositories, and the bill lands where the usage does.

The connector holds the app's private key, so the transfer is a Connect operation, not a code change. `GITHUB_CONNECTOR` already points at a UID, so a new connector is a variable away.

Keep `NUXI_ALLOWED_OWNERS` set to the organization even then. A public app can be installed by anyone, and the allow-list is what keeps a stranger's installation from reaching the maintainers' Discord.

#### 2. Discord as a shared surface

The app is a user install on one account, so it can only post where that account can. For per-team channels it has to be a guild install in the organization's server, with Send Messages and Embed Links.

Then each repository points at its own channel and the rest follows: approvals go to the team that owns the repository, the weekly digest goes with them, and no one sees another team's backlog unless they are in the channel.

#### 3. `/ask` should not be an environment variable

`DISCORD_MAINTAINER_IDS` is a comma separated list that needs a redeploy to change, which does not scale past one person. Two options, in order of preference:

- Derive it from the repositories a person maintains. A `discord` id can sit next to a login in each repository's `maintainers`, which makes the config file the single place a team edits.
- Or accept anyone in the organization's server and scope the answer to the repositories they can see.

Either way the list stops being deployment state. The same reasoning applies as for installation ids: if the value can be read from a config file or a webhook, it does not belong in the environment.

#### 4. Visibility while a repository is dry running

`/ops/decisions` is behind a single shared secret, so today a maintainer cannot see what nuxi decided on their own repository without asking the person who holds it. Dry running is the whole point of the adoption path, so this is the gap that will be felt first.

The cheapest fix is `/ask`: the backlog conversation already runs per repository and already knows who is asking. "What did you decide on nuxt/ui this week" is the same query without a new endpoint, a new secret or a new UI.

#### 5. Cost, and who notices it

Two things cost real money per issue: the Jev calls in `classify_issue`, and the Vercel Sandbox in `run_sandbox_repro`. The sandbox is the expensive one, and it runs in dry-run too, twice per issue on a repository that configures `nextMajor.package`.

Before this is open to every repository in an organization, the sandbox needs a budget per repository and a way to turn it off, and the digest should report what the week cost. A team that adopts nuxi should be able to see its own bill.

### Rollout order

1. `nuxt/ui` runs dry until the decisions look right, then writes with approvals on.
2. A second repository adopts it with its own Discord channel, which is what proves the per-repository routing.
3. Transfer the app and the project to the organization.
4. Move the `/ask` list out of the environment, and answer "what did you decide" from `/ask`.
5. Add the sandbox budget, then say yes to anyone who asks.

Steps 1 and 2 need no code. Everything after them is the work.

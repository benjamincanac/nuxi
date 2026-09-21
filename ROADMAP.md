# Roadmap

Nothing here is built. It is what running tia for a whole organization would take, written down while it was fresh. [`README.md`](README.md) and [`SETUP.md`](SETUP.md) describe what exists.

## Running tia for an organization

tia runs today as one person's deployment: the GitHub App, the Vercel project and the Discord app all belong to a single account, and every repository it triages bills that account. This is what changes when several maintainers use it on their own repositories. Nothing here is required for a single maintainer, and nothing in the agent code needs to know which organization it serves.

### What already works

| Need | How |
| --- | --- |
| A new repository | Install the app, merge `.github/tia.yml`. Nothing to deploy. |
| A new account | Add its login to `TIA_ALLOWED_OWNERS`. Installations are learned from the first webhook. |
| Their own approvals and digest | `discord.approvalsChannel` and `discord.digestChannel` in their repository's config. |
| Who can approve | Whoever can see that channel. |
| Their own thresholds | `thresholds` in their repository's config. |

A maintainer who owns a repository under an allowed account can therefore adopt tia without asking anyone, which is the property to preserve.

### What has to change

#### 1. Ownership

Transfer the GitHub App to the organization, and the Vercel project with it. Today an install on a repository someone else owns needs an owner of that account to approve a request from a personal app, and every run bills a personal account. An organization owned app is installed by the people who already administer the repositories, and the bill lands where the usage does.

The connector holds the app's private key, so the transfer is a Connect operation, not a code change. `GITHUB_CONNECTOR` already overrides the connector tia uses, so a new one is a variable away.

Keep `TIA_ALLOWED_OWNERS` set to the organization even then. A public app can be installed by anyone, and the allow-list is what keeps a stranger's installation from reaching the maintainers' Discord.

#### 2. Discord as a shared surface

The app is a user install on one account, so it can only post where that account can. For per-team channels it has to be a guild install in the organization's server, with Send Messages and Embed Links.

Then each repository points at its own channel and the rest follows: approvals go to the team that owns the repository, the weekly digest goes with them, and no one sees another team's backlog unless they are in the channel.

#### 3. `/ask` should not be an environment variable

`DISCORD_MAINTAINER_IDS` is a comma separated list that needs a redeploy to change, which does not scale past one person. Two options, in order of preference:

- Derive it from the repositories a person maintains. A `discord` id can sit next to a login in each repository's `maintainers`, which makes the config file the single place a team edits.
- Or accept anyone in the organization's server and scope the answer to the repositories they can see.

Either way the list stops being deployment state. The same reasoning applies as for installation ids: if the value can be read from a config file or a webhook, it does not belong in the environment.

#### 4. Visibility while a repository is dry running

`/ops/decisions` is behind a single shared secret, so today a maintainer cannot see what tia decided on their own repository without asking the person who holds it. Dry running is the whole point of the adoption path, so this is the gap that will be felt first.

The cheapest fix is `/ask`: the backlog conversation already runs per repository and already knows who is asking. "What did you decide on nuxt/ui this week" is the same query without a new endpoint, a new secret or a new UI.

#### 5. Cost, and who notices it

What costs money per issue is the Jev calls, one per pipeline step, each carrying the issue and its comments again.

Before this is open to every repository in an organization, the digest should report what the week cost. A team that adopts tia should be able to see its own bill.

### Rollout order

1. `nuxt/ui` runs dry until the decisions look right, then writes with approvals on.
2. A second repository adopts it with its own Discord channel, which is what proves the per-repository routing.
3. Transfer the app and the project to the organization.
4. Move the `/ask` list out of the environment, and answer "what did you decide" from `/ask`.
5. Report the weekly cost per repository, then say yes to anyone who asks.

Steps 1 and 2 need no code. Everything after them is the work.

## Retiring the playground

The playground is a test bench, not a part of tia. It is the only repository where a run can go from the webhook to a Discord approval to a real write without touching a real backlog, and that is what makes an eve upgrade safe to check. eve still ships breaking minors every few days, so it stays for now.

Since the issue kinds are read from the issue forms, it runs in label mode on purpose: two forms of its own that mark a bug with `bug` and a request with `enhancement`, no Issue Type, and `source` turned off so those forms are the ones read. `nuxt/ui` covers the Issue Type path, so the playground is the only place that covers this one. Areas are empty there as a result, and the seeded issues no longer count as waiting for triage.

It can go once two things are true: eve upgrades stop breaking the agent, and `nuxt/ui` runs with `dryRun: false`, which puts the same chain under real traffic.

### What goes with it

| What | Where |
| --- | --- |
| The `pnpm seed` row | [`README.md`](README.md) |
| The seed script and its `seed` entry | [`scripts/seed-playground.ts`](scripts/seed-playground.ts), `package.json` |
| The playground config | [`examples/playground.tia.yml`](examples/playground.tia.yml) |
| Step 4, and the playground wording in steps 5, 7 and 9 | [`SETUP.md`](SETUP.md) |
| The production app's installation on the playground | GitHub |

Two config keys are worth a second look at that point. `source` reads areas, releases and the next major branch from another repository, and the playground was the only config that needed it, before it turned it off. If nothing else does, the key goes. `triageMaintainerIssues` was added for seeded issues, but a real repository may still want it, so it probably stays.

Areas get the same look. The live `nuxt/ui` config does not declare any, so no repository uses them today. Only the two files in [`examples/`](examples) do, where they add one Jev question per component to every issue for a single output, the "Top clusters" field of the weekly digest. If no repository asks for them, they go from the examples first and from the code after.

### What stays

The preview GitHub App. It is what keeps previews and local runs away from the production token, and that is enforced by GitHub rather than by a guard in the code. It needs one repository to be installed on, which can be any test repository and does not need to be documented.

An opt-out of the weekly digest, `discord.digestChannel: false`, was only ever wanted for the playground. It is not worth a schema change if the playground is going away.

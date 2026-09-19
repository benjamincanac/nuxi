# Migrating nuxt/ui to nuxi

nuxi takes over three workflows of `nuxt/ui`. Do this once the bot runs with `dryRun: false` on the repository, not before.

## 1. Add the config

Commit `.github/nuxi.yml`. Start from [`examples/nuxt-ui.nuxi.yml`](./examples/nuxt-ui.nuxi.yml) and keep `dryRun: true` for the first days. Validate it on pull requests with the action shipped in this repo:

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

## 2. Create the labels

```sh
pnpm labels nuxt/ui
```

Creates `answered`, `needs verification`, `has pr`, `a11y` and one `component: <kebab-name>` per component. `duplicate`, `question`, `triage`, `needs reproduction`, `stale`, `v5` and `upstream/*` already exist and are left untouched. `upstream/table` is created since only `reka-ui`, `tailwindcss`, `nuxt` and `tiptap` exist today.

## 3. Delete the workflows

| File | Why it goes |
| --- | --- |
| `.github/workflows/reproduire.yml` | nuxi posts the reproduction request when it applies `needs reproduction`. Keeping both posts two comments. |
| `.github/reproduire/needs-reproduction.md` | Only used by `reproduire.yml`. The request now comes from `reproduction` in `.github/nuxi.yml`. |
| `.github/workflows/reproduction.yml` | It closes `needs reproduction` issues after 7 days. nuxi follows up at 14 days and mentions a maintainer at 30. It never closes. |
| `.github/workflows/stale.yml` | It closes `triage` issues idle for 60 days. nuxi asks Jev whether the issue is still relevant, labels `stale` and mentions a maintainer with the reason. |

`closed-by-bot` stays in the label list for history. nuxi never applies it.

## 4. If `stale.yml` is kept

Closing idle issues automatically can stay if wanted. nuxi's labels must then be exempt, otherwise the action closes issues that wait on a maintainer decision:

```yaml
exempt-issue-labels: 'needs reproduction,question,duplicate,answered,needs verification,upstream/reka-ui,upstream/tailwindcss,upstream/nuxt,upstream/tiptap,upstream/table'
```

`actions/stale` has no wildcard support, so every `upstream/*` label is listed. Since nuxi removes `triage` when it takes a decision and the workflow only targets `any-of-labels: 'triage'`, most of these issues are already out of its reach. The list covers the ones a maintainer relabels by hand.

Also disable nuxi's own rule to avoid two `stale` comments: set `sweep.staleDays` to a value the workflow reaches first, for example `365`.

## 5. Install the app on the `nuxt` org

Same connector, no code change. See [Connect setup](./README.md#vercel-connect) in the README.

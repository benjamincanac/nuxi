# Evals

```sh
pnpm eval                  # everything
pnpm eval triage/duplicate # one eval
```

Evals call Jev and the model for real, so they need the `VERCEL_OIDC_TOKEN` from `vercel env pull`. They never call GitHub.

Each eval triages a fixture, a JSON file in `evals/data/<name>.json` addressed as `fixture/<name>#1`. A fixture carries its own config, issue, comments, and the candidates the tools would otherwise fetch: similar issues, upstream issues, merged pull requests and the reproduction check. Its shape is `fixtureSchema` in [`agent/lib/context.ts`](../agent/lib/context.ts). Fixtures always run in dry-run.

An eval asserts which tools ran and what they returned. Those are the gates. One judge assertion then grades wording, which varies between runs, so a `scored` result with every gate green is fine. It grades the comment `apply_triage` would post when the criterion is about what the reporter reads, and the final summary otherwise.

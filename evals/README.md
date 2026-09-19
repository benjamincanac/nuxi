# Evals

These evals drive the triage bot against offline fixtures instead of real GitHub issues. A fixture is a JSON file in `evals/data/<name>.json` validated against `fixtureSchema` in `agent/lib/context.ts`. It bundles a repo config, a component list, an issue with its comments, and precomputed candidates for duplicates, upstream matches, fixed-by PRs, and reproduction checks.

Each eval addresses its fixture as `fixture/<name>#1`, owner `"fixture"`, repo `"<name>"`, issue number `1`. `loadTriageContext` detects the `fixture` owner and loads the JSON file directly, skipping every GitHub read and forcing `dryRun: true`, so no eval ever writes anywhere.

Fixtures model a fictional Vue component library (`@acme/ui`) with components like `Button`, `Select`, and `Table`, so the agent's classification logic stays testable without depending on the real nuxi repository config.

Run everything:

```bash
pnpm eval
```

Run only the triage cases:

```bash
pnpm eval triage
```

Add `--strict` in CI to fail the build on soft threshold misses, not just hard gates.

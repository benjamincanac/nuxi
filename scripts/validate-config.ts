/**
 * Validates a repo's `.github/nuxi.yml` against the config schema.
 *
 *   pnpm validate-config [path]   (default .github/nuxi.yml)
 *
 * Exits 1 and prints a prettified zod error on failure. On success prints the resolved
 * config, defaults included.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { CONFIG_PATH, parseRepoConfig } from "../agent/config";

function printUsage(): void {
  console.log(
    "Usage: pnpm validate-config [path]\n\n" +
      "Validates a nuxi.yml config file against the schema. Defaults to .github/nuxi.yml.",
  );
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  printUsage();
  process.exit(0);
}

const path = positionals[0] ?? CONFIG_PATH;

let source: string;
try {
  source = await readFile(path, "utf8");
} catch (error) {
  console.error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const result = parseRepoConfig(source);
if (!result.ok) {
  console.error(`${path} is invalid:\n\n${result.error}`);
  process.exit(1);
}

console.log(`${path} is valid.\n`);
console.log(JSON.stringify(result.config, null, 2));

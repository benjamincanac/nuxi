import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const CONFIG_PATH = ".github/nuxi.yml";

export const DECISIONS = [
  "type",
  "question",
  "upstream",
  "reproduction",
  "sandbox",
  "fixed",
  "duplicate",
  "answered",
  "breaking",
  "a11y",
  "component",
  "pr",
] as const;

export type Decision = (typeof DECISIONS)[number];

export const DEFAULT_THRESHOLDS = {
  labels: 0.8,
  has_reproduction: 0.6,
  duplicate: 0.85,
  answered: 0.85,
  is_fixed: 0.8,
  needs_human: 0.5,
} as const;

const probability = z.number().min(0).max(1);

const thresholdsSchema = z
  .strictObject({
    labels: probability,
    has_reproduction: probability,
    duplicate: probability,
    answered: probability,
    is_fixed: probability,
    needs_human: probability,
  })
  .partial();

const repoSlug = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/repo");

export const repoConfigSchema = z.strictObject({
  dryRun: z.boolean().default(true),
  maintainers: z.array(z.string().min(1)).min(1),
  components: z.string().min(1).optional(),
  componentsSource: repoSlug.optional(),
  upstreams: z.array(repoSlug).default([]),
  /** npm package the repo publishes. Without it, version checks and sandbox runs are skipped. */
  package: z
    .strictObject({
      // Interpolated into a shell command in the sandbox, so the charset is closed.
      name: z.string().regex(/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/, "Expected an npm package name"),
      /** Prefix users write in templates, such as `U` for `UButton`. */
      componentPrefix: z.string().default(""),
    })
    .optional(),
  /** Next major version. Breaking changes get `label`, the sandbox also builds against `branch`. */
  nextMajor: z
    .strictObject({
      label: z.string().min(1),
      branch: z.string().min(1).optional(),
      /** Install spec for a build of `branch`. `{sha}` is replaced by the short commit sha. */
      package: z
        .string()
        .regex(/^[\w@:/.{}+-]+$/, "Expected an npm install spec without spaces or shell characters")
        .optional(),
    })
    .optional(),
  reproduction: z
    .strictObject({
      guide: z.url().optional(),
      templates: z.array(z.strictObject({ name: z.string(), url: z.url() })).default([]),
      /** Substrings of links that point at an unmodified starter, such as a template id or `owner/repo`. */
      blank: z.array(z.string().min(1)).default([]),
    })
    .default({ templates: [], blank: [] }),
  securityPolicy: z.url().optional(),
  /** Where general questions that are not triage requests get pointed to. */
  help: z.url().optional(),
  decisions: z.array(z.enum(DECISIONS)).default([...DECISIONS]),
  thresholds: thresholdsSchema.default({}),
  sweep: z
    .strictObject({
      followUpDays: z.number().int().positive().default(14),
      mentionDays: z.number().int().positive().default(30),
      staleDays: z.number().int().positive().default(60),
    })
    .default({ followUpDays: 14, mentionDays: 30, staleDays: 60 }),
  discord: z
    .strictObject({
      digestChannel: z.string().default(""),
      approvalsChannel: z.string().default(""),
    })
    .default({ digestChannel: "", approvalsChannel: "" }),
});

export type RepoConfigInput = z.input<typeof repoConfigSchema>;
export type RepoConfigFile = z.output<typeof repoConfigSchema>;
export type Thresholds = { [K in keyof typeof DEFAULT_THRESHOLDS]: number };

export interface RepoConfig extends Omit<RepoConfigFile, "thresholds" | "discord"> {
  owner: string;
  repo: string;
  thresholds: Thresholds;
  discord: { digestChannel: string; approvalsChannel: string };
}

export type ParsedConfig =
  | { ok: true; config: RepoConfigFile }
  | { ok: false; error: string };

/** Parses and validates the raw YAML of a `.github/nuxi.yml` file. */
export function parseRepoConfig(source: string): ParsedConfig {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const result = repoConfigSchema.safeParse(raw);
  if (!result.success) return { ok: false, error: z.prettifyError(result.error) };
  return { ok: true, config: result.data };
}

export function resolveRepoConfig(owner: string, repo: string, file: RepoConfigFile): RepoConfig {
  return {
    ...file,
    owner,
    repo,
    thresholds: { ...DEFAULT_THRESHOLDS, ...file.thresholds },
    discord: {
      digestChannel: file.discord.digestChannel || process.env.DISCORD_DIGEST_CHANNEL_ID || "",
      approvalsChannel:
        file.discord.approvalsChannel || process.env.DISCORD_APPROVALS_CHANNEL_ID || "",
    },
  };
}

export function isEnabled(config: RepoConfig, decision: Decision): boolean {
  return config.decisions.includes(decision);
}

export function upstreamLabel(upstream: string): string {
  return `upstream/${upstream.split("/")[1] ?? upstream}`;
}

export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

export function componentLabel(name: string): string {
  return `component: ${kebabCase(name)}`;
}

/** Connector used for every GitHub call. Previews and local dev never share the production app. */
export function githubConnector(): string {
  if (process.env.GITHUB_CONNECTOR) return process.env.GITHUB_CONNECTOR;
  return process.env.VERCEL_ENV === "production" ? "github/nuxi" : "github/nuxi-preview";
}

export function discordConnector(): string {
  return process.env.DISCORD_CONNECTOR ?? "discord/nuxi";
}

export function isProduction(): boolean {
  return process.env.VERCEL_ENV === "production";
}

/** Write tools pause for a maintainer unless `NUXI_REQUIRE_APPROVAL=false`. */
export function requireApproval(): boolean {
  return process.env.NUXI_REQUIRE_APPROVAL !== "false";
}

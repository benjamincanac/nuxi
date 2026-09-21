import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { sourceRepo, type RepoConfig } from "../config";
import { gh, ghText } from "./github";

/**
 * What a repository already says about reproductions in its issue forms: where to start from,
 * which guide to read, which field holds the link, which field holds the version.
 * Read from `.github/ISSUE_TEMPLATE/*.yml` so none of it has to be repeated in `.github/nuxi.yml`.
 */
export interface ReproductionSettings {
  guide: string | null;
  templates: { name: string; url: string }[];
  /** Link fragments that point at an unmodified starter. */
  blank: string[];
  /** Hosts the repo accepts reproductions on, besides StackBlitz, CodeSandbox and GitHub. */
  hosts: string[];
  /** Heading of the form field that holds the reproduction, as rendered in the issue body. */
  reproductionHeading: string | null;
  versionHeading: string | null;
}

export const EMPTY_REPRODUCTION: ReproductionSettings = {
  guide: null,
  templates: [],
  blank: [],
  hosts: [],
  reproductionHeading: null,
  versionHeading: null,
};

const formSchema = z.object({
  body: z
    .array(
      z.object({
        type: z.string(),
        id: z.string().optional(),
        attributes: z.object({ label: z.string().optional(), description: z.string().optional() }).optional(),
      }),
    )
    .default([]),
});

const SANDBOX_HOSTS = ["codesandbox.io", "stackblitz.com"];
const GENERIC_HOSTS = ["github.com", ...SANDBOX_HOSTS];

interface FoundLink {
  name: string;
  url: string;
}

export function extractLinks(text: string): FoundLink[] {
  const links: FoundLink[] = [];
  const markdown = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  for (const match of text.matchAll(markdown)) {
    // A link that does not parse is dropped here, so every caller below can read its host and path.
    if (URL.canParse(match[2] ?? "")) links.push({ name: (match[1] ?? "").trim(), url: match[2] ?? "" });
  }
  // Bare URLs, labeled by the words right before them: "the Vue template https://…" gives "Vue".
  const bare = /(?:\b(?:the|a|our)\s+)?((?:[A-Z][\w.]*\s+){0,2})(?:template|starter|playground)?\s*(?<![(\]])(https?:\/\/[^\s)>\]"'`,]+)/g;
  for (const match of text.replace(markdown, " ").matchAll(bare)) {
    const url = (match[2] ?? "").replace(/[.;]+$/, "");
    const host = URL.parse(url)?.hostname;
    if (host) links.push({ name: (match[1] ?? "").trim() || host, url });
  }
  return links.filter((link, index) => links.findIndex((other) => other.url === link.url) === index);
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

function isStarter(link: FoundLink): boolean {
  const host = hostOf(link.url);
  return SANDBOX_HOSTS.some((sandbox) => host.endsWith(sandbox)) || /play(ground)?\b/i.test(`${link.name} ${host}`);
}

/** Settings found in one issue form, or `null` when it has no reproduction field. */
export function reproductionFromForm(source: string): ReproductionSettings | null {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch {
    return null;
  }
  const form = formSchema.safeParse(raw);
  if (!form.success) return null;

  const fields = form.data.body.filter((field) => field.type !== "markdown");
  const matches = (pattern: RegExp) => fields.find((field) => pattern.test(`${field.id ?? ""} ${field.attributes?.label ?? ""}`));
  const reproduction = matches(/reproduc/i);
  if (!reproduction) return null;
  const version = fields.find((field) => field.type === "input" && /version/i.test(`${field.id ?? ""} ${field.attributes?.label ?? ""}`));

  const links = extractLinks(reproduction.attributes?.description ?? "");
  const starters = links.filter(isStarter);
  const guide = links.find((link) => !isStarter(link) && /reproduc/i.test(`${link.name} ${link.url}`));

  return {
    guide: guide?.url ?? null,
    templates: starters.slice(0, 4),
    // A sandbox starter is identified by its last path segment. A playground by its bare URL.
    blank: starters.map((link) => new URL(link.url).pathname.split("/").filter(Boolean).pop() ?? link.url.replace(/\/+$/, "")),
    hosts: [...new Set(starters.map((link) => hostOf(link.url)).filter((host) => !GENERIC_HOSTS.some((generic) => host.endsWith(generic))))],
    reproductionHeading: reproduction.attributes?.label ?? null,
    versionHeading: version?.attributes?.label ?? null,
  };
}

const formLabelsSchema = z.object({ labels: z.union([z.array(z.string()), z.string()]).default([]) });

/**
 * Labels that every issue form applies, so every new issue carries them. That is how a repository
 * marks an issue as waiting for triage, and it is the label a decision removes. A repository
 * without forms, or whose forms share no label, has none.
 */
export function intakeLabelsFromForms(sources: readonly string[]): string[] {
  const perForm: string[][] = [];
  for (const source of sources) {
    let raw: unknown;
    try {
      raw = parseYaml(source);
    } catch {
      continue;
    }
    const form = formLabelsSchema.safeParse(raw);
    if (!form.success) continue;
    const labels = typeof form.data.labels === "string" ? form.data.labels.split(",") : form.data.labels;
    perForm.push(labels.map((label) => label.trim()).filter(Boolean));
  }
  const [first = [], ...rest] = perForm;
  return first.filter((label) => rest.every((labels) => labels.includes(label)));
}

interface IssueForms {
  reproduction: ReproductionSettings;
  intakeLabels: string[];
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { expires: number; value: IssueForms }>();
const directorySchema = z.array(z.object({ name: z.string(), path: z.string(), type: z.string() }));

async function loadIssueForms(config: RepoConfig, signal?: AbortSignal): Promise<IssueForms> {
  const source = sourceRepo(config);
  const key = `${source.owner}/${source.repo}`.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expires >= Date.now()) return cached.value;

  const base = `/repos/${source.owner}/${source.repo}/contents`;
  const entries = await gh(directorySchema, `${base}/.github/ISSUE_TEMPLATE`, { owner: source.owner, signal }).catch(() => []);
  const forms = entries.filter((candidate) => candidate.type === "file" && /\.ya?ml$/.test(candidate.name) && candidate.name !== "config.yml");
  const sources = await Promise.all(forms.map(async (entry) => (await ghText(`${base}/${entry.path}`, { owner: source.owner, signal })) ?? ""));

  let reproduction = EMPTY_REPRODUCTION;
  for (const text of sources) {
    const form = reproductionFromForm(text);
    if (form) {
      reproduction = form;
      break;
    }
  }
  const value = { reproduction, intakeLabels: intakeLabelsFromForms(sources) };
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}

/** See `intakeLabelsFromForms`. */
export async function loadIntakeLabels(config: RepoConfig, signal?: AbortSignal): Promise<string[]> {
  return (await loadIssueForms(config, signal)).intakeLabels;
}

/** Issue form settings, with the repo's `reproduction` config on top when it sets something. */
export async function loadReproductionSettings(config: RepoConfig, signal?: AbortSignal): Promise<ReproductionSettings> {
  const detected = (await loadIssueForms(config, signal)).reproduction;
  const override = config.reproduction;
  return {
    ...detected,
    guide: override.guide ?? detected.guide,
    templates: override.templates.length ? override.templates : detected.templates,
    blank: [...new Set([...detected.blank, ...override.blank])],
  };
}

/** Settings from the config alone. Used by fixtures, which have no repository to read forms from. */
export function reproductionFromConfig(config: RepoConfig): ReproductionSettings {
  const { guide, templates, blank } = config.reproduction;
  return { ...EMPTY_REPRODUCTION, guide: guide ?? null, templates, blank };
}

/** Splits an issue form body into its `### Heading` sections. */
export function bodySections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = body.split(/^###\s+(.+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const value = (parts[i + 1] ?? "").trim();
    if (value && value !== "_No response_") sections.set((parts[i] ?? "").trim().toLowerCase(), value);
  }
  return sections;
}

export function sectionOf(body: string, heading: string | null): string | null {
  return heading ? (bodySections(body).get(heading.toLowerCase()) ?? null) : null;
}

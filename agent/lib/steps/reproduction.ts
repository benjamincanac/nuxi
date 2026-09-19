import { z } from "zod";

import type { RepoConfig } from "../../config";
import type { ReproductionCheck, TriageContext } from "../context";
import { ghText } from "../github";
import type { PlanPatch } from "../plan";
import { markOnce } from "../store";

const LINK_PATTERN =
  /https?:\/\/(?:www\.)?(stackblitz\.com|codesandbox\.io|github\.com)\/[^\s)>\]"'`]+/gi;

export interface ReproductionLink {
  url: string;
  kind: ReproductionCheck["kind"];
  repository: ReproductionCheck["repository"];
}

function parseRepository(segments: string[]): ReproductionCheck["repository"] {
  const [owner, repo, tree, ...ref] = segments;
  if (!owner || !repo) return null;
  return { owner, repo: repo.replace(/\.git$/, ""), ref: tree === "tree" && ref.length ? ref.join("/") : null };
}

/** Repositories that show up as context in a report: the repo itself and its upstreams. */
function contextRepositories(config: RepoConfig): Set<string> {
  return new Set([`${config.owner}/${config.repo}`, ...config.upstreams].map((slug) => slug.toLowerCase()));
}

export function extractReproductionLinks(text: string, config: RepoConfig): ReproductionLink[] {
  const ignored = contextRepositories(config);
  const links: ReproductionLink[] = [];
  for (const match of text.matchAll(LINK_PATTERN)) {
    const url = new URL(match[0].replace(/[.,;]+$/, ""));
    const segments = url.pathname.split("/").filter(Boolean);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "stackblitz.com") {
      const repository = segments[0] === "github" ? parseRepository(segments.slice(1)) : null;
      links.push({ url: url.href, kind: "stackblitz", repository });
    } else if (host === "codesandbox.io") {
      links.push({ url: url.href, kind: "codesandbox", repository: null });
    } else {
      const repository = parseRepository(segments);
      const reserved = ["issues", "pull", "blob", "commit", "discussions", "releases"];
      // Links to issues or to files are context, not reproductions.
      if (!repository || (segments[2] && reserved.includes(segments[2]))) continue;
      if (ignored.has(`${repository.owner}/${repository.repo}`.toLowerCase())) continue;
      links.push({ url: url.href, kind: "github", repository });
    }
  }
  return links.filter((link, index) => links.findIndex((other) => other.url === link.url) === index);
}

const packageJsonSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

async function resolves(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET", redirect: "follow", signal });
    return response.ok;
  } catch {
    return false;
  }
}

export async function inspectLink(link: ReproductionLink, config: RepoConfig, signal?: AbortSignal): Promise<ReproductionCheck> {
  const blank = config.reproduction.blank.map((entry) => entry.toLowerCase());
  const base: ReproductionCheck = {
    url: link.url,
    kind: link.kind,
    resolves: false,
    usesPackage: null,
    blankTemplate: blank.some((entry) => link.url.toLowerCase().includes(entry)),
    version: null,
    repository: link.repository,
  };

  if (!link.repository) {
    // StackBlitz projects and CodeSandbox devboxes expose no stable API to read their package.json.
    return { ...base, resolves: await resolves(link.url, signal) };
  }

  const { owner, repo, ref } = link.repository;
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const source = await ghText(`/repos/${owner}/${repo}/contents/package.json${query}`, { signal }).catch(() => null);
  if (source === null) return { ...base, resolves: await resolves(link.url, signal) };
  if (!config.package) return { ...base, resolves: true };

  const parsed = packageJsonSchema.safeParse(JSON.parse(source));
  const dependencies = parsed.success ? { ...parsed.data.devDependencies, ...parsed.data.dependencies } : {};
  const range = dependencies[config.package.name] ?? null;
  return {
    ...base,
    resolves: true,
    usesPackage: range !== null,
    version: range?.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0] ?? null,
  };
}

const latestSchema = z.object({ version: z.string() });

export async function latestPackageVersion(name: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, { signal });
  if (!response.ok) throw new Error(`npm registry ${response.status}`);
  return latestSchema.parse(await response.json()).version;
}

export function isBehind(version: string, latest: string): boolean {
  const parse = (value: string) => value.split("-")[0]?.split(".").map(Number) ?? [];
  const [a, b] = [parse(version), parse(latest)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

export interface ReproductionOutcome {
  checks: ReproductionCheck[];
  valid: ReproductionCheck | null;
  latestVersion: string | null;
  patch: PlanPatch;
}

export async function validateReproduction(context: TriageContext, signal?: AbortSignal): Promise<ReproductionOutcome> {
  const { config, issue, fixture } = context;
  const text = [issue.body, ...issue.comments.filter((c) => c.author === issue.author).map((c) => c.body)].join("\n");

  const latestVersion = fixture?.latestVersion ?? (config.package ? await latestPackageVersion(config.package.name, signal) : null);
  const checks = fixture
    ? fixture.reproduction
      ? [fixture.reproduction]
      : []
    : await Promise.all(extractReproductionLinks(text, config).slice(0, 3).map((link) => inspectLink(link, config, signal)));

  const usable = checks.filter((check) => check.resolves && !check.blankTemplate && check.usesPackage !== false);
  const valid = usable[0] ?? null;
  const patch: PlanPatch = {};

  if (checks.length > 0 && !valid) {
    const reasons = checks.map((check) =>
      !check.resolves
        ? `${check.url} does not resolve`
        : check.blankTemplate
          ? `${check.url} is the unmodified template`
          : `${check.url} does not depend on ${config.package?.name ?? "the package"}`,
    );
    patch.addLabels = issue.labels.includes("needs reproduction") ? [] : ["needs reproduction"];
    patch.removeLabels = ["triage"];
    patch.facts = [`The reproduction is not usable: ${reasons.join("; ")}.`, "REPRODUCTION_REQUEST"];
  } else if (valid?.version && latestVersion && isBehind(valid.version, latestVersion)) {
    // Asked once. The sweep would otherwise repeat it on every run.
    const first = fixture || config.dryRun ? true : await markOnce(issue, "retest-on-latest");
    if (first) {
      patch.facts = [
        `The reproduction uses ${config.package?.name} ${valid.version}, the latest is ${latestVersion}. Ask the reporter to retest on the latest version first.`,
      ];
    }
  }

  return { checks, valid, latestVersion, patch };
}

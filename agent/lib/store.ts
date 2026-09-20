import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { Redis } from "@upstash/redis";

import type { IssueRef } from "./github";
import type { TriagePlan } from "./plan";

/** One line per evaluated decision. Raw Jev answers are kept untouched for threshold tuning. */
export interface DecisionRecord {
  at: string;
  repo: string;
  issueNumber: number;
  step: string;
  answers: unknown;
  actions: unknown;
  dryRun: boolean;
  runId?: string;
}

export interface UpstreamPair {
  repo: string;
  issueNumber: number;
  upstreamRepo: string;
  upstreamIssueNumber: number;
  upstreamUrl: string;
  notifiedClosed: boolean;
}

export type QueueReason =
  | "issue"
  | "mention"
  | "comment"
  | "pull_request"
  | "sweep"
  | "release"
  | "upstream_closed"
  | "manual";

/** `issueNumber` is the pull request number when `reason` is `pull_request`. */
export interface QueueItem extends IssueRef {
  reason: QueueReason;
  notBefore: number;
  commentId?: number;
  /** Text of the @-mention, or evidence for `upstream_closed`. */
  text?: string;
  /** Explicit trigger from the ops route: allowed to write from a preview deployment. */
  explicit?: boolean;
  /** Backfills: the run must not write, whatever the repo config says. */
  dryRun?: boolean;
  /** Failed dispatches so far. The item is dropped after `MAX_DISPATCH_ATTEMPTS`. */
  attempts?: number;
}

interface KeyValue {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  rpush(key: string, value: unknown): Promise<void>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  lrange<T>(key: string, start: number, stop: number): Promise<T[]>;
  lpop<T>(key: string): Promise<T | null>;
  hset(key: string, field: string, value: unknown): Promise<void>;
  hgetall<T>(key: string): Promise<Record<string, T>>;
  hdel(key: string, field: string): Promise<void>;
}

function redisStore(redis: Redis): KeyValue {
  return {
    get: (key) => redis.get(key),
    async set(key, value, ttlSeconds) {
      if (ttlSeconds) await redis.set(key, value, { ex: ttlSeconds });
      else await redis.set(key, value);
    },
    async del(key) {
      await redis.del(key);
    },
    async rpush(key, value) {
      await redis.rpush(key, value);
    },
    async ltrim(key, start, stop) {
      await redis.ltrim(key, start, stop);
    },
    lrange: (key, start, stop) => redis.lrange(key, start, stop),
    lpop: (key) => redis.lpop(key),
    async hset(key, field, value) {
      await redis.hset(key, { [field]: value });
    },
    async hgetall<T>(key: string) {
      return (await redis.hgetall<Record<string, T>>(key)) ?? {};
    },
    async hdel(key, field) {
      await redis.hdel(key, field);
    },
  };
}

/** Local development and scripts. Nothing survives the process except the JSONL export. */
function memoryStore(): KeyValue {
  const values = new Map<string, { value: unknown; expires: number }>();
  const lists = new Map<string, unknown[]>();
  const hashes = new Map<string, Map<string, unknown>>();
  return {
    async get<T>(key: string) {
      const entry = values.get(key);
      if (!entry || entry.expires < Date.now()) return null;
      return entry.value as T;
    },
    async set(key, value, ttlSeconds) {
      values.set(key, { value, expires: ttlSeconds ? Date.now() + ttlSeconds * 1_000 : Infinity });
    },
    async ltrim(key, start) {
      lists.set(key, (lists.get(key) ?? []).slice(start));
    },
    async del(key) {
      values.delete(key);
      lists.delete(key);
      hashes.delete(key);
    },
    async rpush(key, value) {
      lists.set(key, [...(lists.get(key) ?? []), value]);
    },
    async lrange<T>(key: string, start: number, stop: number) {
      const list = lists.get(key) ?? [];
      return list.slice(start, stop === -1 ? undefined : stop + 1) as T[];
    },
    async lpop<T>(key: string) {
      return ((lists.get(key) ?? []).shift() as T | undefined) ?? null;
    },
    async hset(key, field, value) {
      const hash = hashes.get(key) ?? new Map<string, unknown>();
      hash.set(field, value);
      hashes.set(key, hash);
    },
    async hgetall<T>(key: string) {
      return Object.fromEntries(hashes.get(key) ?? []) as Record<string, T>;
    },
    async hdel(key, field) {
      hashes.get(key)?.delete(field);
    },
  };
}

function hasRedis(): boolean {
  return Boolean(
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
      (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  );
}

let instance: KeyValue | undefined;

function kv(): KeyValue {
  instance ??= hasRedis() ? redisStore(Redis.fromEnv()) : memoryStore();
  return instance;
}

const DECISIONS_KEY = "nuxi:decisions";
const UPSTREAM_KEY = "nuxi:upstream";
const INSTALLATIONS_KEY = "nuxi:installations";
const QUEUE_KEY = "nuxi:queue";
const MAX_DECISIONS = 5_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
// Per issue markers outlive any run, not the issue: a year after the last write they are dead weight.
const YEAR_SECONDS = 365 * 24 * 60 * 60;

function issueKey(ref: IssueRef): string {
  return `${ref.owner}/${ref.repo}#${ref.issueNumber}`.toLowerCase();
}

export async function recordDecision(record: DecisionRecord): Promise<void> {
  await kv().rpush(DECISIONS_KEY, record);
  await kv().ltrim(DECISIONS_KEY, -MAX_DECISIONS, -1);
  const path = process.env.NUXI_DECISIONS_JSONL;
  if (path) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`);
  }
}

export function listDecisions(): Promise<DecisionRecord[]> {
  return kv().lrange<DecisionRecord>(DECISIONS_KEY, 0, -1);
}

/**
 * The plan is keyed by issue, not by turn. An approval resumes the original tool call in a new turn,
 * so a turn scoped plan is gone by the time `apply_triage` runs and the write would be empty.
 * `dispatch` clears the key before each run, which is what keeps one plan per run.
 */
export function getPlan(ref: IssueRef): Promise<TriagePlan | null> {
  return kv().get<TriagePlan>(`nuxi:plan:${issueKey(ref)}`);
}

export async function savePlan(runId: string, plan: TriagePlan): Promise<void> {
  await kv().set(`nuxi:plan:${issueKey(plan.issue)}`, plan, WEEK_SECONDS);
  await kv().set(`nuxi:run:${runId}`, true, WEEK_SECONDS);
}

export async function clearPlan(ref: IssueRef): Promise<void> {
  await kv().del(`nuxi:plan:${issueKey(ref)}`);
}

/** Whether this run is a triage run, meaning a tool has already recorded a plan for it. */
export async function isTriageRun(runId: string): Promise<boolean> {
  return (await kv().get<boolean>(`nuxi:run:${runId}`)) === true;
}

/**
 * Which GitHub App installation covers an account. Every webhook carries it, so installing the app
 * on a new account is enough: there is nothing to configure and nothing to redeploy.
 */
export function rememberInstallation(owner: string, installationId: number | string): Promise<void> {
  return kv().hset(INSTALLATIONS_KEY, owner.toLowerCase(), String(installationId));
}

export async function listInstallations(): Promise<Record<string, string>> {
  // Redis parses a stored id back as a number, and Connect only accepts a string.
  const stored = await kv().hgetall<string | number>(INSTALLATIONS_KEY);
  return Object.fromEntries(Object.entries(stored).map(([owner, id]) => [owner, String(id)]));
}

export function trackUpstreamPair(pair: UpstreamPair): Promise<void> {
  return kv().hset(UPSTREAM_KEY, `${pair.repo}#${pair.issueNumber}`.toLowerCase(), pair);
}

export async function listUpstreamPairs(): Promise<UpstreamPair[]> {
  return Object.values(await kv().hgetall<UpstreamPair>(UPSTREAM_KEY));
}

/** Follow-ups and mentions are sent once. The marker is the memory of having sent them. */
export async function markOnce(ref: IssueRef, marker: string): Promise<boolean> {
  const key = `nuxi:once:${issueKey(ref)}:${marker}`;
  if (await kv().get<number>(key)) return false;
  await kv().set(key, Date.now(), YEAR_SECONDS);
  return true;
}

/** Set by the ops trigger so an explicit run on a preview deployment may write for one hour. */
export function allowPreviewWrite(ref: IssueRef): Promise<void> {
  return kv().set(`nuxi:explicit:${issueKey(ref)}`, Date.now(), 60 * 60);
}

export async function isPreviewWriteAllowed(ref: IssueRef): Promise<boolean> {
  return (await kv().get<number>(`nuxi:explicit:${issueKey(ref)}`)) !== null;
}

/** Fingerprint of the last comment posted on an issue, so a re-evaluation never repeats itself. */
export function getLastAnnounced(ref: IssueRef): Promise<string | null> {
  return kv().get<string>(`nuxi:announced:${issueKey(ref)}`);
}

export function setLastAnnounced(ref: IssueRef, fingerprint: string): Promise<void> {
  return kv().set(`nuxi:announced:${issueKey(ref)}`, fingerprint, YEAR_SECONDS);
}

/** Backfills run the real pipeline on a repo that may have `dryRun: false`. They must not write. */
// Set when the run is dispatched and keyed by issue, since the run id is not known yet. The window is
// kept short: a real event on the same issue within it also runs dry, and the daily sweep catches up.
export function forceDryRun(ref: IssueRef): Promise<void> {
  return kv().set(`nuxi:dry:${issueKey(ref)}`, Date.now(), 20 * 60);
}

export async function isDryRunForced(ref: IssueRef): Promise<boolean> {
  return (await kv().get<number>(`nuxi:dry:${issueKey(ref)}`)) !== null;
}

/** Skips the daily re-evaluation when neither the issue nor the latest release changed. */
export async function alreadyEvaluated(ref: IssueRef, fingerprint: string): Promise<boolean> {
  const key = `nuxi:evaluated:${issueKey(ref)}`;
  if ((await kv().get<string>(key)) === fingerprint) return true;
  await kv().set(key, fingerprint, YEAR_SECONDS);
  return false;
}

export function enqueue(item: QueueItem): Promise<void> {
  return kv().rpush(QUEUE_KEY, item);
}

export async function drainQueue(limit: number): Promise<QueueItem[]> {
  const due: QueueItem[] = [];
  const later: QueueItem[] = [];
  for (let i = 0; i < limit * 4 && due.length < limit; i++) {
    const item = await kv().lpop<QueueItem>(QUEUE_KEY);
    if (!item) break;
    if (item.notBefore <= Date.now()) due.push(item);
    else later.push(item);
  }
  for (const item of later) await kv().rpush(QUEUE_KEY, item);
  return due;
}

// Prefixed: Upstash parses stored values as JSON, and a tag such as `2024` would come back as a number.
export async function getLastSeenRelease(repo: string): Promise<string | null> {
  const stored = await kv().get<string>(`nuxi:release:${repo.toLowerCase()}`);
  return typeof stored === "string" ? stored.replace(/^tag:/, "") : null;
}

export function setLastSeenRelease(repo: string, tag: string): Promise<void> {
  return kv().set(`nuxi:release:${repo.toLowerCase()}`, `tag:${tag}`);
}

export function saveBackfillRow(runId: string, row: unknown): Promise<void> {
  return kv().rpush(`nuxi:backfill:${runId}`, row);
}

export function listBackfillRows<T>(runId: string): Promise<T[]> {
  return kv().lrange<T>(`nuxi:backfill:${runId}`, 0, -1);
}

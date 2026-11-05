/**
 * GET /api/pane/btw: the side conversations an OMP pane's session saved with `/btw`, for the
 * composer's side conversations chip. OMP keeps them out of its transcript, one file per topic in
 * the session's artifacts folder (the session file's path without `.jsonl`): `btw-history/entry-<id>.json`,
 * with an optional `entry-<id>.title` beside it (OMP 18.14, packages/coding-agent/src/session/btw-history.ts).
 * Only the main session's topics are read: `btw-history/sessions/` holds a focused subagent's, which
 * are another conversation. A record is taken only as OMP itself would load it (a regular file, its
 * exact fields, its id matching its name); anything else is skipped, and so is a history reached
 * through a linked folder. A question may carry pictures, so a read is bounded: the hundred most
 * recently written topics, a byte budget, and a record kept until its file changes, since the chip
 * asks again every few seconds. Statuses are shown as saved:
 * a reader cannot tell a topic still being answered from one whose writer stopped. Pictures attached
 * to a question are not sent. The dispatcher in index.ts runs the access gate first.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OmpBtwExchange, OmpBtwTopic } from "../shared/protocol.ts";
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";

const MAX_TOPICS = 100;
/** a topic whose question carries pictures is larger than its words; OMP sets no bound, these keep a read cheap */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_READ_BYTES = 32 * 1024 * 1024;
const MAX_TITLE_BYTES = 4096;
/** the histories read lately: by folder, each topic file's record as of its size and time */
const MAX_CACHED_HISTORIES = 16;
type Cached = { size: number; mtimeMs: number; topic: Omit<OmpBtwTopic, "title"> | null };
const cache = new Map<string, Map<string, Cached>>();
const ENTRY = /^entry-([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\.json$/;
const STATUSES = new Set<string>(["running", "complete", "cancelled", "error", "interrupted"]);
const EXCHANGE_KEYS = new Set(["question", "images", "answer", "status", "createdAt", "updatedAt", "error"]);
const TOPIC_KEYS = new Set([...EXCHANGE_KEYS, "id", "leafId", "followUps"]);

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;

/** one question and its answer as OMP saved it, or null where OMP would refuse the record */
function exchangeOf(record: Row, keys: Set<string>): OmpBtwExchange | null {
  if (Object.keys(record).some((key) => !keys.has(key))) return null;
  const { question, answer, status, createdAt, updatedAt, error, images } = record;
  if (typeof question !== "string" || typeof answer !== "string" || typeof status !== "string" || !STATUSES.has(status)) return null;
  if (!time(createdAt) || !time(updatedAt) || (error !== undefined && typeof error !== "string") || (images !== undefined && !Array.isArray(images))) return null;
  return { question, answer, status: status as OmpBtwExchange["status"], error: error ?? null, at: new Date(createdAt).toISOString() };
}

function topicOf(path: string, id: string): Omit<OmpBtwTopic, "title"> | null {
  try {
    const record = row(JSON.parse(readFileSync(path, "utf8")));
    if (record === null || record["id"] !== id || !(record["leafId"] === null || typeof record["leafId"] === "string")) return null;
    const head = exchangeOf(record, TOPIC_KEYS);
    const followUps = record["followUps"] === undefined ? [] : Array.isArray(record["followUps"]) ? record["followUps"].map((entry) => { const found = row(entry); return found && exchangeOf(found, EXCHANGE_KEYS); }) : null;
    if (head === null || followUps === null || followUps.some((entry) => entry === null)) return null;
    return { id, ...head, follow_ups: followUps as OmpBtwExchange[] };
  } catch {
    // removed between the listing and the read, or not JSON: OMP would not load it either
    return null;
  }
}

function titleOf(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_TITLE_BYTES) return null;
    const title = readFileSync(path, "utf8").trim();
    return title.length > 0 ? title.slice(0, 300) : null;
  } catch {
    return null;
  }
}

const folder = (path: string): boolean => { try { return lstatSync(path).isDirectory(); } catch { return false; } };

/** The saved `/btw` topics of the OMP session whose transcript is `transcript`, newest first. */
export function ompBtwTopics(transcript: string): OmpBtwTopic[] {
  if (!transcript.endsWith(".jsonl")) return [];
  const artifacts = transcript.slice(0, -".jsonl".length);
  const directory = join(artifacts, "btw-history");
  let names: string[];
  try {
    if (!folder(artifacts) || !folder(directory)) return [];
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const files = names.flatMap((name) => {
    const id = ENTRY.exec(name)?.[1];
    if (id === undefined) return [];
    try {
      const stat = lstatSync(join(directory, name));
      return stat.isFile() ? [{ name, id, size: stat.size, mtimeMs: stat.mtimeMs }] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_TOPICS);
  const known = cache.get(directory);
  const kept = new Map<string, Cached>();
  let budget = MAX_READ_BYTES;
  for (const file of files) {
    const before = known?.get(file.name);
    if (before && before.size === file.size && before.mtimeMs === file.mtimeMs) { kept.set(file.name, before); continue; }
    if (file.size > MAX_FILE_BYTES || file.size > budget) continue;
    budget -= file.size;
    kept.set(file.name, { size: file.size, mtimeMs: file.mtimeMs, topic: topicOf(join(directory, file.name), file.id) });
  }
  cache.delete(directory);
  cache.set(directory, kept);
  if (cache.size > MAX_CACHED_HISTORIES) cache.delete(cache.keys().next().value!);
  const topics = [...kept.values()].flatMap(({ topic }) => topic === null ? [] : [{ ...topic, title: titleOf(join(directory, `entry-${topic.id}.title`)) }]);
  // OMP's own order: newest first, then by id
  return topics.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** How the route finds a pane's OMP transcript: null for a pane that runs no OMP session with one. */
export type BtwSources = { transcript: (paneId: string) => Promise<string | null> };

/** The answer for the side conversations route, or null when the path is not it. */
export async function handleBtwRequest(request: Request, url: URL, pathname: string, { transcript }: BtwSources): Promise<Response | null> {
  if (pathname !== "/api/pane/btw") return null;
  setRequestRoute(pathname);
  if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
  const paneId = url.searchParams.get("pane_id");
  if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
  try {
    const path = await transcript(paneId);
    return jsonResponse({ topics: path === null ? [] : ompBtwTopics(path) });
  } catch (error) {
    return errorResponse(error);
  }
}

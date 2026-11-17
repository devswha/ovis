import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OmoRun, OmoRunNode, OmoTask } from "../shared/protocol.ts";
import { OMO_RUNNING, omoStateDir, type OmoStateOptions } from "./omo-state-dir.ts";

const MAX_RECORD_BYTES = 1024 * 1024;
const TASK_PARSE_BUDGET = 8 * 1024 * 1024;
const MAX_TASK_FILES = 50_000;

const RECENT_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 10;
const ENDED = new Set(["completed", "failed", "cancelled", "lost"]);

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const time = (value: unknown): number => typeof value === "string" ? Date.parse(value) || 0 : 0;

interface Kept { parent: unknown; hostPid: number | null; task: OmoTask | null }
const taskCache = new Map<string, { key: string; kept: Kept }>();

function keep(record: Row): Kept {
  return { parent: record["parent_session_id"], hostPid: typeof record["host_pid"] === "number" ? record["host_pid"] : null, task: task(record) };
}

function task(record: Row): OmoTask | null {
  const id = text(record["task_id"]);
  const raw = record["status"];
  if (id === null || typeof raw !== "string") return null;
  const status = OMO_RUNNING.has(raw) ? "running" : raw === "error" ? "failed" : raw === "interrupted" ? "lost" : ENDED.has(raw) ? raw as OmoTask["status"] : null;
  if (status === null) return null;
  const stats = row(record["run_stats"]);
  return {
    id,
    title: text(record["task_summary"]) ?? text(record["description"]) ?? text(record["name"]) ?? id,
    category: text(record["category"]) ?? text(record["agent_type"]),
    model: text(row(record["resolved_model"])?.["display"]) ?? text(record["model"]),
    status,
    started_at: text(record["started_at"]) ?? text(record["created_at"]),
    ended_at: status === "running" ? text(record["updated_at"]) : text(record["terminal_at"]) ?? text(record["updated_at"]),
    turns: count(stats?.["turns"]),
    tool_calls: count(stats?.["tool_calls"]),
    tokens: count(stats?.["total_tokens"]),
    detail_kind: null,
  };
}

export function omoTasks(cwd: string, sessionId: string, alive: (pid: number) => boolean, now = Date.now(), options: OmoStateOptions = {}): OmoTask[] {
  let dir: string;
  let names: string[];
  try { dir = join(omoStateDir(cwd, options), "tasks"); names = readdirSync(dir); } catch { return []; }
  const running: OmoTask[] = [];
  const ended: OmoTask[] = [];
  // `st_` ids grow with time
  const newest = names.filter((name) => name.startsWith("st_") && name.endsWith(".json")).sort().reverse().slice(0, MAX_TASK_FILES);
  let budget = TASK_PARSE_BUDGET;
  for (const name of newest) {
    const path = join(dir, name);
    let key: string;
    let size: number;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) continue;
      key = `${stat.mtimeMs}:${stat.size}`;
      size = stat.size;
    } catch { continue; }
    let cached = taskCache.get(path);
    if (cached?.key !== key) {
      if (budget < size) continue;
      budget -= size;
      let record: Row | null;
      try { record = row(JSON.parse(readFileSync(path, "utf8"))); } catch { continue; }
      cached = { key, kept: record === null ? { parent: null, hostPid: null, task: null } : keep(record) };
      taskCache.set(path, cached);
    }
    const { parent, hostPid, task: kept } = cached.kept;
    if (parent !== sessionId || kept === null) continue;
    const found: OmoTask = kept.status === "running" && hostPid !== null && !alive(hostPid) ? { ...kept, status: "lost" } : kept.status === "running" ? { ...kept, ended_at: null } : kept;
    const at = time(found.ended_at) || time(found.started_at);
    if (found.status === "running") running.push(found);
    else if (at !== 0 && now - at <= RECENT_MS) ended.push(found);
  }
  if (taskCache.size > MAX_TASK_FILES) taskCache.clear();
  running.sort((a, b) => time(a.started_at) - time(b.started_at));
  ended.sort((a, b) => time(b.ended_at) - time(a.ended_at));
  return [...running, ...ended.slice(0, RECENT_LIMIT)];
}

const RUN_LIMIT = 5;
const RUN_MAX_BYTES = 8 * 1024 * 1024;
const RUN_PARSE_BUDGET = 16 * 1024 * 1024;
const NODE_STATES = new Set(["pending", "scheduled", "running", "blocked", "completed", "failed", "skipped", "cancelled"]);
const RUN_STATES = new Set(["pending", "running", "paused", "completed", "failed", "cancelled"]);
const ACTIVE = new Set(["pending", "running", "paused"]);
const PARENT = /"parentSessionId"\s*:\s*"([^"]+)"/;
const runCache = new Map<string, { key: string; parent: string | null; run: OmoRun | null | undefined }>();

function parseRun(record: Row): OmoRun | null {
  const id = text(record["runId"]);
  const status = record["status"];
  if (id === null || typeof status !== "string" || !RUN_STATES.has(status) || !Array.isArray(record["nodes"])) return null;
  const nodes = new Map<string, OmoRunNode>();
  for (const value of record["nodes"]) {
    const node = row(value);
    const nodeId = text(node?.["id"]);
    const state = node?.["state"];
    if (node === null || nodeId === null || typeof state !== "string" || !NODE_STATES.has(state)) continue;
    nodes.set(nodeId, { id: nodeId, label: text(node["label"]) ?? nodeId, state: state as OmoRunNode["state"], error: state === "failed" ? text(row(node["error"])?.["message"]) : null });
  }
  const waves: OmoRunNode[][] = [];
  const placed = new Set<string>();
  for (const value of Array.isArray(record["waves"]) ? record["waves"] : []) {
    const ids = row(value)?.["nodeIds"];
    const wave = (Array.isArray(ids) ? ids : []).flatMap((nodeId) => {
      const node = typeof nodeId === "string" && !placed.has(nodeId) ? nodes.get(nodeId) : undefined;
      if (node === undefined) return [];
      placed.add(node.id);
      return [node];
    });
    if (wave.length > 0) waves.push(wave);
  }
  const rest = [...nodes.values()].filter((node) => !placed.has(node.id));
  if (rest.length > 0) waves.push(rest);
  return {
    id,
    name: text(record["name"]) ?? text(record["runKey"]) ?? id,
    status: status as OmoRun["status"],
    started_at: text(record["startedAt"]) ?? text(record["createdAt"]),
    ended_at: ACTIVE.has(status) ? null : text(record["completedAt"]) ?? text(record["updatedAt"]),
    waves,
  };
}

export function omoRuns(cwd: string, sessionId: string, now = Date.now(), options: OmoStateOptions = {}): OmoRun[] {
  let dir: string;
  let names: string[];
  try { dir = join(omoStateDir(cwd, options), "dag", "runs"); names = readdirSync(dir); } catch { return []; }
  const recent: { path: string; key: string; size: number; mtime: number }[] = [];
  for (const name of names.slice(0, 10_000)) {
    if (!name.startsWith("dag_") || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > RUN_MAX_BYTES || now - stat.mtimeMs > RECENT_MS) continue;
      recent.push({ path, key: `${stat.mtimeMs}:${stat.size}`, size: stat.size, mtime: stat.mtimeMs });
    } catch { continue; }
  }
  // `dag_` names are random
  recent.sort((a, b) => b.mtime - a.mtime);
  const active: OmoRun[] = [];
  const ended: OmoRun[] = [];
  let budget = RUN_PARSE_BUDGET;
  for (const file of recent) {
    let cached = runCache.get(file.path);
    if (cached?.key !== file.key || (cached.run === undefined && cached.parent === sessionId)) {
      if (budget < file.size) continue;
      budget -= file.size;
      let content: string;
      try { content = readFileSync(file.path, "utf8"); } catch { continue; }
      const parent = PARENT.exec(content.slice(0, 4096))?.[1] ?? null;
      let run: OmoRun | null | undefined;
      if (parent !== sessionId) run = undefined;
      else {
        try { const record = row(JSON.parse(content)); run = record === null ? null : parseRun(record); } catch { continue; }
      }
      cached = { key: file.key, parent, run };
      runCache.set(file.path, cached);
    }
    if (cached.parent !== sessionId || !cached.run) continue;
    (ACTIVE.has(cached.run.status) ? active : ended).push(cached.run);
  }
  if (runCache.size > 2048) runCache.clear();
  active.sort((a, b) => time(a.started_at) - time(b.started_at));
  ended.sort((a, b) => time(b.ended_at) - time(a.ended_at));
  return [...active, ...ended.slice(0, RUN_LIMIT)];
}

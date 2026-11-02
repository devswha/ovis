import { sameTranscriptVersion } from "./transcript-version.ts";
import type { OmoTask } from "../shared/protocol.ts";
import type { HistoryResult, HistoryVersion } from "./claude-command-history.ts";

export interface CommandLaunch { at: number; title: string; call: string | null; seq: number }
export interface CommandTerminal { at: number; status: OmoTask["status"]; call: string | null; seq?: number }
export interface CommandSource {
  generation: number;
  launches: [string, CommandLaunch][];
  ends: [string, CommandTerminal[]][];
  halt: number | null;
}
/** Parser-owned caches never cross an await: a task thread hands over this bounded value. */
export interface ClaudeTaskSnapshot {
  agents: { task: OmoTask; dispatched: number }[];
  sources: CommandSource[];
  parent: { version: HistoryVersion; limit: number; windowed: boolean } | null;
  live: boolean;
  since: number | null;
  now: number;
  settled: boolean;
  behind: boolean;
  watch: string[];
  promptAt: number | null;
  resting: boolean;
}
export interface ShellRecord { key: string; task: OmoTask; dispatched: number; historyVersion?: HistoryVersion }
export interface ClaudeTaskState {
  tasks: OmoTask[];
  shells: ShellRecord[];
  /** Includes IDs reserved by agents older than the displayed recent-task window. */
  remembered: OmoTask[];
  needed: string[];
  historyNeeded: boolean;
  historyPending: boolean;
  settled: boolean;
  behind: boolean;
  watch: string[];
  running: number;
  turnRunning: number;
  promptAt: number | null;
  resting: boolean;
}
const RECENT_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 10;
const START_SLACK_MS = 60_000;
const time = (value: string | null): number => value === null ? 0 : Date.parse(value) || 0;
const iso = (at: number | null): string | null => at === null ? null : new Date(at).toISOString();

/**
 * Fold historical terminal metadata only. Callers vouch for it before passing it here; this pure
 * function cannot read a transcript or turn history into prompt, busy, rest or queue evidence.
 */
export function foldClaudeTasks(snapshot: ClaudeTaskSnapshot, history: HistoryResult | null = null, pending?: ReadonlyMap<string, ShellRecord>): ClaudeTaskState {
  const { sources, parent, live, since, now, promptAt } = snapshot;
  const all = new Map<string, OmoTask>();
  const running: OmoTask[] = [], ended: OmoTask[] = [], shells: ShellRecord[] = [];
  let turnRunning = 0;
  for (const { task, dispatched } of snapshot.agents) keep(task, dispatched);
  type Told = CommandTerminal & { source?: CommandSource; historical?: boolean };
  const ends = new Map<string, Told[]>();
  const tell = (id: string, end: Told) => { const told = ends.get(id); if (told) told.push(end); else ends.set(id, [end]); };
  for (const source of sources) for (const [id, told] of source.ends) for (const end of told) tell(id, { ...end, source });
  const endOf = (id: string, launch: CommandLaunch, source: CommandSource) => {
    let first: Told | undefined;
    for (const end of ends.get(id) ?? []) {
      const named = end.call !== null && launch.call !== null;
      const after = end.source === source && end.seq !== undefined && end.seq > launch.seq;
      if (end.at < launch.at || (named && end.call !== launch.call) || (end.at === launch.at && !named && !after)) continue;
      if (first === undefined || end.at < first.at) first = end;
    }
    return first;
  };
  const unresolved = () => sources.some((source) => source.launches.some(([id, launch]) => endOf(id, launch, source) === undefined && !(launch.at <= (source.halt ?? -Infinity))));
  const needed = [...new Set(sources.flatMap((source) => source.launches.filter(([id, launch]) => endOf(id, launch, source) === undefined).map(([id]) => id)))];
  const historyNeeded = parent !== null && parent.windowed && unresolved();
  const evidence = historyNeeded && history?.unverified !== true ? history : null;
  if (evidence !== null) for (const end of evidence.ends) tell(end.id, { ...end, historical: true });
  const historyPending = historyNeeded && unresolved() && !(evidence?.complete && evidence.through >= parent!.limit);
  for (const source of sources) for (const [id, launch] of source.launches) {
    if (all.has(id)) continue;
    const end = endOf(id, launch, source) ?? (source.halt !== null && launch.at <= source.halt ? { at: source.halt, status: "cancelled" as const } : undefined);
    const lost = !live || (since !== null && launch.at < since - START_SLACK_MS);
    const key = JSON.stringify([source.generation, id, launch.call, launch.at, launch.seq]);
    const prior = historyNeeded && end === undefined ? pending?.get(key) : undefined;
    // Only historical terminal outcomes at this exact parent generation survive re-vouch.
    // Changed generations expose local pending/running facts until their lines are checked.
    // Running/lost classification belongs to the
    // current process boundary, which may have become known while a proof was in flight.
    const old = prior?.historyVersion && parent !== null && sameTranscriptVersion(prior.historyVersion, parent.version) && ["completed", "failed", "cancelled"].includes(prior.task.status) ? prior : undefined;
    const task: OmoTask = old ? { ...old.task, title: launch.title } : { id, title: launch.title, category: "shell", model: null, status: end?.status ?? (lost ? "lost" : "running"), started_at: iso(launch.at), ended_at: iso(end?.at ?? null), turns: null, tool_calls: null, tokens: null, detail_kind: null };
    shells.push({ key, task, dispatched: launch.at, historyVersion: old?.historyVersion ?? (end && "historical" in end && end.historical && evidence !== null ? { ...evidence.version } : undefined) });
    keep(task, launch.at);
  }
  running.sort((a, b) => time(a.started_at) - time(b.started_at));
  const last = (task: OmoTask): number => time(task.ended_at) || time(task.started_at);
  ended.sort((a, b) => last(b) - last(a));
  return { tasks: [...running, ...ended.slice(0, RECENT_LIMIT)], shells, remembered: [...all.values()], needed, historyNeeded, historyPending, settled: snapshot.settled && !historyPending, behind: snapshot.behind, watch: snapshot.watch, running: running.length, turnRunning, promptAt, resting: snapshot.resting };

  function keep(task: OmoTask, dispatched: number): void {
    all.set(task.id, task);
    if (task.status === "running") { running.push(task); if (promptAt === null || dispatched >= promptAt) turnRunning++; }
    else { const at = time(task.ended_at) || time(task.started_at); if (at !== 0 && now - at <= RECENT_MS) ended.push(task); }
  }
}

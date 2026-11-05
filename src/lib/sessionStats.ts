import { useSyncExternalStore } from "react";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { formatBytes } from "./bridgeProgress.ts";
import { formatGoalTime, turnGoal, type GoalState, type GoalStatus } from "./goals.ts";
import { t } from "./i18n.ts";

/**
 * A chat session's totals for the header (#2017): how long the agent has worked, how large its
 * transcript is, and the goal it works toward. Worked time is the sum of the agent turns' own
 * durations (each turn's first to last recorded activity, as its "Worked for" says), not the wall
 * time since the session began: idle time between turns is not work. The chat pages its turns, so
 * until the beginning is loaded the sum covers only the turns read and is said as "at least".
 */
export interface SessionStats {
  workedSeconds: number | null;
  /** the turns reach back to the conversation's beginning: the sum is the whole session's */
  complete: boolean;
  /** the transcript file's size (ConversationResponse.transcript_bytes); null when the store is not one file */
  bytes: number | null;
  /** the goal the latest omo goal call left in the turns read */
  goal: GoalState | null;
}

export function sessionStats(turns: readonly ConversationTurn[], complete: boolean, bytes: number | null): SessionStats {
  let worked: number | null = null;
  for (const turn of turns) {
    if (turn.role !== "assistant" || turn.ts === null || turn.end_ts === undefined) continue;
    const ms = Date.parse(turn.end_ts) - Date.parse(turn.ts);
    if (Number.isFinite(ms) && ms >= 0) worked = (worked ?? 0) + ms;
  }
  return {
    workedSeconds: worked === null ? null : Math.round(worked / 1000),
    complete,
    bytes,
    goal: turnGoal(turns.flatMap((turn) => turn.role === "assistant" ? turn.parts : [])),
  };
}

const sameGoal = (a: GoalState | null, b: GoalState | null): boolean => a === b || (a !== null && b !== null
  && a.objective === b.objective && a.status === b.status && a.tokensUsed === b.tokensUsed && a.timeUsedSeconds === b.timeUsedSeconds && a.blockedReason === b.blockedReason);

const same = (a: SessionStats | undefined, b: SessionStats | null): boolean => a === undefined ? b === null
  : b !== null && a.workedSeconds === b.workedSeconds && a.complete === b.complete && a.bytes === b.bytes && sameGoal(a.goal, b.goal);

// each pane's chat publishes its own; the header reads the selected pane's
const published = new Map<string, SessionStats>();
const listeners = new Set<() => void>();
const keyOf = (machineId: string, paneId: string): string => `${machineId}\0${paneId}`;

/** `stats` null: the pane's chat shows no conversation (any more). Tells readers only on a change. */
export function publishSessionStats(machineId: string, paneId: string, stats: SessionStats | null): void {
  const key = keyOf(machineId, paneId);
  if (same(published.get(key), stats)) return;
  if (stats === null) published.delete(key);
  else published.set(key, stats);
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSessionStats(machineId: string, paneId: string | null): SessionStats | null {
  return useSyncExternalStore(subscribe, () => paneId === null ? null : published.get(keyOf(machineId, paneId)) ?? null);
}

const STATUS_WORDS: Record<GoalStatus, string> = {
  active: "in progress", paused: "paused", blocked: "blocked", complete: "complete", budget_limited: "out of budget",
};

export function goalStatusWord(status: GoalStatus): string {
  return t(STATUS_WORDS[status]);
}

/** "Worked 2h 5m", "Worked at least 40m" while earlier turns are not loaded, or null when unknown. */
export function workedWords(stats: SessionStats): string | null {
  if (stats.workedSeconds === null) return null;
  const duration = formatGoalTime(stats.workedSeconds);
  return stats.complete ? t("Worked {duration}", { duration }) : t("Worked at least {duration}", { duration });
}

export function sizeWords(stats: SessionStats): string | null {
  return stats.bytes === null ? null : formatBytes(stats.bytes);
}

/** The More menu's lines: totals (an unknown one said so), then the goal and its time. */
export function sessionMenuLines(stats: SessionStats): { totals: string; goal: string | null } {
  const totals = [
    workedWords(stats) ?? t("Work time unknown"),
    stats.bytes === null ? t("Transcript size unknown") : t("Transcript {size}", { size: formatBytes(stats.bytes) }),
  ].join(" · ");
  const goal = stats.goal;
  if (goal === null) return { totals, goal: null };
  const spent = goal.timeUsedSeconds !== null && goal.timeUsedSeconds > 0 ? [formatGoalTime(goal.timeUsedSeconds)] : [];
  return { totals, goal: [t("Goal: {objective}", { objective: goal.objective }), goalStatusWord(goal.status), ...spent].join(" · ") };
}

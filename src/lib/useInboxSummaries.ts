/**
 * Each inbox row's last words and their time (components/AgentInbox.tsx), read through GET
 * /api/pane/summary a batch per PC at a time. Nothing is stored past the page; a row that leaves the
 * list leaves its summary behind.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { PANE_SUMMARY_MAX_IDS } from "../../shared/pane-summary.ts";
import type { PaneSummaries, PaneSummary } from "../../shared/protocol.ts";
import { inboxKey, inboxStatus } from "./agentInbox.ts";
import type { AgentRow } from "./agentRoster.ts";
import { fetchPaneSummaries } from "./api.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";

/** Rows whose summary is read, from the top of the list. */
export const SUMMARY_ROWS = 60;
/** How long after an answer that left a pane out, or a failed request, it is asked for again, and how many times. */
export const SUMMARY_RETRY_MS = 2000;
export const SUMMARY_RETRIES = 3;

/** A row's last words; times are this device's clock in ms, the server's offset taken out. */
export interface RowSummary {
  role: "assistant" | "user";
  text: string;
  /** when the words were said: the turn's end, else its start */
  at: number | null;
  /** the newest user turn's time; null when the user never wrote */
  askedAt: number | null;
  /** the words are a request the agent recorded as failed */
  failed: boolean;
}

/** A row whose summary is read: a new `stamp` (finish, activity or shown state changed) reads it again. */
export interface SummaryTarget { key: string; machineId: string; paneId: string; stamp: string }

/** The first SUMMARY_ROWS rows of a PC in reach, in the given order. */
export function summaryTargets(rows: readonly AgentRow[], activity: SidebarActivity): SummaryTarget[] {
  return rows.filter((row) => row.machine.state === "connected").slice(0, SUMMARY_ROWS).map((row) => {
    const pane = row.entry.pane;
    const seq = activity.seqs(row.machine.id).get(pane.pane_id) ?? 0;
    return { key: inboxKey(row), machineId: row.machine.id, paneId: pane.pane_id, stamp: `${pane.finish_id ?? ""}:${seq}:${inboxStatus(row, activity) ?? ""}` };
  });
}

export type SummaryRead = (machineId: string, paneIds: readonly string[]) => Promise<PaneSummaries | null>;
export type SummaryWait = (run: () => void, ms: number) => () => void;

export const NO_SUMMARIES: ReadonlyMap<string, RowSummary> = new Map();
const readOf = (target: SummaryTarget): string => `${target.key}\n${target.stamp}`;

function timeOf(stamp: string | null, offset: number): number | null {
  if (stamp === null) return null;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : ms - offset;
}

const same = (a: RowSummary | undefined, b: RowSummary): boolean => a !== undefined
  && a.role === b.role && a.text === b.text && a.at === b.at && a.askedAt === b.askedAt && a.failed === b.failed;

/**
 * Each target's summary, read once per key and stamp: batches of at most PANE_SUMMARY_MAX_IDS per PC, one
 * request in flight per PC. A pane the answer left out, or a request that failed, is asked again after
 * SUMMARY_RETRY_MS, at most SUMMARY_RETRIES times per key and stamp; a PC whose bridge has no route (null) is
 * not asked again. A key's words outlive a stamp change until the new read settles: replaced or removed by
 * an answer naming the pane, removed when the read gives up. An answer for a target gone or moved on since
 * is dropped, and a key that leaves the targets loses its summary. Made once per page, it never stops and
 * assumes no subscriber.
 */
export class SummaryReads {
  private readonly listeners = new Set<() => void>();
  private current: ReadonlyMap<string, RowSummary> = NO_SUMMARIES;
  private targets = new Map<string, SummaryTarget>();
  /** the key-and-stamp reads queued, in flight or answered, and how many times each was asked again */
  private readonly started = new Set<string>();
  private readonly retries = new Map<string, number>();
  private readonly waits = new Map<string, () => void>();
  private readonly queues = new Map<string, SummaryTarget[]>();
  private readonly busy = new Set<string>();
  private readonly missing = new Set<string>();

  constructor(private readonly read: SummaryRead,
    private readonly wait: SummaryWait = (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); },
    private readonly now: () => number = Date.now) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The same object until a summary is added, replaced or removed. */
  summaries = (): ReadonlyMap<string, RowSummary> => this.current;

  sync(targets: readonly SummaryTarget[]): void {
    this.targets = new Map(targets.map((target) => [target.key, target]));
    const live = new Set(targets.map(readOf));
    for (const read of [...this.started]) {
      if (live.has(read)) continue;
      this.started.delete(read);
      this.retries.delete(read);
      this.waits.get(read)?.();
      this.waits.delete(read);
    }
    for (const [machineId, queue] of this.queues) this.queues.set(machineId, queue.filter((target) => this.isCurrent(target)));
    const gone = [...this.current.keys()].filter((key) => !this.targets.has(key));
    if (gone.length > 0) this.change((summaries) => { for (const key of gone) summaries.delete(key); });
    for (const target of targets) {
      const read = readOf(target);
      if (this.started.has(read) || this.missing.has(target.machineId)) continue;
      this.started.add(read);
      this.enqueue(target);
    }
    for (const machineId of [...this.queues.keys()]) this.pump(machineId);
  }

  private isCurrent(target: SummaryTarget): boolean {
    const now = this.targets.get(target.key);
    return now?.stamp === target.stamp && now.machineId === target.machineId && now.paneId === target.paneId;
  }

  private enqueue(target: SummaryTarget): void {
    const queue = this.queues.get(target.machineId);
    if (queue) queue.push(target); else this.queues.set(target.machineId, [target]);
  }

  private change(edit: (summaries: Map<string, RowSummary>) => void): void {
    const next = new Map(this.current);
    edit(next);
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }

  private pump(machineId: string): void {
    if (this.busy.has(machineId) || this.missing.has(machineId)) return;
    const queue = (this.queues.get(machineId) ?? []).filter((target) => this.isCurrent(target));
    const batch = queue.splice(0, PANE_SUMMARY_MAX_IDS);
    this.queues.set(machineId, queue);
    if (batch.length === 0) return;
    this.busy.add(machineId);
    const failed = () => {
      this.busy.delete(machineId);
      for (const target of batch) if (this.isCurrent(target)) this.again(target);
      this.pump(machineId);
    };
    this.read(machineId, batch.map((target) => target.paneId)).then((answer) => {
      try {
        if (answer === null) {
          this.missing.add(machineId);
          this.queues.delete(machineId);
        } else {
          this.take(batch, answer);
        }
      } catch {
        failed();
        return;
      }
      this.busy.delete(machineId);
      this.pump(machineId);
    }, failed);
  }

  private take(batch: readonly SummaryTarget[], answer: PaneSummaries): void {
    const serverNow = Date.parse(answer.server_time);
    const offset = Number.isNaN(serverNow) ? 0 : serverNow - this.now();
    const set = new Map<string, RowSummary>();
    const cleared: string[] = [];
    const left: SummaryTarget[] = [];
    for (const target of batch) {
      if (!this.isCurrent(target)) continue;
      if (!Object.hasOwn(answer.summaries, target.paneId)) { left.push(target); continue; }
      const summary: PaneSummary | null | undefined = answer.summaries[target.paneId];
      if (summary == null) { if (this.current.has(target.key)) cleared.push(target.key); continue; }
      const row: RowSummary = { role: summary.role, text: summary.text, at: timeOf(summary.at, offset), askedAt: timeOf(summary.asked_at, offset), failed: summary.failed === true };
      if (!same(this.current.get(target.key), row)) set.set(target.key, row);
    }
    for (const target of left) this.again(target);
    if (set.size > 0 || cleared.length > 0) this.change((summaries) => {
      for (const key of cleared) summaries.delete(key);
      for (const [key, row] of set) summaries.set(key, row);
    });
  }

  /** Asks the target again after the wait; once its retries are used, removes words kept from an earlier stamp. */
  private again(target: SummaryTarget): void {
    const read = readOf(target);
    const tried = this.retries.get(read) ?? 0;
    if (tried >= SUMMARY_RETRIES) {
      if (this.current.has(target.key)) this.change((summaries) => { summaries.delete(target.key); });
      return;
    }
    this.retries.set(read, tried + 1);
    this.waits.set(read, this.wait(() => {
      this.waits.delete(read);
      if (!this.isCurrent(target)) return;
      this.enqueue(target);
      this.pump(target.machineId);
    }, SUMMARY_RETRY_MS));
  }
}

/** The page's reader: made once beside the list's other state (lib/useInbox.ts), so it outlives each mount of the list. */
export const newSummaryReads = (): SummaryReads => new SummaryReads(fetchPaneSummaries);

/** Each target's last words by its key, from the page's reader. */
export function useInboxSummaries(reads: SummaryReads, targets: readonly SummaryTarget[]): ReadonlyMap<string, RowSummary> {
  const targetsRef = useRef(targets); targetsRef.current = targets;
  const signature = targets.map((target) => `${target.key}:${target.machineId}:${target.paneId}:${target.stamp}`).join("\n");
  useEffect(() => { reads.sync(targetsRef.current); }, [reads, signature]);
  return useSyncExternalStore(reads.subscribe, reads.summaries, reads.summaries);
}

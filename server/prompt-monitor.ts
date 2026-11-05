import { createHash, randomUUID } from "node:crypto";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

const READ_INTERVAL_MS = 500;
/** reads in a row that fail before a watch ends (`prompt_watch_ended`) */
const FAILED_READS_END = 10;

export interface PromptReader {
  snapshot(): Promise<SessionSnapshot>;
  /** what the prompt on the pane's screen says (null: none shows), or undefined when the read raced a change and says nothing */
  read(pane: HerdrPane, panes: HerdrPane[]): Promise<string | null | undefined>;
}

/** `shown`: what the last read found ("" for no prompt), undefined until a read after the watch began or the agent's last work */
interface WatchedPrompt { shown?: string; failures: number }

/**
 * One read loop for the server's prompt watches (server/core/prompt-watch.ts): every watched pane is read every
 * 500 ms, however many connections watch it, and the watchers are told when what its prompt says changes. A pane
 * herdr reports working or blocked is not read: its status says as much (pane-status), and its first read after
 * that is told again.
 */
export class PromptMonitor {
  private readonly panes = new Map<string, WatchedPrompt>();
  private readonly salt = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private ticking: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly reader: PromptReader,
    private readonly changed: (paneId: string, signature: string) => void,
    /** the pane closed, or its reads kept failing: the watch is gone */
    private readonly ended: (paneId: string) => void,
    private readonly intervalMs = READ_INTERVAL_MS,
  ) {}

  get size(): number { return this.panes.size; }

  watch(paneId: string): void {
    if (this.stopped || this.panes.has(paneId)) return;
    this.panes.set(paneId, { failures: 0 });
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
      this.timer.unref();
    }
    void this.tick();
  }

  unwatch(paneId: string): void {
    this.panes.delete(paneId);
    if (this.panes.size === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  stop(): void {
    this.stopped = true;
    this.panes.clear();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One read of every watched pane, never two at once: a slow herdr skips ticks rather than piling reads up. */
  tick(): Promise<void> {
    this.ticking ??= this.readAll().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async readAll(): Promise<void> {
    const watched = [...this.panes];
    if (watched.length === 0) return;
    let snapshot: SessionSnapshot;
    try {
      snapshot = await this.reader.snapshot();
    } catch {
      for (const [paneId, state] of watched) this.failed(paneId, state);
      return;
    }
    await Promise.all(watched.map(async ([paneId, state]) => {
      if (this.panes.get(paneId) !== state) return;
      const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
      if (!pane) {
        this.end(paneId);
        return;
      }
      if (pane.agent_status === "working" || pane.agent_status === "blocked") {
        state.shown = undefined;
        return;
      }
      let shown: string | null | undefined;
      try {
        shown = await this.reader.read(pane, snapshot.panes);
      } catch {
        if (this.panes.get(paneId) === state) this.failed(paneId, state);
        return;
      }
      if (this.panes.get(paneId) !== state) return;
      state.failures = 0;
      if (shown !== undefined) this.publish(paneId, state, shown ?? "");
    }));
  }

  private publish(paneId: string, state: WatchedPrompt, shown: string): void {
    if (shown === state.shown) return;
    state.shown = shown;
    this.changed(paneId, createHash("sha256").update(`${this.salt}\0${paneId}\0${shown}`).digest("base64url").slice(0, 22));
  }

  private failed(paneId: string, state: WatchedPrompt): void {
    state.failures += 1;
    if (state.failures >= FAILED_READS_END) this.end(paneId);
  }

  private end(paneId: string): void {
    this.unwatch(paneId);
    this.ended(paneId);
  }
}

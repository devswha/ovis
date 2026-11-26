import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { ConversationTurn, SessionSnapshot } from "../shared/protocol.ts";
import { ConversationNotStarted, ConversationUnavailable, paneTranscript, type NativeTranscript } from "./conversation.ts";
import { agyDatabasePath } from "./agy.ts";
import { coreAcp } from "./herdr-core/runtime.ts";
import { sessionSnapshot } from "./herdr/client.ts";
import { parseOmpTranscript } from "./transcript-records.ts";

const STAT_INTERVAL_MS = 250;
const RESOLVE_INTERVAL_MS = 5000;
const MISSING_RESOLVE_INTERVAL_MS = 2000;

interface WatchedConversation {
  transcript: NativeTranscript | null;
  observed?: string;
  /** the identity of pi's live-message file (ovis-model writes `<session>.live` while a reply streams) */
  live?: string;
  /** pi's session folder, watched so a streamed reply is read when it is written, not at the next stat */
  watcher?: { path: string; watcher: FSWatcher | null };
  nextResolve: number;
  resolving: boolean;
}

function fileIdentity(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { return "missing"; }
}

function liveTurn(path: string): ConversationTurn | null {
  try {
    const turn = parseOmpTranscript(readFileSync(path, "utf8"), 1).at(-1);
    return turn?.role === "assistant" ? turn : null;
  } catch { return null; }
}

export class ConversationMonitor {
  private readonly panes = new Map<string, WatchedConversation>();
  private readonly salt = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private snapshot: Promise<SessionSnapshot> | null = null;
  private stopped = false;
  /** told pi's live message for a pane whenever it changes: its turn, or null once it is gone */
  liveChanged?: (paneId: string, turn: ConversationTurn | null) => void;

  constructor(
    private readonly changed: (paneId: string, signature: string) => void,
    private readonly codexHome?: string,
    private readonly devinDbPath?: string,
    private readonly opencodeDb?: string,
    private readonly hermesHome?: string,
    private readonly grokHome?: string,
    private readonly museData?: string,
  ) {}

  get size(): number { return this.panes.size; }

  watch(paneId: string): void {
    if (this.stopped || this.panes.has(paneId)) return;
    this.panes.set(paneId, { transcript: null, nextResolve: 0, resolving: false });
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), STAT_INTERVAL_MS);
      this.timer.unref();
    }
    this.poll();
  }

  unwatch(paneId: string): void {
    this.panes.get(paneId)?.watcher?.watcher?.close();
    this.panes.delete(paneId);
    if (this.panes.size === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.panes.values()) state.watcher?.watcher?.close();
    this.panes.clear();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private publish(paneId: string, state: WatchedConversation, observed: string): void {
    if (this.panes.get(paneId) !== state || observed === state.observed) return;
    state.observed = observed;
    const signature = createHash("sha256").update(`${this.salt}\0${paneId}\0${observed}`).digest("base64url").slice(0, 22);
    this.changed(paneId, signature);
  }

  private read(paneId: string, state: WatchedConversation): boolean {
    const transcript = state.transcript;
    if (!transcript) return false;
    if (transcript.source === "acp") {
      const history = coreAcp()?.forPane(paneId)?.client.history;
      if (!history || history.path !== transcript.path) { state.nextResolve = 0; return false; }
      this.publish(paneId, state, `${history.path}:${history.signature}`);
      return true;
    }
    const identity = fileIdentity(transcript.path);
    const database = transcript.source === "devin-transcript" || transcript.source === "opencode-transcript" || transcript.source === "hermes-transcript";
    const wal = database ? fileIdentity(`${transcript.path}-wal`) : "";
    const session = transcript.source === "hermes-transcript" ? transcript.sessionId : database ? transcript.session : "";
    const cwd = transcript.source === "devin-transcript" ? transcript.cwd : "";
    const catalog = transcript.source === "agy-transcript" ? agyDatabasePath(transcript.path) : null;
    const catalogIdentity = catalog === null ? "" : `${fileIdentity(catalog)}:${fileIdentity(`${catalog}-wal`)}`;
    const observed = `${transcript.source}\0${transcript.path}\0${session}\0${cwd}\0${identity}\0${wal}\0${catalogIdentity}`;
    if (identity === "missing" && observed !== state.observed) state.nextResolve = 0;
    this.publish(paneId, state, observed);
    if (transcript.source === "pi-transcript") {
      this.watchFolder(paneId, state, transcript.path);
      this.readLive(paneId, state, `${transcript.path}.live`);
    } else if (state.watcher) {
      state.watcher.watcher?.close();
      state.watcher = undefined;
    }
    return identity !== "missing";
  }

  /**
   * Read a pi pane again as soon as its session or live file changes: the stat loop alone leaves a
   * streamed reply up to its interval behind and in steps of it. Where the folder cannot be watched
   * (out of watches, a gone folder) the stat loop still reads it.
   */
  private watchFolder(paneId: string, state: WatchedConversation, path: string): void {
    if (state.watcher?.path === path) return;
    state.watcher?.watcher?.close();
    const names = new Set([basename(path), `${basename(path)}.live`]);
    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(dirname(path), { persistent: false }, (_event, name) => {
        if (name !== null && names.has(name) && this.panes.get(paneId) === state) this.read(paneId, state);
      });
      watcher.on("error", () => watcher?.close());
    } catch { watcher = null; }
    state.watcher = { path, watcher };
  }

  private readLive(paneId: string, state: WatchedConversation, path: string): void {
    const identity = fileIdentity(path);
    if (identity === state.live) return;
    // a pane first watched with no reply under way has nothing to clear
    const first = state.live === undefined;
    state.live = identity;
    if (identity === "missing" && first) return;
    this.liveChanged?.(paneId, identity === "missing" ? null : liveTurn(path));
  }

  private poll(): void {
    const now = Date.now();
    for (const [paneId, state] of this.panes) {
      this.read(paneId, state);
      if (!state.resolving && state.nextResolve <= now) void this.resolve(paneId, state);
    }
  }

  private async resolve(paneId: string, state: WatchedConversation): Promise<void> {
    state.resolving = true;
    let present = false;
    try {
      this.snapshot ??= sessionSnapshot().finally(() => { this.snapshot = null; });
      const snapshot = await this.snapshot;
      if (this.panes.get(paneId) !== state) return;
      const transcript = await paneTranscript(paneId, this.codexHome, snapshot, this.devinDbPath, this.opencodeDb, this.hermesHome, this.grokHome, this.museData);
      if (this.panes.get(paneId) !== state) return;
      state.transcript = transcript;
      present = this.read(paneId, state);
    } catch (error) {
      if (this.panes.get(paneId) !== state) return;
      if (error instanceof ConversationUnavailable) {
        state.transcript = null;
        const pending = error instanceof ConversationNotStarted ? `:${error.sessionId}` : "";
        this.publish(paneId, state, `unavailable:${error.message}${pending}`);
      } else {
        // A transient herdr failure must not replace a known native file with scrollback.
        present = state.transcript !== null;
      }
    } finally {
      state.resolving = false;
      state.nextResolve = Date.now() + (present ? RESOLVE_INTERVAL_MS : MISSING_RESOLVE_INTERVAL_MS);
    }
  }
}

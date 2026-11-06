/**
 * Messages the user scheduled for a pane's agent (#2919): kept by this PC, in its state folder. At its time a message
 * is typed only while a device has its pane open (#2951: that device's width is what a wrapped password prompt is read
 * at; with none it waits), and as a queued next-turn message is
 * (server/core/pending.ts sendScheduled): it waits for the agent's turn, never goes over a draft or an open
 * question, and only into the terminal and agent session it was scheduled for. One whose pane is gone or runs
 * another session is held with the reason until the user sends or discards it. A message is claimed (`sending`)
 * before anything is typed, so the timer and a Send now never send it twice; one the PC stopped in the middle of
 * is never sent again on its own.
 *
 * Routes, on this PC only: a connection server does not pass them to a remote PC (server/machine-api.ts), as it forwards with
 * its own credential and a device revoked there could not stop what it scheduled:
 *   GET  /api/scheduled                 { messages }
 *   POST /api/scheduled                 { pane_id, text, send_at } -> { message }
 *   POST /api/scheduled/update          { id, text?, send_at? }    -> { message }
 *   POST /api/scheduled/discard         { id }                     -> { ok }
 *   POST /api/scheduled/send            { id }                     -> { ok }, or the refusal
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScheduledMessage } from "../shared/protocol.ts";
import { HerdrError } from "./herdr/client.ts";
import { jsonResponse, setRequestRoute } from "./http.ts";
import type { PendingIdentity } from "./pending-input.ts";

type Reply = { ok: boolean; code?: string; message?: string };

/** refusals that only mean "not yet": the message stays scheduled, says why, and is tried again at the pane's next event */
const WAIT_CODES = new Set(["cancelled", "pending_wait", "agent_blocked", "agent_not_ready", "input_not_ready", "attach_held", "awaiting_status", "input_draft", "rewind_dialog_open", "submit_timeout"]);
/** a delivery that may have typed part of the message: never sent again on its own or by Send now */
const UNCERTAIN_CODES = new Set(["submit_changed", "pasted_not_sent"]);
export const MAX_SCHEDULED = 64;
const MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
/** a due message waiting for its turn is also tried this often, as a missed pane event must not strand it */
const RETRY_MS = 30_000;
/** the longest setTimeout delay */
const MAX_TIMER_MS = 2_147_483_647;
const FILE = "scheduled-messages.json";
const NEEDS_OK_UNCERTAIN = { code: "needs_ok", message: "A message to this pane may still be in its input line. Check the terminal, then send this one or discard it." };
const NEEDS_OK_MOVED = { code: "needs_ok_moved", message: "The pane moved to another workspace after this was scheduled. Send it now or discard it." };
const PANE_GONE = { code: "pane_not_found", message: "The pane is gone" };
const NEEDS_OK_RESTART = { code: "needs_ok_restart", message: "This came due while this PC's server was not running. Send it now or discard it." };

/** `gone`: the pane ended while this one was on its way; it settles as gone */
interface Entry { message: ScheduledMessage; identity: PendingIdentity; device: string | null; triedAt?: number; gone?: boolean }

export class ScheduledError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export interface ScheduledDeps {
  /** where the messages are kept; none keeps them in memory only */
  stateDir?: string;
  /** a message's text as a queued one must be, or a throw saying why (server/core/composer.ts pendingText) */
  checkText: (text: string) => string;
  /** what runs in the pane now (pane_not_found when it is gone) */
  identity: (paneId: string) => Promise<PendingIdentity>;
  send: (paneId: string, text: string, identity: PendingIdentity, automatic: boolean, authorize: () => void) => Promise<Reply>;
  /** whether the device that scheduled a message may still drive this PC (null: no paired device, as the token or this PC) */
  mayDrive: (device: string | null) => boolean;
  /** the list changed: every connection reads it again */
  changed: () => void;
  /** a send left this pane's input uncertain: the pane's queued messages are held behind it, as behind their own */
  uncertain?: (paneId: string) => void;
  /** a message that may have sat in this pane's input was discarded: the pane's queued messages may go again */
  released?: (paneId: string) => void;
  now?: () => number;
  retryMs?: number;
}

export class ScheduledMessages {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** no timer runs until start, nor after stop */
  private stopped = true;
  /** the server stops: nothing more is typed */
  private closed = false;
  private readonly now: () => number;
  /** the state file could not be read nor set aside: nothing is scheduled, and it is never written over */
  private unavailable = false;

  constructor(private readonly deps: ScheduledDeps) {
    this.now = deps.now ?? Date.now;
    for (const entry of this.load()) this.entries.set(entry.message.id, entry);
  }

  /** whether one of the pane's messages may sit typed in its input: the pending queue sends nothing there on its own */
  uncertainIn(paneId: string): boolean {
    return [...this.entries.values()].some((entry) => entry.message.pane_id === paneId && entry.message.state === "uncertain");
  }

  list(): ScheduledMessage[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.message, ...(entry.message.error ? { error: { ...entry.message.error } } : {}) }))
      .sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at));
  }

  async create(body: unknown, device: string | null): Promise<ScheduledMessage> {
    const record = object(body);
    const paneId = typeof record["pane_id"] === "string" && record["pane_id"] ? record["pane_id"] : null;
    if (paneId === null) throw new ScheduledError("missing_pane_id", "pane_id is required");
    const text = this.text(record["text"]);
    const sendAt = this.sendAt(record["send_at"]);
    if (this.unavailable) throw new ScheduledError("scheduled_unavailable", "This PC cannot keep scheduled messages: its scheduled-messages.json could not be read", 503);
    if (this.entries.size >= MAX_SCHEDULED) throw new ScheduledError("scheduled_limit", `At most ${MAX_SCHEDULED} messages can be scheduled; send or discard one first`, 409);
    let identity: PendingIdentity;
    try { identity = await this.deps.identity(paneId); } catch (error) {
      if (error instanceof HerdrError && error.code === "pane_not_found") throw new ScheduledError("pane_not_found", "The pane is gone", 404);
      throw error;
    }
    // bound to nothing that could tell a later program from this one: never scheduled, as any agent started there later would get it
    if (identity.processPid == null && identity.session == null) throw new ScheduledError("agent_not_ready", "Nothing runs in front of this pane to schedule a message for", 409);
    const message: ScheduledMessage = { id: crypto.randomUUID(), pane_id: paneId, text, send_at: sendAt, created_at: new Date(this.now()).toISOString(), state: "scheduled" };
    this.entries.set(message.id, { message, identity, device });
    // kept only once written: a refused write leaves nothing behind to go alongside a retry
    try { this.save(); } catch (error) { this.entries.delete(message.id); throw error; }
    this.announce();
    return { ...message };
  }

  /** A new text or time; a held message is scheduled again for it, still for the session it was scheduled for. */
  update(body: unknown, device: string | null = null): ScheduledMessage {
    const record = object(body);
    const entry = this.entry(record["id"]);
    // the edit is the editing device's: it goes only while that device may still drive this PC
    if (!this.deps.mayDrive(device)) throw new ScheduledError("device_revoked", "This device can no longer drive this PC", 403);
    if (entry.message.state === "sending") throw busy();
    if (entry.message.state === "uncertain") throw uncertain();
    // every field is checked before any changes: a refused edit leaves the message as it was
    const text = record["text"] === undefined ? entry.message.text : this.text(record["text"]);
    const sendAt = record["send_at"] === undefined ? entry.message.send_at : this.sendAt(record["send_at"]);
    const was = { message: { ...entry.message }, triedAt: entry.triedAt, device: entry.device };
    entry.device = device;
    entry.message.text = text;
    entry.message.send_at = sendAt;
    // a held message edited with its time still past stays held: Save never sends it, only Send now does
    if (!(was.message.state === "held" && Date.parse(sendAt) <= this.now())) {
      entry.message.state = "scheduled";
      delete entry.message.error;
      delete entry.triedAt;
    }
    // written before it counts: a refused write leaves the message as it was
    try { this.save(); } catch (error) { entry.message = was.message; entry.triedAt = was.triedAt; entry.device = was.device; throw error; }
    this.announce();
    return { ...entry.message };
  }

  discard(body: unknown): void {
    const entry = this.entry(object(body)["id"]);
    if (entry.message.state === "sending") throw busy();
    this.entries.delete(entry.message.id);
    // a discard that cannot be written is no discard: it would come back with the next start
    try { this.save(); } catch (error) { this.entries.set(entry.message.id, entry); throw error; }
    this.announce();
    if (entry.message.state === "uncertain") this.deps.released?.(entry.message.pane_id);
  }

  /**
   * The user's Send now, steering a working agent as a pending message's Send now does: to the session it was scheduled
   * for, or to what runs in the pane now once its row said that changed (#2951). Never while another of the pane's
   * messages may sit in its input. A refusal leaves the message as it was, with the reason.
   */
  async sendNow(body: unknown, device: string | null): Promise<Reply> {
    const entry = this.entry(object(body)["id"]);
    if (entry.message.state === "sending") throw busy();
    if (entry.message.state === "uncertain" || this.behind(entry, "uncertain")) throw uncertain();
    const before = entry.message.state;
    let identity = entry.identity;
    if (before === "held" && entry.message.error?.code === "pending_target_changed") {
      try { identity = await this.deps.identity(entry.message.pane_id); } catch (error) {
        const fault = faultOf(error);
        return { ok: false, ...fault };
      }
      if (this.entries.get(entry.message.id) !== entry || entry.message.state !== before) throw busy();
    }
    // sent to what runs now, under the pressing device, for this attempt alone: a refusal keeps the binding it had
    return await this.deliver(entry, false, identity, device);
  }

  /** an event of the pane (a turn ended, input became ready): its due messages are tried again */
  paneEvent(paneId: string): void {
    try { this.holdBehindUncertain(); } catch (error) { console.error(`scheduled messages: ${error instanceof Error ? error.message : String(error)}`); }
    for (const entry of this.entries.values()) {
      if (entry.message.pane_id === paneId && this.due(entry)) this.run(entry);
    }
  }

  /** herdr moved the pane under a new ID: its messages follow it */
  paneMoved(from: string, to: string): void {
    let moved = false;
    for (const entry of this.entries.values()) {
      if (entry.message.pane_id !== from) continue;
      entry.message.pane_id = to;
      moved = true;
      // what was learned about the pane under its old ID (an uncertain paste, an unconfirmed turn) does not follow it: every
      // message of a moved pane waits for the user's OK, never typed on its own
      if (entry.message.state === "scheduled") { entry.message.state = "held"; entry.message.error = { ...NEEDS_OK_MOVED }; }
    }
    // a move that cannot be written is logged: the terminals' own move after this hook still runs
    if (moved) try { this.commit(); } catch (error) { console.error(`scheduled messages: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * The pane ended or closed: its messages are held as gone, one left uncertain included, so every pane's list shows them to
   * read or discard (#2951). One on its way settles with its own outcome.
   */
  paneGone(paneId: string): void {
    let gone = false;
    for (const entry of this.entries.values()) {
      if (entry.message.pane_id !== paneId) continue;
      if (entry.message.state === "sending") { entry.gone = true; continue; }
      // one that may have gone already stays never-resendable: only Discard
      if (entry.message.state !== "uncertain") entry.message.state = "held";
      entry.message.error = { ...PANE_GONE };
      gone = true;
    }
    if (gone) try { this.commit(); } catch (error) { console.error(`scheduled messages: ${error instanceof Error ? error.message : String(error)}`); }
  }

  start(): void {
    this.stopped = false;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** due, and not behind another of its pane's that is on its way or may sit typed in its input */
  private due(entry: Entry): boolean {
    return !this.stopped && entry.message.state === "scheduled" && Date.parse(entry.message.send_at) <= this.now()
      && !this.behind(entry, "sending") && !this.behind(entry, "uncertain");
  }

  /** another message of the entry's pane is in `state` */
  private behind(entry: Entry, state: "sending" | "uncertain"): boolean {
    return [...this.entries.values()].some((other) => other !== entry && other.message.pane_id === entry.message.pane_id && other.message.state === state);
  }

  /**
   * A due message whose pane holds one of its own that may sit typed in its input is never typed on its own: it waits for the
   * user's OK (Send now or Discard), and every device's list says so (#2919). The pending queue's uncertain records are
   * checked at the send itself (server/core/pending.ts sendScheduled, needs_ok).
   */
  private holdBehindUncertain(): void {
    let held = false;
    for (const entry of this.entries.values()) {
      if (this.stopped || entry.message.state !== "scheduled" || Date.parse(entry.message.send_at) > this.now() || !this.behind(entry, "uncertain")) continue;
      entry.message.state = "held";
      entry.message.error = { ...NEEDS_OK_UNCERTAIN };
      held = true;
    }
    if (held) this.commit();
  }

  /** a delivery nothing awaits: a failure to keep its outcome is logged, never an unhandled rejection */
  private run(entry: Entry): void {
    this.deliver(entry, true).catch((error: unknown) => console.error(`scheduled message: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async deliver(entry: Entry, automatic: boolean, identity = entry.identity, device = entry.device): Promise<Reply> {
    const message = entry.message;
    const before = { state: message.state, error: message.error };
    const paneAtStart = message.pane_id;
    message.state = "sending";
    entry.triedAt = this.now();
    // claimed and kept before anything is typed: a PC that stops now never sends it again on its own. A claim that cannot be
    // written types nothing, and the message stays as it was
    try { this.save(); } catch (error) {
      message.state = before.state;
      this.arm();
      return { ok: false, ...faultOf(error) };
    }
    const authorize = (): void => {
      if (this.closed) throw new HerdrError("cancelled", "This PC's server is stopping");
      if (!this.deps.mayDrive(device)) throw new HerdrError("device_revoked", "The device that scheduled this message can no longer drive this PC");
    };
    let reply: Reply;
    try {
      authorize();
      reply = await this.deps.send(message.pane_id, message.text, identity, automatic, authorize);
    } catch (error) {
      reply = { ok: false, ...faultOf(error) };
    }
    if (reply.ok) {
      this.entries.delete(message.id);
    } else {
      const fault = { code: reply.code ?? "submit_failed", message: reply.message ?? "The message was not sent" };
      if (UNCERTAIN_CODES.has(fault.code)) { message.state = "uncertain"; this.deps.uncertain?.(message.pane_id); }
      // herdr moved the pane while this send ran: it waits for the user's OK, as every message of a moved pane does
      else if (message.pane_id !== paneAtStart) { message.state = "held"; message.error = { ...NEEDS_OK_MOVED }; this.commit(); return reply; }
      // Send now's refusal leaves it as it was; the timer's waits stay scheduled and say why
      else if (!automatic) message.state = before.state;
      else message.state = WAIT_CODES.has(fault.code) ? "scheduled" : "held";
      message.error = fault;
      // its pane ended while it was on its way: it is listed in every pane as gone, an uncertain one still never resent
      if (entry.gone) {
        if (message.state !== "uncertain") message.state = "held";
        message.error = { ...PANE_GONE };
      }
    }
    this.commit(automatic && !reply.ok && message.state === "scheduled" && sameFault(before.error, message.error));
    return reply;
  }

  /** saves, tells every connection (unless nothing they see changed), and sets the timer for the next due message */
  private commit(quiet = false): void {
    // the timer is set again whatever the write does: a failed save never strands the next due message
    try { this.save(); } finally { if (quiet) this.arm(); else this.announce(); }
  }

  /** tells every connection to read the list again, and sets the timer for the next due message */
  private announce(): void {
    this.deps.changed();
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped) return;
    const retry = this.deps.retryMs ?? RETRY_MS;
    let next = Infinity;
    for (const entry of this.entries.values()) {
      // one waiting behind its pane's message on its way or left uncertain sets no timer: that one's settling (or discard) arms again
      if (entry.message.state !== "scheduled" || this.behind(entry, "sending")) continue;
      const at = Date.parse(entry.message.send_at);
      next = Math.min(next, entry.triedAt !== undefined && at <= entry.triedAt ? entry.triedAt + retry : at);
    }
    if (next === Infinity) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // a hold that cannot be written costs this round, never the server: the next event or timer tries again
      try { this.holdBehindUncertain(); } catch (error) { console.error(`scheduled messages: ${error instanceof Error ? error.message : String(error)}`); }
      for (const entry of this.entries.values()) if (this.due(entry) && (entry.triedAt === undefined || entry.triedAt + retry <= this.now())) this.run(entry);
      this.arm();
    }, Math.min(MAX_TIMER_MS, Math.max(0, next - this.now())));
    this.timer.unref?.();
  }

  private entry(id: unknown): Entry {
    const entry = typeof id === "string" ? this.entries.get(id) : undefined;
    if (!entry) throw new ScheduledError("scheduled_not_found", "This scheduled message was sent or discarded", 404);
    return entry;
  }

  private text(value: unknown): string {
    if (typeof value !== "string") throw new ScheduledError("invalid_submit_text", "text is required");
    try { return this.deps.checkText(value); } catch (error) { throw new ScheduledError("invalid_submit_text", error instanceof Error ? error.message : String(error)); }
  }

  private sendAt(value: unknown): string {
    const at = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(at)) throw new ScheduledError("invalid_send_at", "send_at must be a date and time");
    // a minute's leeway for the device's clock against this PC's; anything older would only ever be sent at once
    if (at < this.now() - 60_000) throw new ScheduledError("invalid_send_at", "Pick a time that has not passed yet");
    if (at > this.now() + MAX_AHEAD_MS) throw new ScheduledError("invalid_send_at", "A message can be scheduled at most 30 days ahead");
    return new Date(at).toISOString();
  }

  private get path(): string | null {
    return this.deps.stateDir === undefined ? null : join(this.deps.stateDir, FILE);
  }

  private load(): Entry[] {
    const path = this.path;
    if (path === null) return [];
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      raw = null;
    }
    // a file that cannot be read as a list is kept beside the new one, never written over
    if (!Array.isArray(raw)) {
      const kept = `${path}.unreadable-${this.now()}`;
      try { renameSync(path, kept); console.error(`scheduled messages: ${path} could not be read; kept as ${kept}`); }
      catch (error) {
        // it costs the feature, never the server: nothing is scheduled or written over it until it is fixed
        this.unavailable = true;
        console.error(`scheduled messages: ${path} could not be read or set aside: ${error instanceof Error ? error.message : String(error)}`);
      }
      return [];
    }
    const entries: Entry[] = [];
    let unreadable = false;
    for (const item of raw as Entry[]) {
      const message = item?.message;
      if (!message || typeof message.id !== "string" || typeof message.pane_id !== "string" || typeof message.text !== "string"
        || !Number.isFinite(Date.parse(message.send_at)) || !item.identity || typeof item.identity.terminalId !== "string") { unreadable = true; continue; }
      // stopped in the middle of its send: it may have been typed, so it is the user's to check
      if (message.state === "sending") {
        message.state = "uncertain";
        message.error = { code: "submit_changed", message: "This PC's server stopped while sending this message. Check the terminal before sending it again." };
      }
      if (!["scheduled", "held", "uncertain"].includes(message.state)) { unreadable = true; continue; }
      // due already as the server starts: it is the user's to send, never typed unattended after a restart
      if (message.state === "scheduled" && Date.parse(message.send_at) <= this.now()) { message.state = "held"; message.error = { ...NEEDS_OK_RESTART }; }
      entries.push({ message, identity: item.identity, device: typeof item.device === "string" ? item.device : null });
    }
    // an entry it cannot read is kept in a copy beside the file before the next save writes over it (#2951)
    if (unreadable) {
      const kept = `${path}.unreadable-${this.now()}`;
      try { copyFileSync(path, kept); chmodSync(kept, 0o600); console.error(`scheduled messages: an entry of ${path} could not be read; the file is kept as ${kept}`); }
      catch (error) {
        this.unavailable = true;
        console.error(`scheduled messages: ${path} has an entry that could not be read, and it could not be copied aside: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return entries;
  }

  private save(): void {
    const path = this.path;
    if (path === null || this.unavailable) return;
    mkdirSync(this.deps.stateDir!, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.entries.values()].map(({ message, identity, device }) => ({ message, identity, device }))), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  }
}

const busy = (): ScheduledError => new ScheduledError("pending_busy", "This message is being sent", 409);
const uncertain = (): ScheduledError => new ScheduledError("pending_uncertain", "Check the terminal before sending this message again", 409);
const sameFault = (a: { code: string; message: string } | undefined, b: { code: string; message: string } | undefined): boolean =>
  a?.code === b?.code && a?.message === b?.message;
const faultOf = (error: unknown): { code: string; message: string } => ({
  code: error instanceof HerdrError ? error.code : "submit_failed",
  message: error instanceof Error ? error.message : String(error),
});
const object = (body: unknown): Record<string, unknown> => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ScheduledError("invalid_body", "A JSON object is required");
  return body as Record<string, unknown>;
};

/** The routes above; `readOnly`: a watching device, which neither reads nor changes them. */
export async function handleScheduledRequest(request: Request, pathname: string, scheduled: ScheduledMessages, access: { readOnly: boolean; device: string | null }): Promise<Response | null> {
  const action = pathname === "/api/scheduled" ? "" : pathname.startsWith("/api/scheduled/") ? pathname.slice("/api/scheduled/".length) : null;
  if (action === null || !["", "update", "discard", "send"].includes(action)) return null;
  setRequestRoute(pathname);
  if (access.readOnly) return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  // Windows never shows which program is in front, so nothing could be sent to the agent alone (the feature is not offered there)
  if (process.platform === "win32") return jsonResponse({ error: { code: "feature_unavailable", message: "Send later is not available on Windows" } }, 409);
  if (action === "" && request.method === "GET") return jsonResponse({ messages: scheduled.list() }, 200, { "cache-control": "no-store" });
  if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: action === "" ? "Use GET or POST" : "Use POST" } }, 405);
  let body: unknown;
  try { body = await request.json(); } catch { return jsonResponse({ error: { code: "invalid_body", message: "A JSON object is required" } }, 400); }
  try {
    if (action === "") return jsonResponse({ message: await scheduled.create(body, access.device) }, 201);
    if (action === "update") return jsonResponse({ message: scheduled.update(body, access.device) });
    if (action === "discard") { scheduled.discard(body); return jsonResponse({ ok: true }); }
    const reply = await scheduled.sendNow(body, access.device);
    return reply.ok ? jsonResponse({ ok: true }) : jsonResponse({ error: { code: reply.code, message: reply.message } }, 409);
  } catch (error) {
    if (error instanceof ScheduledError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    throw error;
  }
}

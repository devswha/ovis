import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import type { InboxDigest, InboxWidgetRow } from "../../shared/fork/inbox-widget.ts";
import { pushPaneTitle } from "../../shared/notify-policy.ts";
import type { PushPayload } from "../../shared/push.ts";
import { summaryOf, type PaneSummaries, type PaneSummary } from "../../shared/pane-summary.ts";
import { paneConversation } from "../conversation.ts";
import { jsonResponse } from "../http.ts";
import type { PaneStores } from "../pane-routes.ts";
import { writePrivateState } from "../private-state.ts";
import type { PushService } from "../push.ts";
import { forkAlertFriends, type FriendLookup } from "./friends.ts";

/**
 * The phone app's home-screen widget (app/android/ovis-widget): the agents of the alerts' own view
 * of every PC (the push service's seed, resync and status calls, watched here), sent as a quiet push
 * to each phone that placed one. Changes are coalesced to one push every MIN_GAP_MS, with a
 * HEARTBEAT_MS keepalive so the widget can tell a quiet PC from one it lost.
 */
const MIN_GAP_MS = 30_000;
const SETTLE_MS = 2_000;
const HEARTBEAT_MS = 10 * 60_000;
/** UTF-8 bytes before encryption, leaving 315 bytes of the relay's limit for Web Push overhead. */
const MAX_JSON_BYTES = 2_700;
const TOPIC = "ovis-inbox";
const STATE_FILE = "inbox-widget.json";
const ORDER: Readonly<Record<InboxWidgetRow["s"], number>> = { b: 0, d: 1, w: 2, i: 3 };
/** rows whose last words are read: more never fit one push */
const WORDS_ROWS = 20;
/** what one row's words may take: the widget shows a line or two */
const WORDS_MAX = 90;
const WORDS_READ_MS = 3_000;

/** Last words by pane id, for some of one PC's panes; null for a pane with none, a pane left out was not read. */
export type LastWords = (machineId: string, paneIds: readonly string[]) => Promise<Record<string, string | null> | null>;

interface Agent { row: Omit<InboxWidgetRow, "t">; at: number }

const short = (status: AgentStatus | undefined): InboxWidgetRow["s"] =>
  status === "blocked" ? "b" : status === "done" ? "d" : status === "working" ? "w" : "i";

/** Waiting on you first, the longest wait on top; then the latest finished, working, and idle. */
export function inboxOrder(rows: readonly InboxWidgetRow[]): InboxWidgetRow[] {
  return [...rows].sort((a, b) => ORDER[a.s] - ORDER[b.s] || (a.s === "b" ? a.t - b.t : b.t - a.t) || a.n.localeCompare(b.n));
}

/** A summary as the inbox row shows it (src/components/InboxList.tsx lastWords), on one short line. */
export function shownWords(summary: PaneSummary | null): string | null {
  if (!summary) return null;
  const text = summary.text.replace(/\*\*|__|`/g, "").replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  const said = summary.role === "user" ? `You: ${text}` : text;
  return said.length > WORDS_MAX ? `${[...said].slice(0, WORDS_MAX - 1).join("").trimEnd()}…` : said;
}

/**
 * The inbox's own summary read (/api/pane/summary): this PC's panes from their conversations, another
 * PC's from that PC, through its endpoint as the PC proxy reaches it.
 */
export function paneLastWords(stores: PaneStores, endpoint: (machineId: string) => { url: string; token: string } | undefined): LastWords {
  return async (machineId, paneIds) => {
    if (machineId === "local") {
      const words: Record<string, string | null> = {};
      await Promise.all(paneIds.map(async (paneId) => {
        const read = paneConversation(paneId, stores.codexHome, { prompts: 1 }, stores.devinDbPath, stores.opencodeDb, stores.hermesHome, stores.grokHome, stores.museData)
          .then((conversation) => shownWords(summaryOf(conversation.turns)));
        const late = new Promise<undefined>((resolve) => AbortSignal.timeout(WORDS_READ_MS).addEventListener("abort", () => resolve(undefined)));
        const said = await Promise.race([read, late]).catch(() => undefined);
        if (said !== undefined) words[paneId] = said;
      }));
      return words;
    }
    const pc = endpoint(machineId);
    if (!pc) return null;
    const query = new URLSearchParams(paneIds.map((paneId) => ["pane_id", paneId]));
    try {
      const response = await fetch(`${pc.url}/api/pane/summary?${query.toString()}`, { headers: { authorization: `Bearer ${pc.token}` }, redirect: "error", signal: AbortSignal.timeout(WORDS_READ_MS) });
      if (!response.ok) return null;
      const { summaries } = await response.json() as PaneSummaries;
      return Object.fromEntries(Object.entries(summaries ?? {}).map(([paneId, summary]) => [paneId, shownWords(summary)]));
    } catch {
      return null;
    }
  };
}

/** The digest for one endpoint, its rows cut from the end until it fits one push. */
export function inboxMessage(rows: readonly InboxWidgetRow[], endpoint: string, at: number, serverId?: string): PushPayload & { inbox: InboxDigest } {
  const kept = [...rows];
  for (;;) {
    const inbox: InboxDigest = { at, endpoint, ...(serverId ? { server_id: serverId } : {}), rows: kept, more: rows.length - kept.length };
    const message = { pane_id: null, title: "", body: "", tag: TOPIC, inbox };
    if (kept.length === 0 || Buffer.byteLength(JSON.stringify(message)) <= MAX_JSON_BYTES) return message;
    kept.pop();
  }
}

export class InboxWidget {
  private readonly agents = new Map<string, Agent>();
  private readonly endpoints: Set<string>;
  /** the friend each row wears, looked up with its PC's panes as the alerts do, so it is the inbox's: its project's */
  private readonly friends: ReturnType<typeof forkAlertFriends>;
  /** each row's last words, with the status and time they were read at */
  private readonly words = new Map<string, { stamp: string; text: string | null }>();
  private timer?: { id: ReturnType<typeof setTimeout>; at: number };
  private readonly deliveries = new Map<string, { at: number; rows: string | undefined }>();
  private readonly pending = new Set<string>();
  private readonly unchecked = new Set<string>();
  private readonly startedAt: number;
  private lastChecked: number;
  private sending = false;
  private stopped = false;
  private lastRows = "[]";
  private snapshot: { rows: InboxWidgetRow[]; rendered: string } = { rows: [], rendered: "[]" };

  constructor(private readonly push: PushService, private readonly options: { stateDir: string; friendOf?: FriendLookup; serverId?: () => string | undefined; now?: () => number; lastWords?: LastWords }) {
    this.friends = forkAlertFriends(options.friendOf);
    let saved: unknown = null;
    try { saved = JSON.parse(readFileSync(join(options.stateDir, STATE_FILE), "utf8")); } catch { }
    const list = (saved as { endpoints?: unknown } | null)?.endpoints;
    this.endpoints = new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
    this.startedAt = this.lastChecked = this.now();
    this.changed();
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  /** Every agent pane of one PC, as the alerts see it; a helper folds under its agent, as in the inbox. */
  panes(panes: readonly HerdrPane[], machineId = "local"): void {
    this.friends.seed(panes, machineId);
    const seen = new Set<string>();
    for (const pane of panes) {
      if (!pane.agent || pane.parent_pane_id) continue;
      const key = `${machineId}\u0000${pane.pane_id}`;
      seen.add(key);
      const friend = this.friends.friendOf(machineId, pane.pane_id);
      const row: Agent["row"] = { p: pane.pane_id, ...(machineId === "local" ? {} : { m: machineId }), ...(pane.workspace_id ? { w: pane.workspace_id } : {}), n: pushPaneTitle(pane), ...(friend ? { f: friend } : {}), s: short(pane.agent_status) };
      const held = this.agents.get(key);
      this.agents.set(key, { row, at: held && held.row.s === row.s ? held.at : this.now() });
    }
    for (const key of this.agents.keys()) if (key.startsWith(`${machineId}\u0000`) && !seen.has(key)) this.agents.delete(key);
    this.changed();
  }

  status(paneId: string, status: AgentStatus, machineId = "local"): void {
    const agent = this.agents.get(`${machineId}\u0000${paneId}`);
    if (!agent || agent.row.s === short(status)) return;
    agent.row = { ...agent.row, s: short(status) };
    agent.at = this.now();
    this.changed();
  }

  ended(paneId: string, machineId = "local"): void {
    if (this.agents.delete(`${machineId}\u0000${paneId}`)) this.changed();
  }

  /** A newly placed widget gets the agents at once; reporting it again need not refresh it. */
  place(endpoint: string, placed: boolean): void {
    if (placed !== this.endpoints.has(endpoint)) {
      if (placed) this.endpoints.add(endpoint);
      else {
        this.endpoints.delete(endpoint);
        this.deliveries.delete(endpoint);
        this.unchecked.delete(endpoint);
      }
      this.save();
    }
    if (placed && !this.deliveries.has(endpoint)) void this.sendTo([endpoint]);
    else this.changed();
  }

  rows(): InboxWidgetRow[] {
    return inboxOrder([...this.agents.values()].map(({ row, at }) => ({ ...row, t: Math.floor(at / 1000) })));
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.pending.clear();
    this.unchecked.clear();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer.id);
    this.timer = undefined;
  }

  private changed(): void {
    if (this.stopped || this.sending || this.endpoints.size === 0) return this.clearTimer();
    const now = this.now();
    const rows = this.rows();
    // Conversation change events only exist for panes a client is watching. With just the widget
    // open, check the working rows that can fit, at most once per push interval.
    const working = this.options.lastWords && rows.slice(0, WORDS_ROWS).some((row) => row.s === "w");
    const refreshAt = JSON.stringify(rows) !== this.lastRows
      ? Math.min(now + SETTLE_MS, this.timer?.at ?? Infinity)
      : working ? this.lastChecked + MIN_GAP_MS : Infinity;
    let at = Infinity;
    for (const endpoint of this.endpoints) {
      const last = this.deliveries.get(endpoint)?.at;
      const heartbeatAt = (last ?? this.startedAt) + HEARTBEAT_MS;
      const due = Math.min(refreshAt, heartbeatAt, this.unchecked.has(endpoint) ? now : Infinity);
      at = Math.min(at, Math.max((last ?? -Infinity) + MIN_GAP_MS, due));
    }
    if (this.timer?.at === at) return;
    this.clearTimer();
    const id = setTimeout(() => { this.timer = undefined; void this.sendTo([...this.endpoints]); }, Math.max(0, at - now));
    this.timer = { id, at };
    id.unref?.();
  }

  /** The rows with their last words: read again for a row whose status moved, and for a working one, which goes on talking. */
  private async withWords(rows: InboxWidgetRow[]): Promise<InboxWidgetRow[]> {
    const read = this.options.lastWords;
    if (!read) return rows;
    const keyOf = (row: InboxWidgetRow) => `${row.m ?? "local"}\u0000${row.p}`;
    const stampOf = (row: InboxWidgetRow) => `${row.s}:${row.t}`;
    const wanted = new Map<string, InboxWidgetRow[]>();
    for (const row of rows.slice(0, WORDS_ROWS)) {
      const held = this.words.get(keyOf(row));
      if (held && held.stamp === stampOf(row) && row.s !== "w") continue;
      const machine = row.m ?? "local";
      wanted.set(machine, [...wanted.get(machine) ?? [], row]);
    }
    await Promise.all([...wanted].map(async ([machine, asked]) => {
      const words = await read(machine, asked.map((row) => row.p)).catch(() => null);
      for (const row of asked) if (words && row.p in words) this.words.set(keyOf(row), { stamp: stampOf(row), text: words[row.p] ?? null });
    }));
    const shown = new Set(rows.map(keyOf));
    for (const key of this.words.keys()) if (!shown.has(key)) this.words.delete(key);
    return rows.map((row) => {
      const text = this.words.get(keyOf(row))?.text;
      return text ? { ...row, d: text } : row;
    });
  }

  private async sendTo(endpoints: readonly string[]): Promise<void> {
    if (this.stopped) return;
    for (const endpoint of endpoints) this.pending.add(endpoint);
    if (this.sending) return;
    this.clearTimer();
    this.sending = true;
    try {
      // Read and deliver one snapshot at a time so a slow read can't publish older status last.
      while (this.pending.size > 0) {
        const batch = [...this.pending].filter((endpoint) => this.endpoints.has(endpoint));
        this.pending.clear();
        if (batch.length > 0) await this.sendBatch(batch);
      }
    } finally {
      this.sending = false;
      this.changed();
    }
  }

  private async sendBatch(endpoints: readonly string[]): Promise<void> {
    const bare = this.rows();
    const signature = JSON.stringify(bare);
    if (signature !== this.lastRows || this.now() - this.lastChecked >= MIN_GAP_MS) {
      this.lastRows = signature;
      const rows = await this.withWords(bare);
      const rendered = JSON.stringify(rows);
      // Placement sends to just one endpoint; the others still need to compare this snapshot.
      if (rendered !== this.snapshot.rendered) {
        for (const endpoint of this.endpoints) this.unchecked.add(endpoint);
      }
      this.snapshot = { rows, rendered };
      this.lastChecked = this.now();
    }
    const now = this.now();
    await Promise.all(endpoints.map((endpoint) => this.deliver(endpoint, this.snapshot.rows, now)));
  }

  private async deliver(endpoint: string, rows: readonly InboxWidgetRow[], now: number): Promise<void> {
    if (this.stopped || !this.endpoints.has(endpoint)) return;
    const previous = this.deliveries.get(endpoint);
    if (previous && now - previous.at < MIN_GAP_MS) return;
    this.unchecked.delete(endpoint);
    const message = inboxMessage(rows, endpoint, Math.floor(now / 1000), this.options.serverId?.());
    const shown = JSON.stringify([message.inbox.rows, message.inbox.more]);
    if (previous?.rows === shown && now - previous.at < HEARTBEAT_MS) return;
    const attempt = { at: now, rows: previous?.rows };
    this.deliveries.set(endpoint, attempt);
    const delivery = await this.push.sendQuiet(endpoint, message, TOPIC).catch(() => undefined);
    if (this.deliveries.get(endpoint) !== attempt) return;
    if (delivery?.ok) attempt.rows = shown;
    // An endpoint this PC no longer pushes to has no widget to keep.
    if (delivery === null || (delivery && !delivery.ok && delivery.gone)) this.place(endpoint, false);
  }

  private save(): void {
    try { writePrivateState(join(this.options.stateDir, STATE_FILE), { endpoints: [...this.endpoints] }); } catch { }
  }
}

const widgets = new WeakMap<PushService, InboxWidget>();

/** The push service, watched for the widget: the one hook in server/core/status.ts. */
export function watchInbox(push: PushService, options: ConstructorParameters<typeof InboxWidget>[1]): PushService {
  const widget = new InboxWidget(push, options);
  const watched: PushService = {
    ...push,
    seed(panes, machineId, machineName, serverId) { push.seed(panes, machineId, machineName, serverId); widget.panes(panes, machineId); },
    resync(panes, newer, machineId) { push.resync(panes, newer, machineId); widget.panes(panes, machineId); },
    onStatus(paneId, status, machineId) { widget.status(paneId, status, machineId); return push.onStatus(paneId, status, machineId); },
    onEnded(paneId, machineId) { widget.ended(paneId, machineId); return push.onEnded(paneId, machineId); },
  };
  widgets.set(watched, widget);
  return watched;
}

export function stopInbox(push: PushService): void {
  widgets.get(push)?.stop();
}

/** POST /api/fork/inbox-widget `{ subscription, placed }`: only the phone holding the subscription's keys places one. */
export async function handleInboxWidget(request: Request, push: PushService, owner: string | null): Promise<Response> {
  const widget = widgets.get(push);
  if (!widget) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: `${request.method} is not supported` } }, 405);
  let body: { subscription?: unknown; placed?: unknown } = {};
  try { body = await request.json() as typeof body; } catch { }
  const subscription = push.parse(body.subscription);
  if (!subscription || typeof body.placed !== "boolean") return jsonResponse({ error: { code: "invalid_request", message: "subscription and placed are required" } }, 400);
  if (!push.status(subscription, owner)?.registered) return jsonResponse({ error: { code: "not_found", message: "this subscription is not this device's" } }, 404);
  widget.place(subscription.endpoint, body.placed);
  return jsonResponse({ ok: true });
}

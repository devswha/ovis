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
import type { FriendLookup } from "./friends.ts";

/**
 * The phone app's home-screen widget (app/android/ovis-widget): the agents of the alerts' own view
 * of every PC (the push service's seed, resync and status calls, watched here), sent as a quiet push
 * to each phone that placed one. Coalesced to one push every MIN_GAP_MS, and sent again every
 * HEARTBEAT_MS so the widget can tell a quiet PC from one it lost; the push relay takes 60 a window.
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
export function inboxMessage(rows: readonly InboxWidgetRow[], endpoint: string, at: number, serverId?: string): PushPayload {
  const kept = [...rows];
  for (;;) {
    const inbox: InboxDigest = { at, endpoint, ...(serverId ? { server_id: serverId } : {}), rows: kept, more: rows.length - kept.length };
    const message: PushPayload = { pane_id: null, title: "", body: "", tag: TOPIC, inbox };
    if (kept.length === 0 || Buffer.byteLength(JSON.stringify(message)) <= MAX_JSON_BYTES) return message;
    kept.pop();
  }
}

export class InboxWidget {
  private readonly agents = new Map<string, Agent>();
  private readonly endpoints: Set<string>;
  /** each row's last words, with the status and time they were read at */
  private readonly words = new Map<string, { stamp: string; text: string | null }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Set<string>();
  private sending = false;
  private lastSent = 0;
  private lastRows = "";

  constructor(private readonly push: PushService, private readonly options: { stateDir: string; friendOf?: FriendLookup; serverId?: () => string | undefined; now?: () => number; lastWords?: LastWords }) {
    let saved: unknown = null;
    try { saved = JSON.parse(readFileSync(join(options.stateDir, STATE_FILE), "utf8")); } catch { }
    const list = (saved as { endpoints?: unknown } | null)?.endpoints;
    this.endpoints = new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
    this.beat();
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  /** Every agent pane of one PC, as the alerts see it; a helper folds under its agent, as in the inbox. */
  panes(panes: readonly HerdrPane[], machineId = "local"): void {
    const seen = new Set<string>();
    for (const pane of panes) {
      if (!pane.agent || pane.parent_pane_id) continue;
      const key = `${machineId}\u0000${pane.pane_id}`;
      seen.add(key);
      const friend = this.options.friendOf?.(machineId, pane.pane_id);
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

  /** A phone placed (or removed) its widget; a placed one gets the agents at once. */
  place(endpoint: string, placed: boolean): void {
    if (placed === this.endpoints.has(endpoint)) { if (placed) void this.sendTo([endpoint]); return; }
    if (placed) this.endpoints.add(endpoint); else this.endpoints.delete(endpoint);
    this.save();
    this.beat();
    if (placed) void this.sendTo([endpoint]);
  }

  rows(): InboxWidgetRow[] {
    return inboxOrder([...this.agents.values()].map(({ row, at }) => ({ ...row, t: Math.floor(at / 1000) })));
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = this.heartbeat = null;
    this.pending.clear();
  }

  private changed(): void {
    if (this.endpoints.size === 0 || this.timer || JSON.stringify(this.rows()) === this.lastRows) return;
    this.timer = setTimeout(() => { this.timer = null; void this.sendTo([...this.endpoints]); }, Math.max(SETTLE_MS, this.lastSent + MIN_GAP_MS - this.now()));
    this.timer.unref?.();
  }

  private beat(): void {
    if (this.endpoints.size > 0 && !this.heartbeat) {
      this.heartbeat = setInterval(() => void this.sendTo([...this.endpoints]), HEARTBEAT_MS);
      this.heartbeat.unref?.();
    } else if (this.endpoints.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
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
    for (const endpoint of endpoints) this.pending.add(endpoint);
    if (this.sending) return;
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
    }
  }

  private async sendBatch(endpoints: readonly string[]): Promise<void> {
    const bare = this.rows();
    this.lastRows = JSON.stringify(bare);
    const rows = await this.withWords(bare);
    this.lastSent = this.now();
    const at = Math.floor(this.lastSent / 1000);
    await Promise.all(endpoints.map(async (endpoint) => {
      if (!this.endpoints.has(endpoint)) return;
      const delivery = await this.push.sendQuiet(endpoint, inboxMessage(rows, endpoint, at, this.options.serverId?.()), TOPIC).catch(() => undefined);
      // an endpoint this PC no longer pushes to has no widget to keep
      if (delivery === null || (delivery && !delivery.ok && delivery.gone)) this.place(endpoint, false);
    }));
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

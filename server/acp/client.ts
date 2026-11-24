/**
 * Ovis's client of one ACP keeper (crates/acp-keeper): it reads the keeper's numbered log on `<root>/acp.sock` and keeps
 * what Ovis needs of it (the session, the permission requests nobody answered yet, the turn), and sends requests and
 * answers. The keeper is the agent's only ACP client and every client of the keeper sees every row, so this client
 * rebuilds its state from the log alone: a first attach replays it from the start, a reconnect from the row after the
 * last one it read. Its answer to a permission request is one of many a keeper may get: the keeper's `_keeper/resolved`
 * note names the client whose answer went to the agent.
 */
import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { processAlive } from "../process-start.ts";

/** One option of a permission request, as the agent offered it. */
export interface AcpOption {
  optionId: string;
  name: string;
  kind: string;
}

/** A `session/request_permission` the agent asked and nobody answered yet. */
export interface AcpApproval {
  /** the keeper's id for it (`agent-N`), which an answer names */
  keeperId: string;
  seq: number;
  /** the request as the keeper archived it */
  raw: string;
  sessionId: string | null;
  toolCall: { title: string | null; kind: string | null; rawInput: unknown; content: unknown };
  options: AcpOption[];
}

/** The last `session/prompt` any client sent: running until the agent answers it. */
export interface AcpTurn {
  running: boolean;
  stopReason: string | null;
  /** the turn's `agent_message_chunk` text */
  text: string;
  /** the agent's error, when it answered the prompt with one */
  error: string | null;
}

/** won: this client's answer went to the agent; lost: another's did; gone: the agent can no longer take one. */
export type AnswerOutcome = "won" | "lost" | "gone";

export class KeeperRequestError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "KeeperRequestError";
  }
}

export class KeeperDisconnected extends Error {
  constructor() {
    super("the connection to the ACP keeper ended");
    this.name = "KeeperDisconnected";
  }
}

export interface KeeperClientOptions {
  /** how the socket is opened (default node:net) */
  connect?: (path: string) => Socket;
}

type Row = { seq: number; dir: string; client?: number; raw: string };
type Message = { id?: unknown; method?: unknown; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code?: unknown; message?: unknown } };
interface InFlight { resolve: (result: unknown) => void; reject: (error: Error) => void }
interface Answering { by: string; resolve: (outcome: AnswerOutcome) => void; timer: ReturnType<typeof setTimeout> }

/** How long an answer waits for the keeper's note on it: past it the answer counts as gone. */
const ANSWER_MS = 10_000;
const BACKOFF_MS = [100, 250, 500, 1_000, 2_000, 5_000] as const;

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === "string" ? value : null;

function parseOptions(value: unknown): AcpOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const option = record(entry);
    const [optionId, name, kind] = [text(option?.["optionId"]), text(option?.["name"]), text(option?.["kind"])];
    return optionId !== null && name !== null && kind !== null ? [{ optionId, name, kind }] : [];
  });
}

/** Whether the keeper `root`'s process.json names still runs. */
export function keeperRunning(root: string): boolean {
  let pid: unknown;
  try {
    pid = record(JSON.parse(readFileSync(join(root, "process.json"), "utf8")))?.["keeper"];
  } catch {
    return false;
  }
  return typeof pid === "number" && processAlive(pid);
}

export class KeeperClient {
  session: string | null = null;
  turn: AcpTurn | null = null;
  agentGone = false;
  /** the keeper ended and no connection could be made again */
  keeperGone = false;
  private lastSeq = 0;
  private client: number | null = null;
  private socket: Socket | null = null;
  private buffer = "";
  private closed = false;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private readonly approvals = new Map<string, AcpApproval>();
  /** the client (`client-N`) whose answer went to the agent, by request */
  private readonly resolvedBy = new Map<string, string>();
  private readonly answering = new Map<string, Answering>();
  private readonly inFlight = new Map<number, InFlight>();
  /** the keeper's ids of the `session/prompt` requests the agent has not answered yet */
  private readonly prompts = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly waiting = new Set<() => void>();
  private readonly connectTo: (path: string) => Socket;

  constructor(readonly root: string, options: KeeperClientOptions = {}) {
    this.connectTo = options.connect ?? ((path) => createConnection(path));
    this.open();
  }

  /** Whether the replay is through and live rows follow. */
  get connected(): boolean {
    return this.client !== null;
  }

  /** Resolves once the log is replayed (the keeper's watermark came); rejects once the client is closed or the keeper is gone. */
  ready(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.closed || this.keeperGone) return Promise.reject(new KeeperDisconnected());
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const check = () => {
      if (this.connected) resolve();
      else if (this.closed || this.keeperGone) reject(new KeeperDisconnected());
      else return;
      this.waiting.delete(check);
    };
    this.waiting.add(check);
    return promise;
  }

  /** Called after each batch of rows that may have changed the session, the requests or the turn. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The permission requests nobody answered yet, oldest first. */
  pending(): AcpApproval[] {
    return [...this.approvals.values()].sort((a, b) => a.seq - b.seq);
  }

  /** A request to the agent through the keeper. Rejects on an error answer, and when the connection ends first. */
  async request(method: string, params: unknown): Promise<unknown> {
    await this.ready();
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.inFlight.set(id, { resolve, reject });
    this.write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  /** A notification to the agent through the keeper (`session/cancel`). Dropped when no connection is up. */
  notify(method: string, params: unknown): void {
    if (this.connected) this.write({ jsonrpc: "2.0", method, params });
  }

  /**
   * Answers the permission request `keeperId` with `optionId`, one of its options. The keeper's note on it decides: this
   * client's answer went to the agent (won), another client's did (lost), or the agent can no longer take one (gone).
   */
  async answer(keeperId: string, optionId: string): Promise<AnswerOutcome> {
    const asked = this.approvals.get(keeperId);
    if (asked === undefined || this.answering.has(keeperId)) return this.resolvedBy.has(keeperId) || this.answering.has(keeperId) ? "lost" : "gone";
    if (!asked.options.some((option) => option.optionId === optionId)) return "gone";
    try {
      await this.ready();
    } catch {
      return "gone";
    }
    const { promise, resolve } = Promise.withResolvers<AnswerOutcome>();
    const timer = setTimeout(() => this.settle(keeperId, "gone"), ANSWER_MS);
    this.answering.set(keeperId, { by: `client-${this.client}`, resolve, timer });
    this.write({ jsonrpc: "2.0", id: keeperId, result: { outcome: { outcome: "selected", optionId } } });
    return promise;
  }

  /** Ends the connection for good: requests in flight are refused, answers waiting count as gone. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.retry !== null) clearTimeout(this.retry);
    // ended, not destroyed: a last notification (a stop's session/cancel) still goes out
    this.socket?.end();
    this.dropped();
    for (const id of [...this.answering.keys()]) this.settle(id, "gone");
    this.changed();
  }

  private write(message: unknown): void {
    this.socket?.write(`${JSON.stringify(message)}\n`);
  }

  private open(): void {
    const socket = this.connectTo(join(this.root, "acp.sock"));
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ replay: this.lastSeq + 1 })}\n`));
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.dropped();
      if (!this.closed) this.reconnect();
    });
  }

  /** The connection ended: this connection's requests get no answer now (the keeper answers the connection that sent them). */
  private dropped(): void {
    this.client = null;
    for (const call of this.inFlight.values()) call.reject(new KeeperDisconnected());
    this.inFlight.clear();
  }

  private reconnect(): void {
    if (!existsSync(join(this.root, "acp.sock")) && !keeperRunning(this.root)) {
      this.keeperGone = true;
      for (const id of [...this.answering.keys()]) this.settle(id, "gone");
      this.changed();
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.closed) this.open();
    }, delay);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let changed = false;
    for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      changed = this.line(line) || changed;
    }
    if (changed) this.changed();
  }

  private changed(): void {
    for (const check of [...this.waiting]) check();
    for (const listener of [...this.listeners]) listener();
  }

  /** One line of the stream: a row, or the watermark. Whether it changed what this client keeps. */
  private line(line: string): boolean {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return false; }
    const object = record(parsed);
    if (object === null) return false;
    if (typeof object["through"] === "number" && typeof object["client"] === "number") {
      this.client = object["client"];
      this.attempt = 0;
      return true;
    }
    const { seq, dir, raw } = object;
    if (typeof seq !== "number" || typeof dir !== "string" || typeof raw !== "string") return false;
    if (seq <= this.lastSeq) return false;
    this.lastSeq = seq;
    let message: Message;
    try { message = JSON.parse(raw) as Message; } catch { return false; }
    if (record(message) === null) return false;
    return this.row({ seq, dir, raw, ...(typeof object["client"] === "number" ? { client: object["client"] } : {}) }, message);
  }

  private row(row: Row, message: Message): boolean {
    const method = text(message.method);
    const params = record(message.params) ?? {};
    switch (row.dir) {
      case "to-client":
        if (row.client === this.client && this.client !== null && method === null) this.answered(message);
        return false;
      case "to-agent":
        if (method === "session/prompt" && typeof message.id === "string") {
          this.prompts.add(message.id);
          this.turn = { running: true, stopReason: null, text: "", error: null };
          return true;
        }
        return false;
      case "from-agent":
        return this.fromAgent(row, message, method, params);
      case "keeper":
        return this.note(method, params);
      default:
        return false;
    }
  }

  private answered(message: Message): void {
    const id = typeof message.id === "number" ? message.id : null;
    const call = id === null ? undefined : this.inFlight.get(id);
    if (call === undefined) return;
    this.inFlight.delete(id!);
    const error = record(message.error);
    if (error !== null) call.reject(new KeeperRequestError(typeof error["code"] === "number" ? error["code"] : 0, text(error["message"]) ?? "error"));
    else call.resolve(message.result);
  }

  private fromAgent(row: Row, message: Message, method: string | null, params: Record<string, unknown>): boolean {
    if (method === "session/request_permission" && typeof message.id === "string") {
      const toolCall = record(params["toolCall"]) ?? {};
      this.approvals.set(message.id, {
        keeperId: message.id,
        seq: row.seq,
        raw: row.raw,
        sessionId: text(params["sessionId"]),
        toolCall: { title: text(toolCall["title"]), kind: text(toolCall["kind"]), rawInput: toolCall["rawInput"] ?? null, content: toolCall["content"] ?? null },
        options: parseOptions(params["options"]),
      });
      return true;
    }
    if (method === "session/update") {
      const update = record(params["update"]);
      const chunk = text(record(update?.["content"])?.["text"]);
      if (update?.["sessionUpdate"] !== "agent_message_chunk" || chunk === null || this.turn === null || !this.turn.running) return false;
      this.turn = { ...this.turn, text: this.turn.text + chunk };
      return true;
    }
    if (method !== null || typeof message.id !== "string" || !this.prompts.delete(message.id)) return false;
    const error = record(message.error);
    const stopReason = text(record(message.result)?.["stopReason"]);
    this.turn = { running: this.prompts.size > 0, stopReason, text: this.turn?.text ?? "", error: error === null ? null : text(error["message"]) ?? "error" };
    return true;
  }

  private note(method: string | null, params: Record<string, unknown>): boolean {
    const id = text(params["id"]);
    switch (method) {
      case "_keeper/session":
        this.session = text(params["sessionId"]) || null;
        this.agentGone = false;
        return true;
      case "_keeper/agent_exit":
        this.agentGone = true;
        this.prompts.clear();
        if (this.turn?.running) this.turn = { ...this.turn, running: false };
        return true;
      case "_keeper/resolved": {
        if (id === null) return false;
        const by = text(params["by"]) ?? "";
        this.resolvedBy.set(id, by);
        this.approvals.delete(id);
        this.settle(id, by === this.answering.get(id)?.by ? "won" : "lost");
        return true;
      }
      case "_keeper/dropped":
        if (id !== null && text(params["by"]) === this.answering.get(id)?.by) this.settle(id, this.resolvedBy.has(id) ? "lost" : "gone");
        return false;
      case "_keeper/expired":
        if (id === null) return false;
        this.approvals.delete(id);
        this.settle(id, "gone");
        return true;
      default:
        return false;
    }
  }

  private settle(id: string, outcome: AnswerOutcome): void {
    const waiting = this.answering.get(id);
    if (waiting === undefined) return;
    this.answering.delete(id);
    clearTimeout(waiting.timer);
    waiting.resolve(outcome);
  }
}

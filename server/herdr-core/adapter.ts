import { existsSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket } from "bun";
import { LINE_BYTES, makeLineReader } from "../herdr/client.ts";
import { type HcConnection, HcError } from "./connection.ts";
import { agentInfoOf, agentStatusOf, buildSnapshot, type HcTerminal, hcKeyName, HERDR_PROTOCOL, isRecord, keyBytes, LAYOUT_DOC, processInfoOf } from "./snapshot.ts";
import type { SessionSnapshot } from "../../shared/herdr-api.generated.ts";

/**
 * herdr's socket API, answered from herdr-core. The server talks to herdr through one client
 * (server/herdr/client.ts) whose callers read herdr's session snapshot, panes, screens and status
 * events; this adapter listens where that client connects (HERDR_SOCKET) and answers the methods a
 * terminal view needs from hc, so none of those callers learns a second runtime:
 *
 * - `ping`, `session.snapshot`, `pane.get`, `agent.get`, `pane.process_info` and `pane.read` from
 *   hc's terminal records, the app's layout document and `terminal.read`;
 * - `pane.send_text` as bytes typed into the terminal, over a short attach stream at the
 *   terminal's own grid (hc has no other way to type raw bytes, and a viewer at the current size
 *   resizes nothing);
 * - `pane.send_keys` as those keys' bytes in the same way, or hc's `terminal.keys` for a key that
 *   only hc can encode for the program's keyboard mode;
 * - `agent.prompt` as hc's `terminal.send` (paste and Enter, refused while the program is blocked);
 * - `events.subscribe` from hc's own event stream: status changes per pane, and terminal and layout
 *   changes as herdr's lifecycle events.
 *
 * Everything else (workspaces, tabs, splits, focus, worktrees, plugins) belongs to the Herdr app's
 * window and is refused as `unsupported`. The live terminal itself is `hc attach`, which the server
 * runs in place of `herdr terminal attach` (server/core/terminal-process.ts).
 *
 * As herdr does, each request has a connection of its own that ends with its answer; only an
 * events subscription stays open.
 */

interface Request { id: string; method: string; params: Record<string, unknown> }
type Reply = { result: unknown } | { error: { code: string; message: string } };

class AdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Ovis's subscription types that are status, not structure. */
const STATUS_EVENT = "pane.agent_status_changed";
const NOT_STRUCTURE = new Set([STATUS_EVENT, "pane.focused", "pane.output_matched"]);
/** A status or layout notification must fit in 4 MiB, even across hc frames. */
const EVENT_LINE_BYTES = 4 * 1024 * 1024;

interface ConnectionState {
  read: (chunk: Uint8Array) => void;
  /** bytes the kernel did not take yet */
  queue: Uint8Array[];
  /** end once the queue is out */
  ending: boolean;
  /** an events subscription this connection holds on hc */
  unsubscribe: (() => void) | null;
  closed: boolean;
}

export interface HerdrCoreAdapter {
  /** where it listens: the server's HERDR_SOCKET */
  socketPath: string;
  stop: () => void;
}

export async function startHerdrCoreAdapter(hc: HcConnection, socketPath: string): Promise<HerdrCoreAdapter> {
  if (existsSync(socketPath)) {
    const live = await new Promise<boolean>((resolve, reject) => {
      const probe = createConnection(socketPath);
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
        else reject(error);
      });
    });
    if (live) throw new Error("Another Ovis owns this state directory: the herdr-core socket is still listening");
    rmSync(socketPath, { force: true });
  }
  const answers = createAnswers(hc);
  const listener = Bun.listen<ConnectionState>({
    unix: socketPath,
    socket: {
      open(socket) {
        let first = true;
        socket.data = {
          queue: [],
          ending: false,
          unsubscribe: null,
          closed: false,
          read: makeLineReader(LINE_BYTES, (line) => {
            // one request per connection, as herdr reads it
            if (!first) return;
            first = false;
            const request = parseRequest(line);
            if (!request) { send(socket, `${JSON.stringify({ id: "", error: { code: "bad_frame", message: "not a herdr request" } })}\n`, true); return; }
            if (request.method === "events.subscribe") { void subscribe(hc, socket, request); return; }
            void answers(request).then((reply) => send(socket, `${JSON.stringify({ id: request.id, ...reply })}\n`, true));
          }, () => socket.end()),
        };
      },
      data(socket, chunk) {
        socket.data.read(chunk);
      },
      drain(socket) {
        flush(socket);
      },
      close(socket) {
        socket.data.closed = true;
        socket.data.unsubscribe?.();
      },
      error(socket) {
        socket.data.closed = true;
        socket.data.unsubscribe?.();
      },
    },
  });
  return {
    socketPath,
    stop: () => {
      listener.stop(true);
      rmSync(socketPath, { force: true });
    },
  };
}

function parseRequest(line: string): Request | null {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(frame) || typeof frame["id"] !== "string" || typeof frame["method"] !== "string") return null;
  return { id: frame["id"], method: frame["method"], params: isRecord(frame["params"]) ? frame["params"] : {} };
}

function send(socket: Socket<ConnectionState>, text: string, end = false): void {
  const state = socket.data;
  if (state.closed) return;
  state.queue.push(new TextEncoder().encode(text));
  if (end) state.ending = true;
  flush(socket);
}

function flush(socket: Socket<ConnectionState>): void {
  const state = socket.data;
  while (state.queue.length > 0) {
    const next = state.queue[0]!;
    const written = socket.write(next);
    if (written < next.length) {
      state.queue[0] = next.subarray(Math.max(0, written));
      return;
    }
    state.queue.shift();
  }
  if (state.ending) socket.end();
}

function paneIdOf(params: Record<string, unknown>, field = "pane_id"): string {
  const value = params[field];
  if (typeof value !== "string" || value === "") throw new AdapterError("invalid_params", `${field} is required`);
  return value;
}

/** hc's refusal in herdr's words, where the server acts on them. */
function herdrCode(error: HcError, missing: string): string {
  switch (error.kind) {
    case "not_found": return missing;
    case "blocked": return "agent_blocked";
    case "unavailable": return "server_unavailable";
    case "closed": return "connect_failed";
    case "timeout": return "timeout";
    default: return error.kind;
  }
}

function createAnswers(hc: HcConnection): (request: Request) => Promise<Reply> {
  const terminal = async (address: string, missing = "pane_not_found"): Promise<HcTerminal> => {
    const record = await hc.call<{ terminal: HcTerminal } | HcTerminal>("terminal.get", { terminal: address }).catch((error: unknown) => {
      throw error instanceof HcError ? new AdapterError(herdrCode(error, missing), error.message) : error;
    });
    const found = "terminal" in record ? record.terminal : record;
    if (found.state !== "live") throw new AdapterError(missing, `terminal ${address} has finished`);
    return found;
  };

  const snapshot = async (): Promise<SessionSnapshot> => {
    const [list, doc, hello] = await Promise.all([
      hc.call<{ terminals: HcTerminal[] }>("terminal.list", {}),
      hc.call<{ value: unknown }>("doc.get", { name: LAYOUT_DOC }),
      hc.hello(),
    ]);
    return buildSnapshot(list.terminals, doc.value, hello.version);
  };

  const paneOf = async (paneId: string, missing = "pane_not_found") => {
    const found = (await snapshot()).panes.find((pane) => pane.pane_id === paneId);
    if (!found) throw new AdapterError(missing, `pane ${paneId} not found`);
    return found;
  };

  /** Bytes typed into the terminal, as a person at it would. */
  const type = async (paneId: string, bytes: string): Promise<void> => {
    const record = await terminal(paneId);
    const { channel } = await hc.open("terminal.attach", { terminal: paneId, cols: record.cols, rows: record.rows }, { onData: () => {}, onClose: () => {} });
    channel.write(bytes);
    channel.close();
  };

  const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    async ping() {
      const hello = await hc.hello();
      return { version: hello.version, protocol: HERDR_PROTOCOL, capabilities: { direct_terminal_attach: true } };
    },
    async "session.snapshot"() {
      return { snapshot: await snapshot() };
    },
    async "pane.get"(params) {
      return { pane: await paneOf(paneIdOf(params)) };
    },
    async "agent.get"(params) {
      const pane = await paneOf(paneIdOf(params, "target"), "agent_not_found");
      if (!pane.agent) throw new AdapterError("agent_not_found", `no agent in pane ${pane.pane_id}`);
      return { type: "agent_info", agent: agentInfoOf(pane) };
    },
    async "pane.process_info"(params) {
      return { type: "pane_process_info", process_info: processInfoOf(await terminal(paneIdOf(params))) };
    },
    async "pane.read"(params) {
      const paneId = paneIdOf(params);
      const pane = await paneOf(paneId);
      const source = typeof params["source"] === "string" ? params["source"] : "visible";
      const format = typeof params["format"] === "string" ? params["format"] : "text";
      const recent = source === "recent" || source === "recent_unwrapped";
      const wanted = typeof params["lines"] === "number" && params["lines"] > 0 ? Math.floor(params["lines"]) : null;
      // hc reads the screen plus `lines` of history above it; herdr's recent read is the last `lines` lines
      const read = await hc.call<{ text: string; complete: boolean }>("terminal.read", { terminal: paneId, lines: recent ? wanted ?? 1000 : 0 });
      let text = read.text;
      if (recent && wanted !== null) {
        const rows = text.split("\n");
        if (rows.length > wanted) text = rows.slice(-wanted).join("\n");
      }
      // hc reads text only: plain text is an ANSI screen without colours
      return { read: { pane_id: paneId, workspace_id: pane.workspace_id, tab_id: pane.tab_id, source, format, text, revision: pane.revision, truncated: !read.complete } };
    },
    async "pane.send_text"(params) {
      const text = params["text"];
      if (typeof text !== "string") throw new AdapterError("invalid_params", "text is required");
      await type(paneIdOf(params), text);
      return { type: "ok" };
    },
    async "pane.send_keys"(params) {
      const paneId = paneIdOf(params);
      const keys = Array.isArray(params["keys"]) ? params["keys"].filter((key): key is string => typeof key === "string") : [];
      // in order, a run of plain keys typed at once and an encoded key on its own
      let typed = "";
      for (const key of keys) {
        const bytes = keyBytes(key);
        if (bytes !== null) { typed += bytes; continue; }
        if (typed) { await type(paneId, typed); typed = ""; }
        await hc.call("terminal.keys", { terminal: paneId, keys: [hcKeyName(key)] });
      }
      if (typed) await type(paneId, typed);
      return { type: "ok" };
    },
    async "agent.prompt"(params) {
      const paneId = paneIdOf(params, "target");
      const text = params["text"];
      if (typeof text !== "string") throw new AdapterError("invalid_params", "text is required");
      if (!(await paneOf(paneId, "agent_not_found")).agent) throw new AdapterError("agent_not_found", `no agent in pane ${paneId}`);
      await hc.call("terminal.send", { terminal: paneId, text }, 30_000);
      return { type: "ok" };
    },
  };

  return async (request) => {
    const method = methods[request.method];
    if (!method) return { error: { code: "unsupported", message: `${request.method} is not available on herdr-core: the Herdr app owns its workspaces, tabs and panes` } };
    try {
      return { result: await method(request.params) };
    } catch (error) {
      if (error instanceof AdapterError) return { error: { code: error.code, message: error.message } };
      if (error instanceof HcError) return { error: { code: herdrCode(error, "pane_not_found"), message: error.message } };
      return { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } };
    }
  };
}

/** One hc event notification (herdr-core schema/README.md, Events). */
interface HcEvent { type: string; terminal?: string; data?: Record<string, unknown> }

/**
 * An events subscription: herdr's acknowledgement once hc's own stream is open, so nothing that
 * happens after the server's next snapshot is missed, then herdr's frames for what hc reports. A
 * subscriber that fell behind on hc (`missed`), or a line to hc that ended, ends this connection:
 * the status collector reopens it and reads what it missed from a fresh snapshot.
 */
async function subscribe(hc: HcConnection, socket: Socket<ConnectionState>, request: Request): Promise<void> {
  const subscriptions = Array.isArray(request.params["subscriptions"]) ? request.params["subscriptions"].filter(isRecord) : [];
  const statusPanes = new Set(subscriptions.flatMap((entry) => entry["type"] === STATUS_EVENT && typeof entry["pane_id"] === "string" ? [entry["pane_id"]] : []));
  const structure = subscriptions.some((entry) => typeof entry["type"] === "string" && !NOT_STRUCTURE.has(entry["type"]));
  const ack = () => send(socket, `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
  if (statusPanes.size === 0 && !structure) {
    // focus only: hc has no focus to report, and the connection stays open as herdr's does
    ack();
    return;
  }
  let acknowledged = false;
  const queued: string[] = [];
  const emit = (event: string, data: Record<string, unknown>) => {
    const frame = `${JSON.stringify({ event, data })}\n`;
    if (acknowledged) send(socket, frame);
    else queued.push(frame);
  };
  const lifecycle = (event: string, type: string, paneId?: string) => {
    if (structure) emit(event, { type, ...(paneId ? { pane_id: paneId } : {}) });
  };
  const onEvent = (event: HcEvent) => {
    const paneId = event.terminal;
    switch (event.type) {
      case "status": {
        if (!paneId || !statusPanes.has(paneId)) return;
        const reported = event.data?.["status"];
        const status = isRecord(reported) && typeof reported["state"] === "string"
          ? { state: reported["state"], ...(typeof reported["app"] === "string" ? { app: reported["app"] } : {}) }
          : null;
        emit(STATUS_EVENT, { pane_id: paneId, agent_status: agentStatusOf(status), agent: status?.app || null });
        return;
      }
      case "created":
        lifecycle("pane.created", "pane_created", paneId);
        return;
      case "finished":
        lifecycle("pane.exited", "pane_exited", paneId);
        lifecycle("pane.closed", "pane_closed", paneId);
        return;
      case "removed":
        lifecycle("pane.closed", "pane_closed", paneId);
        return;
      case "lost":
      case "restarted":
        lifecycle("pane.updated", "pane_updated", paneId);
        return;
      case "labels":
        lifecycle("layout.updated", "layout_updated");
        return;
      case "doc":
        if (event.data?.["name"] === LAYOUT_DOC) lifecycle("layout.updated", "layout_updated");
        return;
      default:
        // title, size, foreground and turn change many times a second and show in the next snapshot
        return;
    }
  };
  const end = () => {
    if (!socket.data.closed) socket.end();
  };
  const read = makeLineReader(EVENT_LINE_BYTES, (line) => {
    let message: unknown;
    try { message = JSON.parse(line); } catch { end(); return; }
    if (!isRecord(message)) return;
    if (message["method"] === "missed") { end(); return; }
    const params = message["params"];
    if (message["method"] !== "event" || !isRecord(params) || typeof params["type"] !== "string") return;
    onEvent({ type: params["type"], ...(typeof params["terminal"] === "string" ? { terminal: params["terminal"] } : {}), ...(isRecord(params["data"]) ? { data: params["data"] } : {}) });
  }, () => {
    socket.data.unsubscribe?.();
    send(socket, `${JSON.stringify({ id: request.id, error: { code: "bad_frame", message: `hc event line exceeds ${EVENT_LINE_BYTES} bytes` } })}\n`, true);
  });
  try {
    const { channel } = await hc.open("events.subscribe", {}, {
      onData: read,
      onClose: end,
    });
    if (socket.data.closed || socket.data.ending) { channel.close(); return; }
    socket.data.unsubscribe = () => channel.close();
    ack();
    acknowledged = true;
    for (const frame of queued) send(socket, frame);
    queued.length = 0;
  } catch (error) {
    const reply = error instanceof HcError ? { code: herdrCode(error, "not_found"), message: error.message } : { code: "internal", message: String(error) };
    send(socket, `${JSON.stringify({ id: request.id, error: reply })}\n`, true);
  }
}

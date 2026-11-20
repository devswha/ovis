import { randomUUID } from "node:crypto";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Machine } from "../../shared/machines.ts";
import { jsonResponse } from "../http.ts";
import { requestOrigin, tailnetDomain } from "../static.ts";

/**
 * The Computer view: a PC's desktop through screen-here's bridge, the script OVIS_SCREEN_BRIDGE
 * names (remote/screen-bridge.py in the orchestrator repository). The bridge reaches the PC's screen-relay
 * session over SSH (this PC's own directly), and serves its viewer page and the page's sockets on a
 * one-off 127.0.0.1 address. This server opens one per view and passes it on under /screen/<id>/, behind its own sign-in, with the Host and Origin the bridge admits
 * only from its own window. Without the variable there is no Computer view.
 *
 * Opened at a tailnet name, the bridge serves the view from the PC itself (`--direct`): it answers
 * over https at that PC's tailnet name, and the view frames it there, so the desktop's stream goes
 * straight from the PC to the browser instead of through this server and the PC it runs on. It
 * falls back to the address above when it can't.
 */

const SCREEN_PATH = /^\/screen\/([0-9a-f-]{36})\/(.*)$/;
const BRIDGE_URL = /^http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/$/;
/** a bridge serving the view from its PC: that PC's tailnet name, the domain captured */
const DIRECT_URL = /^https:\/\/[a-z0-9-]+\.([a-z0-9-]+\.ts\.net):\d+\/[\w-]+\/$/i;
/** a bridge exits once its window has been gone a while: the oldest addresses are dead by then */
const KEPT = 16;

const bridges = new Map<string, URL>();

export function screenAvailable(): boolean {
  return Boolean(process.env["OVIS_SCREEN_BRIDGE"]);
}

export function isScreenPath(pathname: string): boolean {
  return pathname.startsWith("/screen/");
}

/** The bridge's SSH host for a PC: empty for this one, whose desktop it reaches directly. */
function sshHost(machine: Machine): string | null {
  if (machine.kind === "local") return "";
  const target = machine.target;
  if (!target) return null;
  return target.port ? `ssh://${target.destination}:${target.port}` : target.destination;
}

/**
 * POST /api/screen {machine_id}: a new bridge to that PC's desktop, as the address its view opens:
 * `{url}` on the PC itself, or `{path}` here.
 */
export async function handleScreenOpen(request: Request, machines: readonly Machine[]): Promise<Response> {
  const script = process.env["OVIS_SCREEN_BRIDGE"];
  if (!script) return jsonResponse({ error: { code: "unavailable", message: "This server has no screen bridge." } }, 404);
  if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "POST only" } }, 405);
  const body = await request.json().catch(() => null) as { machine_id?: unknown } | null;
  const machine = machines.find((candidate) => candidate.id === body?.machine_id);
  const host = machine ? sshHost(machine) : null;
  if (!machine || host === null) return jsonResponse({ error: { code: "not_found", message: "No such PC." } }, 404);
  // the page that frames the view: only it may, and only at a tailnet name can a PC's own certificate be had
  const origin = request.headers.get("origin") ?? requestOrigin(request);
  let tailnet: string | null = null;
  try {
    const page = new URL(origin);
    tailnet = page.protocol === "https:" ? tailnetDomain(page.hostname) : null;
  } catch { /* no origin to frame it: served here */ }
  const direct = tailnet ? ["--direct", origin] : [];
  const bridge = Bun.spawn(["python3", script, ...direct, host, machine.name], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => bridge.kill(), 45_000);
  // the bridge prints its address and forks to keep serving: its first process exits right away
  const [out, err] = await Promise.all([new Response(bridge.stdout).text(), new Response(bridge.stderr).text(), bridge.exited]);
  clearTimeout(timer);
  const address = out.trim();
  if (tailnet && DIRECT_URL.exec(address)?.[1]?.toLowerCase() === tailnet) return jsonResponse({ url: address });
  if (!BRIDGE_URL.test(address)) {
    const reason = err.trim().split("\n").at(-1) || "its desktop is unreachable.";
    return jsonResponse({ error: { code: "unreachable", message: `${machine.name}: ${reason}` } }, 502);
  }
  const id = randomUUID();
  bridges.set(id, new URL(address));
  if (bridges.size > KEPT) bridges.delete(bridges.keys().next().value!);
  return jsonResponse({ path: `/screen/${id}/` });
}

export interface ScreenSocketData {
  screen: { url: string; origin: string; protocols: string[] };
  upstream?: WebSocket;
  waiting?: (string | Uint8Array<ArrayBuffer>)[];
}

/**
 * A request under /screen/<id>/, passed on to its bridge: a socket upgrade (answered by Bun, so
 * undefined), or the bridge's answer. `allowed`: the caller checked sign-in, a driving role, and
 * for anything but a page load, that the request comes from this app's own origin.
 */
export async function handleScreenRequest(request: Request, url: URL, server: Server<ScreenSocketData>): Promise<Response | undefined> {
  const match = SCREEN_PATH.exec(url.pathname);
  const base = match ? bridges.get(match[1]!) : undefined;
  if (!match || !base) return new Response("not found", { status: 404 });
  const target = new URL(match[2]! + url.search, base);
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
    target.protocol = "ws:";
    const upgraded = server.upgrade(request, {
      data: { screen: { url: target.href, origin: base.origin, protocols } },
    });
    return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
  }
  const headers = new Headers({ Origin: base.origin });
  const type = request.headers.get("content-type");
  if (type) headers.set("content-type", type);
  try {
    const answer = await fetch(target, { method: request.method, headers, ...(request.method === "POST" ? { body: await request.arrayBuffer() } : {}) });
    return new Response(answer.body, { status: answer.status, headers: { "content-type": answer.headers.get("content-type") ?? "text/plain", "cache-control": "no-store" } });
  } catch {
    return new Response("the screen has closed", { status: 502 });
  }
}

const isScreen = (ws: ServerWebSocket<object>): ws is ServerWebSocket<ScreenSocketData> => "screen" in ws.data;

function openScreen(ws: ServerWebSocket<ScreenSocketData>): void {
  const { url, origin, protocols } = ws.data.screen;
  // Bun's client takes headers (Bun.WebSocketOptions), which the DOM typing of WebSocket does not know
  const options: Bun.WebSocketOptions = { headers: { Origin: origin }, protocols };
  const upstream = new WebSocket(url, options as unknown as string[]);
  upstream.binaryType = "arraybuffer";
  ws.data.upstream = upstream;
  ws.data.waiting = [];
  upstream.addEventListener("open", () => {
    for (const message of ws.data.waiting ?? []) upstream.send(message);
    ws.data.waiting = undefined;
  });
  upstream.addEventListener("message", (event) => {
    // 0: Bun dropped it, the browser that far behind; a VNC stream short of bytes is broken, so it ends and the view reconnects
    if (ws.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer)) === 0) ws.close();
  });
  upstream.addEventListener("close", () => ws.close());
  upstream.addEventListener("error", () => ws.close());
}

/** The app's socket handlers, with a screen's sockets passed on to its bridge instead. */
export function withScreenSockets<T extends object>(core: WebSocketHandler<T>): WebSocketHandler<T | ScreenSocketData> {
  return {
    ...(core as WebSocketHandler<T | ScreenSocketData>),
    open(ws) {
      if (isScreen(ws)) openScreen(ws);
      else return core.open?.(ws as ServerWebSocket<T>);
    },
    message(ws, message) {
      if (!isScreen(ws)) return core.message(ws as ServerWebSocket<T>, message);
      const data = typeof message === "string" ? message : Uint8Array.from(message);
      if (ws.data.waiting) ws.data.waiting.push(data);
      else ws.data.upstream?.send(data);
    },
    close(ws, code, reason) {
      if (isScreen(ws)) ws.data.upstream?.close();
      else return core.close?.(ws as ServerWebSocket<T>, code, reason);
    },
    drain(ws) {
      if (!isScreen(ws)) return core.drain?.(ws as ServerWebSocket<T>);
    },
  };
}

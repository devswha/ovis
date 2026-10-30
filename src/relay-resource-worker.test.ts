import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { stampServiceWorker } from "../scripts/service-worker-build.ts";
import { relayResourcePath } from "../shared/relay-mux.ts";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const id = "ab".repeat(16);
const origin = "https://app.test";
const scope = `/s/${id}/`;

// The worker runs with real Response/ReadableStream objects. Only the browser-owned clients and
// ports are in-process: Bun cannot transfer a stream, which the real-browser QA exercises.
class Port {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  peer?: Port;
  postMessage(data: unknown): void { queueMicrotask(() => this.peer?.onmessage?.({ data })); }
  close(): void { this.onmessage = null; }
}
class Channel {
  port1 = new Port();
  port2 = new Port();
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; }
}
interface Asked { target: string; headers: [string, string][]; serverId: string }
function worker(shell: boolean, clients: { url: string; postMessage(data: Asked, ports: Port[]): void }[]) {
  const listeners = new Map<string, (event: unknown) => void>();
  const self = { location: { origin }, registration: { scope: origin + scope },
    clients: { matchAll: async (options: unknown) => { expect(options).toEqual({ type: "window" }); return clients; } },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn) };
  new Function("self", "MessageChannel", stampServiceWorker(source, "abcdef", [], shell))(self, Channel);
  return (target: string, init: RequestInit = {}) => {
    let response: Promise<Response> | undefined;
    listeners.get("fetch")?.({ request: new Request(origin + target, init), respondWith: (value: Promise<Response>) => { response = value; } });
    return response;
  };
}

it("streams local and remote resource targets with Range, status and all security headers intact", async () => {
  const asked: Asked[] = [];
  const headers = { "content-type": "image/svg+xml", "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff", "content-range": "bytes 2-4/10", "set-cookie": "never=passed" };
  const serve = worker(true, [
    { url: `${origin}/s/${"cd".repeat(16)}/`, postMessage() { throw new Error("other PC"); } },
    { url: origin + scope, postMessage(data, ports) {
      asked.push(data);
      ports[0]?.postMessage({ available: true });
      ports[0]?.postMessage({ available: true, status: 206, headers: Object.entries(headers), body: new Response("234").body });
    } },
  ]);
  for (const target of ["/api/fs/file?path=%2fA+%20", "/api/machines/pc%2F1/fs/file?path=x", "/api/pane/conversation/image?ref=a%3A0"]) {
    const response = await serve(relayResourcePath(id, target), { headers: { range: "bytes=2-4", "if-none-match": '"one"', authorization: "never-forward" } });
    expect(response?.status).toBe(206);
    expect(response?.headers.get("content-security-policy")).toBe(headers["content-security-policy"]);
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response?.headers.get("set-cookie")).toBeNull();
    expect(await response?.text()).toBe("234");
    expect(asked.at(-1)).toMatchObject({ target, headers: [["if-none-match", '"one"'], ["range", "bytes=2-4"]], serverId: id });
  }
});

it("leaves non-GET, other API routes and the render host untouched, and leaves the server build unchanged", () => {
  const shell = worker(true, []);
  const native = worker(false, []);
  for (const path of [`${scope}~/api/devices`, `${scope}~/api/fs/%66ile`, `${scope}~render`, "/api/fs/file", "/ws"]) {
    expect(shell(path)).toBeUndefined();
  }
  expect(shell(`${scope}~/api/fs/file`, { method: "POST" })).toBeUndefined();
  expect(native(`${scope}~/api/fs/file`)).toBeUndefined();
});

it("returns 503 without a channel, skipping a controlled window that has none", async () => {
  const serve = worker(true, [{ url: origin + scope, postMessage(_data, ports) { ports[0]?.postMessage({ available: false }); } }]);
  expect((await serve(`${scope}~/api/fs/file`))?.status).toBe(503);
  expect((await worker(true, [])(`${scope}~/api/fs/file`))?.status).toBe(503);
});

it("aborts the window request when the browser aborts before the headers", async () => {
  const received = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const abort = new AbortController();
  const serve = worker(true, [{ url: origin + scope, postMessage(_data, ports) {
    const port = ports[0];
    if (port) port.onmessage = (event) => { expect(event.data).toEqual({ type: "abort" }); cancelled.resolve(); };
    received.resolve();
  } }]);
  const response = serve(`${scope}~/api/fs/file`, { signal: abort.signal });
  const rejected = response?.then(() => null, (error: unknown) => error);
  await received.promise;
  abort.abort();
  expect(await rejected).toBeInstanceOf(DOMException);
  await cancelled.promise;
});

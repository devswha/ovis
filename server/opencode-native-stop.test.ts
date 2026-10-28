import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import { createServer } from "./index.ts";
import { closeOpenCodeNative, openCodeNativeState, openCodePaneService } from "./opencode-native.ts";
import { forgetOpenCodeService, openCodeServiceOptions } from "./opencode-service.ts";

const root = mkdtempSync(join(tmpdir(), "opencode-native-stop-"));
afterAll(() => {
  closeOpenCodeNative();
  delete openCodeServiceOptions.stateDir;
  forgetOpenCodeService();
  rmSync(root, { recursive: true, force: true });
});

/** a bounded wait on an event, never a fixed delay */
const within = <T>(promise: Promise<T>, what: string, ms = 3_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen`)), ms); })]).finally(() => clearTimeout(timer));
};

it("closes the OpenCode event stream a verified pane opened when the server stops (#1548)", async () => {
  const streamOpened = Promise.withResolvers<void>();
  const streamClosed = Promise.withResolvers<void>();
  // a stand-in OpenCode v2 service: its info, any session, and the event stream it holds open
  const service = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/info") return Response.json({ version: "2.0.32", pid: process.pid, urls: [], paths: { tmp: root } });
    if (url.pathname.startsWith("/api/session/")) return Response.json({ data: { id: decodeURIComponent(url.pathname.split("/").at(-1)!) } });
    if (url.pathname === "/api/event") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: {\"type\":\"server.connected\",\"data\":{}}\n\n")); streamOpened.resolve(); },
        cancel() { streamClosed.resolve(); },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(null, { status: 404 });
  } });
  writeFileSync(join(root, "service.json"), JSON.stringify({ url: service.url.origin, pid: process.pid, password: "x", version: "2.0.32" }));
  openCodeServiceOptions.stateDir = root;
  forgetOpenCodeService();
  closeOpenCodeNative();
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-native-stop-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  let stopped = false;
  try {
    const pane = { pane_id: "p_stop", agent: "opencode", agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: "ses_stop" } } as unknown as HerdrPane;
    expect(await openCodePaneService(pane)).not.toBeNull();
    await within(streamOpened.promise, "the stream opening");
    server.stop();
    stopped = true;
    expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });
    await within(streamClosed.promise, "the stream closing at the service");
  } finally {
    if (!stopped) server.stop();
    closeOpenCodeNative();
    service.stop(true);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

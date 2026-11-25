import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import * as herdr from "./herdr/client.ts";
import * as prompt from "./prompt.ts";
import { commandInvocations, type CommandSend } from "./outcome.ts";
import { closeOpenCodeNative, onOpenCodePermissionChange, openCodePaneService, startOpenCodeWatch } from "./opencode-native.ts";
import { forgetOpenCodeService, openCodeServiceOptions } from "./opencode-service.ts";
import recording from "./fixtures/opencode-result-events-2.2.2.json";

/**
 * OpenCode 2.2.2's GET /api/event as recorded from an isolated service: the session's agent picked (plan, then build),
 * its model picked, a prompt, then a compact. The TUI's own pickers and its /compact enqueue no message of their text:
 * their result is the selection or the compaction they end in.
 */
type Recorded = (typeof recording.events)[number];
const session = recording.events[0]!.data.sessionID;
const first = (type: string): Recorded => recording.events.find((event) => event.type === type)!;
const root = mkdtempSync(join(tmpdir(), "opencode-result-events-"));
const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } } as never);
afterAll(() => {
  closeOpenCodeNative();
  rpc.mockRestore();
  delete openCodeServiceOptions.stateDir;
  forgetOpenCodeService();
  rmSync(root, { recursive: true, force: true });
});

const servers: { stop(force: boolean): void }[] = [];
const listeners: (() => void)[] = [];
afterEach(() => {
  closeOpenCodeNative();
  for (const stop of listeners.splice(0)) stop();
  for (const server of servers.splice(0)) server.stop(true);
});

const within = <T>(promise: Promise<T>, what: string, ms = 3_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen`)), ms); })]).finally(() => clearTimeout(timer));
};

async function replaying(name: string) {
  const dir = join(root, name);
  const encoder = new TextEncoder();
  const connected = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/info") return Response.json({ version: recording.opencode, pid: process.pid });
    if (url.pathname.startsWith("/api/session/")) return Response.json({ data: { id: decodeURIComponent(url.pathname.split("/").at(-1)!) } });
    if (url.pathname === "/api/event") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: {\"type\":\"server.connected\",\"data\":{}}\n\n"));
          connected.resolve(controller);
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(null, { status: 404 });
  } });
  servers.push(server);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "service.json"), JSON.stringify({ url: server.url.origin, pid: process.pid, password: "x", version: recording.opencode }));
  openCodeServiceOptions.stateDir = dir;
  forgetOpenCodeService();
  const pane = { pane_id: "p_oc", agent: "opencode", agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: session } } as unknown as HerdrPane;
  expect(await openCodePaneService(pane)).not.toBeNull();
  const stream = await within(connected.promise, "the stream opening");
  const send = (...events: unknown[]) => { for (const event of events) stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
  return {
    pane, send,
    async read(): Promise<void> {
      const { promise, resolve } = Promise.withResolvers<void>();
      listeners.push(onOpenCodePermissionChange(() => resolve()));
      send({ type: "permission.asked", created: Date.now(), data: { sessionID: session } });
      await within(promise, "the events read");
    },
    sent(text: string, id: string, at: number): CommandSend & { store: null } {
      const command: CommandSend & { store: null } = { store: null, id: `${name}-${id}`, text, at, agent: "opencode", identity: "fixture", screen: "", form: null,
        invocations: commandInvocations("opencode", text, []) };
      const watch = startOpenCodeWatch(pane, command)!;
      prompt.noteSubmitted(pane.pane_id, text, command, command.at);
      watch.commit(command, [{ typed: text }], []);
      return command;
    },
  };
}

describe("OpenCode 2.2.2's picker and compact results settle a Chat send", () => {
  it("takes the agent, the model and the compaction each send ends in, as recorded", async () => {
    const replay = await replaying("replay");
    // each sent just before the recording's event of it, in the order the user sent them
    const compaction = recording.events.find((event) => event.type === "session.inbox.enqueued" && event.data.item?.type === "compaction")!;
    const sends = ([["/agents", first("session.agent.selected")], ["/models", first("session.model.selected")], ["/compact", compaction]] as const)
      .map(([text, event]) => replay.sent(text, text.slice(1), event.created - 1));
    replay.send(...recording.events);
    await replay.read();
    expect(sends.map((sent) => [sent.outcome?.state, sent.outcome?.evidence])).toEqual(
      ["session.agent.selected", "session.model.selected", "session.compaction.ended"].map((type) =>
        ["result-observed", [{ kind: "native", at: new Date(first(type).created).toISOString() }]]));
  });

  it("does not take a compaction OpenCode began by itself, nor another session's selection", async () => {
    const replay = await replaying("other");
    const ended = first("session.compaction.ended");
    const model = first("session.model.selected");
    const models = replay.sent("/models", "models", model.created - 1);
    const compact = replay.sent("/compact", "compact", model.created);
    replay.send({ ...ended, data: { ...ended.data, reason: "auto" } }, { ...model, data: { ...model.data, sessionID: "ses_another" } });
    await replay.read();
    expect([compact.outcome?.state, models.outcome?.state]).not.toContain("result-observed");
    replay.send({ ...ended, created: ended.created + 1 }, { ...model, created: model.created + 1 });
    await replay.read();
    // the model's own selection after the next send went is not its result any more; the compaction is
    expect(models.outcome?.state).not.toBe("result-observed");
    expect(compact.outcome?.evidence).toEqual([{ kind: "native", at: new Date(ended.created + 1).toISOString() }]);
  });
});

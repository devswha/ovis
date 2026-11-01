import { expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeManagedGjcFixture, makeManagedGjcFixture, managedGjcDependencies } from "./managed-gjc-fixture.ts";
import { paneConversation, toolOutput } from "./conversation.ts";
import * as conversation from "./conversation.ts";
import { handlePaneRequest } from "./pane-routes.ts";

it("prevents cached managed tool output while preserving native immutable output", async () => {
  const output = spyOn(conversation, "toolOutput").mockResolvedValue("fixture output");
  try {
    for (const [ref, cache] of [
      [`managed-${"a".repeat(32)}-1:${"b".repeat(64)}:call_1`, "private, no-store"],
      ["call_1", "private, max-age=86400, immutable"],
      ["grok:call_1", "private, no-store"],
    ]) {
      const url = new URL(`http://localhost/api/pane/conversation/tool-output?${new URLSearchParams({ pane_id: "pane-1", ref: ref! })}`);
      const response = await handlePaneRequest(new Request(url), url, url.pathname, {});
      expect(response?.status).toBe(200);
      expect(response?.headers.get("cache-control")).toBe(cache);
      expect(await response?.text()).toBe("fixture output");
    }
    expect(output).toHaveBeenCalledTimes(3);
  } finally { output.mockRestore(); }
});

it("renders synthetic native turns through the complete managed GJC chat path", async () => {
  const fixture = makeManagedGjcFixture();
  try {
    const answer = await paneConversation("pane-1", undefined, {}, undefined, undefined, undefined, undefined, undefined, {
      snapshot: async () => fixture.snapshot(),
      managedGjc: managedGjcDependencies(fixture),
    });
    const text = answer.turns.flatMap(turn => turn.parts)
      .filter(part => part.kind === "text")
      .map(part => part.text);
    expect(answer.source).toBe("gjc-transcript");
    expect(text).toContain("synthetic user prompt");
    expect(text).toContain("synthetic assistant reply");
  } finally { disposeManagedGjcFixture(fixture); }
});

it("does not return a transcript read before an SDK endpoint generation changes", async () => {
  const fixture = makeManagedGjcFixture();
  try {
    let calls = 0;
    const deps = {
      ...managedGjcDependencies(fixture),
      sdkSession: async (_record: unknown, pid: number) => ({
        sessionId: fixture.sdkSessionId, pid, hostIncarnation: `linux:${fixture.sdkBirth}`,
        endpointGeneration: ++calls <= 2 ? 3 : 4,
      }),
    };
    await expect(paneConversation("pane-1", undefined, {}, undefined, undefined, undefined, undefined, undefined, {
      snapshot: async () => fixture.snapshot(), managedGjc: deps,
    })).rejects.toMatchObject({ reason: "blocked_managed_identity_changed" });
    expect(calls).toBe(4);
  } finally { disposeManagedGjcFixture(fixture); }
});

it("serves a long bound tool reference but rejects a changed binding", async () => {
  const fixture = makeManagedGjcFixture();
  const root = mkdtempSync(join(tmpdir(), "mgjc-output-"));
  const previousSocket = process.env.HERDR_SOCKET;
  const previousNamespace = process.env.HERDR_MANAGED_NAMESPACE;
  const server = createServer(socket => socket.on("data", data => {
    const request = JSON.parse(data.toString()) as { id: string; method: string };
    socket.end(`${JSON.stringify({ id: request.id, result: request.method === "session.snapshot"
      ? { snapshot: fixture.snapshot() } : { process_info: fixture.processInfo } })}\n`);
  }));
  try {
    const id = `call_${"a".repeat(40)}`;
    const output = "synthetic output ".repeat(400);
    appendFileSync(fixture.sessionFile, [
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: {} }] } },
      { type: "message", message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text: output }] } },
    ].map(row => `${JSON.stringify(row)}\n`).join(""));
    const socketPath = join(root, "herdr.sock");
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    process.env.HERDR_SOCKET = socketPath;
    process.env.HERDR_MANAGED_NAMESPACE = fixture.namespace;
    const deps = managedGjcDependencies(fixture);
    const answer = await paneConversation("pane-1", undefined, {}, undefined, undefined, undefined, undefined, undefined, {
      snapshot: async () => fixture.snapshot(), managedGjc: deps,
    });
    const tool = answer.turns.flatMap(turn => turn.parts).find(part => part.kind === "tool");
    if (tool?.kind !== "tool" || !tool.output_ref) throw new Error("missing managed output ref");
    expect(tool.output_ref.length).toBeGreaterThan(128);
    const read = (ref: string) => toolOutput("pane-1", ref, undefined, undefined, undefined, undefined, undefined, deps);
    expect(await read(tool.output_ref)).toBe(output);
    expect(await read(tool.output_ref.replace(/^managed-a/, "managed-b"))).toBeNull();
    expect(await read(id)).toBeNull();
  } finally {
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET; else process.env.HERDR_SOCKET = previousSocket;
    if (previousNamespace === undefined) delete process.env.HERDR_MANAGED_NAMESPACE; else process.env.HERDR_MANAGED_NAMESPACE = previousNamespace;
    server.close();
    rmSync(root, { recursive: true, force: true });
    disposeManagedGjcFixture(fixture);
  }
});

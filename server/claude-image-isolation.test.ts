import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, closeSync, constants, fstatSync, mkdtempSync, openSync, renameSync, rmSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import * as store from "./claude-store.ts";
import * as pool from "./claude-image-pool.ts";
import { claudeImageFileGeneration } from "./claude-image-file.ts";
import { forgetPaneTranscriptState, forgetTranscriptState } from "./conversation.ts";
import * as herdr from "./herdr/client.ts";
import { handlePaneRequest } from "./pane-routes.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const line = (entry: unknown): string => JSON.stringify(entry) + "\n";
const picture = { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } };
const ref = `${id(3)}:0:0`;
const fake = new URL("./claude-image-reader.fake.ts", import.meta.url);
const waitAsync = (Atomics as unknown as { waitAsync: (cells: Int32Array, index: number, value: number, timeout: number) => { async: boolean; value: Promise<string> | string } }).waitAsync;
let root: string;
let path: string;
let nativePath: string;
let pane: HerdrPane;
const restores: (() => void)[] = [];
const holds: { release(): void; close(): void }[] = [];
function fixture(): string {
  return line({ type: "user", uuid: id(1), parentUuid: null, message: { content: "read" } })
    + line({ type: "assistant", uuid: id(2), parentUuid: id(1), message: { content: [{ type: "tool_use", id: "read", name: "Read" }] } })
    + line({ type: "user", uuid: id(3), parentUuid: id(2), message: { content: [{ type: "tool_result", tool_use_id: "read", content: [picture, picture] }] } });
}
function hold() {
  const fifo = join(root, `gate-${holds.length}`);
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const cells = new Int32Array(new SharedArrayBuffer(12));
  cells[1] = -1; cells[2] = -1;
  const gate = {
    data: { cells: cells.buffer as SharedArrayBuffer, fifo },
    async ran(): Promise<number> {
      const wait = waitAsync(cells, 1, -1, 10_000);
      if ((wait.async ? await wait.value : wait.value) === "timed-out") throw new Error("the real image reader never entered its held read");
      return cells[1]!;
    },
    release() {
      if (Atomics.exchange(cells, 0, 1) !== 0 || cells[1] === -1) return;
      const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      try { writeSync(fd, "x"); } finally { closeSync(fd); }
    },
    close() { const fd = Atomics.exchange(cells, 2, -1); if (fd >= 0) closeSync(fd); },
  };
  holds.push(gate);
  return gate;
}
function heldRoute(gate: ReturnType<typeof hold>) {
  pool.setClaudeImagePoolOptions({ worker: fake });
  const original = pool.claudeImageTask;
  const intercept = spyOn(pool, "claudeImageTask").mockImplementation((job, signal, deadline) => original({ ...job, readGate: gate.data } as typeof job, signal, deadline));
  restores.push(() => intercept.mockRestore());
}
function request(signal?: AbortSignal): Promise<Response> {
  const url = new URL(`http://127.0.0.1/api/pane/conversation/image?${new URLSearchParams({ pane_id: pane.pane_id, ref })}`);
  return handlePaneRequest(new Request(url, { signal }), url, url.pathname, {}).then((response) => response!);
}
beforeEach(async () => {
  pool.setClaudeImagePoolOptions();
  await pool.claudeImageThreadClosed();
  root = mkdtempSync(join(tmpdir(), "ovis-image-isolation-"));
  path = join(root, "session.jsonl"); nativePath = path;
  writeFileSync(path, fixture());
  pane = { pane_id: "isolated-image-pane", terminal_id: "isolated-terminal", cwd: root, foreground_cwd: root, agent: "claude", agent_session: { agent: "claude", kind: "id", value: id(9), source: "fixture" } } as HerdrPane;
  const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes: [{ ...pane }] }) as SessionSnapshot);
  const rpc = spyOn(herdr, "herdrRpc").mockImplementation((async (method: string) => method === "agent.get" ? { agent: { agent_session: { value: pane.agent_session?.value } } } : { process_info: { foreground_processes: [] } }) as typeof herdr.herdrRpc);
  const file = spyOn(store, "claudeTranscriptFile").mockImplementation(async () => nativePath);
  restores.push(() => snapshot.mockRestore(), () => rpc.mockRestore(), () => file.mockRestore());
});
afterEach(async () => {
  for (const gate of holds) gate.release();
  pool.setClaudeImagePoolOptions();
  await pool.claudeImageThreadClosed();
  for (const gate of holds.splice(0)) gate.close();
  for (const restore of restores.splice(0).reverse()) restore();
  forgetTranscriptState();
  rmSync(root, { recursive: true, force: true });
});

describe("isolated Claude image reader and route", () => {
  it("serves exact bytes through the real worker without bridge transcript reads, retaining image headers", async () => {
    const reads = spyOn(fs, "readSync");
    try {
      const responses = await Promise.all([request(), request()]);
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(response.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
      }
      expect(reads).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); }
  });

  it.skipIf(process.platform === "win32")("imports and runs the worker without a herdr connection", async () => {
    const socket = join(root, "no-worker-rpc.sock");
    let connections = 0;
    const listener = Bun.listen({ unix: socket, socket: { open(peer) { connections += 1; peer.end(); }, data() {} } });
    const previous = process.env["HERDR_SOCKET"];
    const previousPath = process.env["HERDR_SOCKET_PATH"];
    process.env["HERDR_SOCKET"] = socket;
    process.env["HERDR_SOCKET_PATH"] = socket;
    try {
      const generation = (await pool.claudeImageGeneration(path, "binding"))!;
      const image = await pool.claudeImageTask({ path, ref, binding: "binding", generation });
      expect(Buffer.from(image!.bytes).equals(png)).toBe(true);
      expect(connections).toBe(0);
    } finally {
      pool.setClaudeImagePoolOptions();
      await pool.claudeImageThreadClosed();
      listener.stop(true);
      if (previous === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = previous;
      if (previousPath === undefined) delete process.env["HERDR_SOCKET_PATH"]; else process.env["HERDR_SOCKET_PATH"] = previousPath;
    }
  });

  it("transfers an exact owned 8 MiB picture and refuses a picture one byte larger", async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    png.copy(bytes);
    const encoded = (data: Buffer) => ({ ...picture, source: { ...picture.source, data: data.toString("base64") } });
    writeFileSync(path, line({ type: "user", uuid: id(1), message: { content: [encoded(bytes), encoded(Buffer.concat([bytes, Buffer.from([0])]))] } }));
    const generation = (await pool.claudeImageGeneration(path, "binding"))!;
    const image = await pool.claudeImageTask({ path, ref: `${id(1)}:0`, binding: "binding", generation });
    expect(image!.bytes.byteOffset).toBe(0);
    expect(image!.bytes.buffer.byteLength).toBe(bytes.length);
    expect(Buffer.from(image!.bytes).equals(bytes)).toBe(true);
    expect(await pool.claudeImageTask({ path, ref: `${id(1)}:1`, binding: "binding", generation })).toBeNull();
  });

  for (const rejection of ["read", "check"] as const) it(`revokes a warm boundary after rejecting a stale ${rejection} generation`, async () => {
    const drawn = line({ type: "user", uuid: id(1), message: { content: [picture] } });
    const clear = line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } });
    const replaceable = line({ type: "progress", data: "x".repeat(clear.length - line({ type: "progress", data: "" }).length) });
    expect(replaceable.length).toBe(clear.length);
    const padding = line({ type: "progress", data: "x".repeat(1024 * 1024) }).repeat(3);
    writeFileSync(path, drawn + replaceable + padding);
    const generation = (await pool.claudeImageGeneration(path, "binding"))!;
    const job = { path, ref: `${id(1)}:0`, binding: "binding", generation };
    expect(await pool.claudeImageTask(job)).not.toBeNull();
    writeFileSync(path, drawn + clear + padding);
    appendFileSync(path, line({ type: "progress", data: "append" }));
    if (rejection === "read") expect(await pool.claudeImageTask(job)).toBeNull();
    else expect(await pool.claudeImageGenerationCurrent(job)).toBe(false);
    const latest = (await pool.claudeImageGeneration(path, "binding"))!;
    expect(latest).not.toBe(generation);
    expect(await pool.claudeImageTask({ ...job, generation: latest })).toBeNull();
  });

  it("refuses a queued read whose inspected file was rewritten before the scanner opened it", async () => {
    const generation = await pool.claudeImageGeneration(path, "binding");
    writeFileSync(path, fixture().replace('"read"', '"gone"'));
    expect(await pool.claudeImageTask({ path, ref, binding: "binding", generation: generation! })).toBeNull();
  });

  for (const mutation of ["replace", "truncate", "rewrite", "clear", "rewind"] as const) it.skipIf(process.platform === "win32")(`rejects a pending worker image after ${mutation}`, async () => {
    const gate = hold(); heldRoute(gate);
    const reading = request();
    await gate.ran();
    if (mutation === "replace") { const next = join(root, "replacement"); writeFileSync(next, fixture()); renameSync(next, path); }
    if (mutation === "truncate") truncateSync(path, 0);
    if (mutation === "rewrite") writeFileSync(path, fixture().replaceAll('"read"', '"gone"'));
    if (mutation === "clear") appendFileSync(path, line({ type: "system", subtype: "compact_boundary", logicalParentUuid: null }) + line({ type: "user", uuid: id(4), parentUuid: null, message: { content: "new" } }));
    if (mutation === "rewind") appendFileSync(path, line({ type: "user", uuid: id(5), parentUuid: id(1), message: { content: "another branch" } }));
    gate.release();
    expect((await reading).status).toBe(404);
  });

  it.skipIf(process.platform === "win32")("keeps harmless appended history readable and publishes the generation actually validated", async () => {
    const gate = hold(); heldRoute(gate);
    const before = claudeImageFileGeneration(path);
    const reading = request();
    await gate.ran();
    appendFileSync(path, line({ type: "assistant", uuid: id(4), parentUuid: id(3), message: { content: [{ type: "text", text: "done" }] } }));
    gate.release();
    expect(claudeImageFileGeneration(path)).not.toBe(before);
    const response = await reading;
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
  });

  for (const change of ["session", "source", "cwd", "path", "forget"] as const) it.skipIf(process.platform === "win32")(`revalidates the pane's ${change} binding after a held scan`, async () => {
    const gate = hold(); heldRoute(gate);
    const reading = request();
    await gate.ran();
    if (change === "session") pane = { ...pane, agent_session: { ...pane.agent_session!, value: id(10) } };
    if (change === "source") pane = { ...pane, agent: "pi" };
    if (change === "cwd") pane = { ...pane, cwd: join(root, "elsewhere") };
    if (change === "path") { nativePath = join(root, "second.jsonl"); writeFileSync(nativePath, fixture()); }
    if (change === "forget") forgetPaneTranscriptState(pane.pane_id);
    gate.release();
    const response = await reading;
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "image_not_found" } });
  });

  for (const stage of ["snapshot", "resolve"] as const) {
    it(`bounds initial ${stage} authorization by deadline and cancellation`, async () => {
      pool.setClaudeImagePoolOptions({ deadlineMs: 40 });
      const pending = new Promise<never>(() => {});
      const blocked = stage === "snapshot" ? spyOn(herdr, "sessionSnapshot").mockReturnValue(pending) : spyOn(store, "claudeTranscriptFile").mockReturnValue(pending);
      try {
        const response = await request();
        expect(response.status).toBe(503);
        const cancel = new AbortController();
        const reading = request(cancel.signal);
        cancel.abort();
        expect((await reading).status).toBe(503);
        expect(pool.claudeImagePoolSize().physical).toBe(0);
      } finally { blocked.mockRestore(); }
    });
  }

  for (const scope of ["pane", "all"] as const) it(`honors ${scope} transcript invalidation during initial authorization`, async () => {
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const waiting = new Promise<void>((done) => { release = done; });
    const starting = new Promise<void>((done) => { entered = done; });
    const file = spyOn(store, "claudeTranscriptFile").mockImplementation(async () => { entered(); await waiting; return path; });
    try {
      const reading = request();
      await starting;
      if (scope === "pane") forgetPaneTranscriptState(pane.pane_id); else forgetTranscriptState();
      release();
      expect((await reading).status).toBe(404);
      expect(pool.claudeImagePoolSize().physical).toBe(0);
    } finally { release(); file.mockRestore(); }
  });

  it("checks pane authority again after the final worker fence", async () => {
    const original = pool.claudeImageGenerationCurrent;
    const check = spyOn(pool, "claudeImageGenerationCurrent").mockImplementation(async (...args) => {
      const answer = await original(...args);
      pane = { ...pane, agent_session: { ...pane.agent_session!, value: id(10) } };
      return answer;
    });
    try { expect((await request()).status).toBe(404); } finally { check.mockRestore(); }
  });

  it.skipIf(process.platform === "win32")("propagates request cancellation and returns the existing retryable busy policy", async () => {
    const gate = hold(); heldRoute(gate);
    const cancel = new AbortController();
    const reading = request(cancel.signal);
    await gate.ran();
    cancel.abort();
    const response = await reading;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toMatchObject({ error: { code: "file_busy" } });
    expect(pool.claudeImagePoolSize()).toMatchObject({ physical: 1, running: 1, waiters: 0 });
    gate.release();
  });

  it.skipIf(process.platform === "win32")("answers a slow worker with retryable 503 inside its whole-request budget", async () => {
    const gate = hold(); heldRoute(gate);
    pool.setClaudeImagePoolOptions({ worker: fake, deadlineMs: 100 });
    const reading = request();
    await gate.ran();
    const response = await reading;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toMatchObject({ error: { code: "file_busy" } });
    gate.release();
  });

  it.skipIf(process.platform === "win32")("closes a real scanner descriptor only after its terminated read returns", async () => {
    const gate = hold(); heldRoute(gate);
    const reading = request();
    const fd = await gate.ran();
    expect(fstatSync(fd).isFile()).toBe(true);
    pool.setClaudeImagePoolOptions();
    expect((await reading).status).toBe(503);
    expect(fstatSync(fd).isFile()).toBe(true);
    gate.release();
    await pool.claudeImageThreadClosed();
    expect(() => fstatSync(fd)).toThrow();
  });
});

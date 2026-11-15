import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

/**
 * Two web bridges on one classic herdr: the one that does not hold a pane's attach slot types
 * nothing into it, through its page or its HTTP routes, until the other lets go.
 */
const rootA = mkdtempSync(join(tmpdir(), "ovis-held-input-a-"));
const rootB = mkdtempSync(join(tmpdir(), "ovis-held-input-b-"));
const holder = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: rootA });
const waiter = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: rootB, attachHeldRetryMs: 200 });
const workspaces: string[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const socket of sockets) socket.close();
  holder.stop();
  waiter.stop();
  for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace });
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(20);
  }
}

function connect(port: number, paneId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const state = { frames: 0, errors: [] as string[], heldMessage: "", ready: 0, resumed: 0, submits: [] as { ok: boolean; code?: string }[] };
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerMessage;
    if (frame.type === "error") state.errors.push(frame.code);
    if (frame.type === "error" && frame.code === "attach_held") state.heldMessage = frame.message;
    if (frame.type === "pty-data" && frame.pane_id === paneId) state.frames++;
    if (frame.type === "input-ready" && frame.pane_id === paneId && frame.ready !== false) state.ready++;
    if (frame.type === "attach-resumed" && frame.pane_id === paneId) state.resumed++;
    if (frame.type === "submit-result" && frame.pane_id === paneId) state.submits.push({ ok: frame.ok, code: frame.code });
  });
  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
  const open = until(() => ws.readyState === WebSocket.OPEN, "socket open");
  return { ws, state, send, open };
}

async function post(port: number, route: "input" | "keys", body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/pane/${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** the pane's text through a server's read route, which works whether that server holds the pane or not */
async function screen(port: number, paneId: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/pane/read?pane_id=${encodeURIComponent(paneId)}&source=recent&lines=200`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { read: { text: string } }).read.text;
}

/** a line the shell printed (not the command line that printed it) */
const printed = (text: string, line: string): boolean => new RegExp(`^${line}\\s*$`, "m").test(text);

/** a pane the holder streams and the waiter was told is held */
async function heldPane() {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "ovis-test-held-input", cwd: rootA, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  const a = connect(holder.port, paneId);
  await a.open;
  a.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
  await until(() => a.state.frames > 0, "holder attached");
  const b = connect(waiter.port, paneId);
  await b.open;
  b.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
  await until(() => b.state.errors.includes("attach_held"), "waiter told the pane is held");
  return { paneId, a, b };
}

/** the holder clears its line and prints `mark`: everything sent before it has reached the shell once it shows */
async function barrier(a: ReturnType<typeof connect>, paneId: string, mark: string): Promise<string> {
  a.send({ type: "input", pane_id: paneId, text: `\x15echo ${mark}\r` });
  let text = "";
  await until(async () => printed(text = await screen(waiter.port, paneId), mark), `barrier ${mark}`);
  return text;
}

/** the HTTP answer the waiter's routes give: the very refusal its page was sent */
const refusal = (b: ReturnType<typeof connect>) => ({ status: 409, body: { error: { code: "attach_held", message: b.state.heldMessage } } });

describe("HTTP input on a pane another web bridge holds", () => {
  it("POST /api/pane/input types nothing and answers the page's refusal", async () => {
    const { paneId, a, b } = await heldPane();
    const answer = await post(waiter.port, "input", { pane_id: paneId, text: "echo IN$((40+2))\r" });
    const text = await barrier(a, paneId, "BAR1");
    expect(printed(text, "IN42")).toBe(false);
    expect(answer).toEqual(refusal(b));
  }, 30_000);

  it("POST /api/pane/keys types nothing and answers the page's refusal", async () => {
    const { paneId, a, b } = await heldPane();
    // the holder's half-typed command: a key through the waiter would run it
    a.send({ type: "input", pane_id: paneId, text: "echo KEY$((40+3))" });
    await until(async () => (await screen(waiter.port, paneId)).includes("echo KEY$((40+3))"), "holder's command shows");
    const answer = await post(waiter.port, "keys", { pane_id: paneId, keys: ["Enter"] });
    const text = await barrier(a, paneId, "BAR2");
    expect(printed(text, "KEY43")).toBe(false);
    expect(answer).toEqual(refusal(b));
  }, 30_000);

  it("the page's submit types nothing either, and the holder's HTTP input still types", async () => {
    const { paneId, a, b } = await heldPane();
    b.send({ type: "submit", id: 1, pane_id: paneId, text: "echo SUB$((40+4))", payload: "echo SUB$((40+4))" });
    await until(() => b.state.submits.length === 1, "submit answered while held");
    expect(b.state.submits[0]).toEqual({ ok: false, code: "attach_held" });
    const own = await post(holder.port, "input", { pane_id: paneId, text: "echo OWN$((40+5))\r" });
    expect(own).toEqual({ status: 200, body: { ok: true } });
    const text = await barrier(a, paneId, "BAR3");
    expect(printed(text, "SUB44")).toBe(false);
    expect(printed(text, "OWN45")).toBe(true);
  }, 30_000);

  it("types again once the holder lets go", async () => {
    const { paneId, a, b } = await heldPane();
    a.send({ type: "detach", pane_id: paneId });
    await until(() => b.state.resumed === 1, "waiter attached after the holder let go");
    const answer = await post(waiter.port, "input", { pane_id: paneId, text: "echo AFT$((40+6))\r" });
    expect(answer).toEqual({ status: 200, body: { ok: true } });
    await until(async () => printed(await screen(waiter.port, paneId), "AFT46"), "input after the release arrives");
    const keys = await post(waiter.port, "keys", { pane_id: paneId, keys: ["Enter"] });
    expect(keys).toEqual({ status: 200, body: { ok: true } });
  }, 30_000);
});

describe("two devices on one server", () => {
  it("share the attachment and both type, through the page and HTTP", async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: "ovis-test-shared-input", cwd: rootA, focus: false },
    );
    workspaces.push(created.workspace.workspace_id);
    const paneId = created.root_pane.pane_id;
    const one = connect(holder.port, paneId);
    const two = connect(holder.port, paneId);
    await Promise.all([one.open, two.open]);
    one.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
    await until(() => one.state.frames > 0, "first device attached");
    two.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
    await until(() => two.state.ready > 0, "second device ready");
    one.send({ type: "input", pane_id: paneId, text: "echo ONE$((40+7))\r" });
    await until(async () => printed(await screen(holder.port, paneId), "ONE47"), "first device types");
    two.send({ type: "input", pane_id: paneId, text: "echo TWO$((40+8))\r" });
    await until(async () => printed(await screen(holder.port, paneId), "TWO48"), "second device types");
    const answer = await post(holder.port, "input", { pane_id: paneId, text: "echo WEB$((40+9))\r" });
    expect(answer).toEqual({ status: 200, body: { ok: true } });
    await until(async () => printed(await screen(holder.port, paneId), "WEB49"), "HTTP input types");
    expect(one.state.errors).not.toContain("attach_held");
    expect(two.state.errors).not.toContain("attach_held");
  }, 30_000);
});

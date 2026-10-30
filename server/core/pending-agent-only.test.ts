import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import * as processStart from "../process-start.ts";
import * as gjcRuntime from "../gjc-runtime.ts";
import * as omoModule from "../omo.ts";
import { connectionData } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";

afterEach(() => mock.restore());

const COLLAPSED = "• WAITING\n• Queued follow-up inputs\n  ? 2 questions · 8s\n    alt+↑ to answer\n› Ask Codex to do anything\n  gpt-6.1 default · /workspace\n";
type Frame = { type: string; [key: string]: unknown };

/**
 * A pane herdr labels Codex, with `foreground` in front of shell 41000; `afterPaste`: the screen once the paste
 * is written. `submitted`: the immediate path's sends, which go to submitText.
 */
function delivery(foreground: { pid: number; name: string; argv0?: string; argv?: string[] }, status: string, afterPaste?: string, agent = "codex") {
  const writes: string[] = [], frames: Frame[] = [], submitted: string[] = [];
  let screen = "› Ask Codex to do anything\n";
  // `front`: what each later read of the pane's processes finds, as a process can exec another program in place
  const front = { now: foreground, next: [] as typeof foreground[] };
  const count = { reads: 0, atPaste: -1, atEnter: -1 };
  spyOn(herdr, "paneProcessInfo").mockImplementation(async () => {
    count.reads++;
    const shown = front.next.shift() ?? front.now;
    return { pane_id: "p", shell_pid: 41000, foreground_processes: [{ argv: [shown.name], ...shown }] } as Awaited<ReturnType<typeof herdr.paneProcessInfo>>;
  });
  spyOn(processStart, "processStartedAtAsync").mockResolvedValue(1000);
  spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: screen }) as Awaited<ReturnType<typeof herdr.paneRead>>);
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text) => { if (count.atPaste < 0) count.atPaste = count.reads; writes.push(text); if (afterPaste !== undefined) screen = afterPaste; });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys) => { if (count.atEnter < 0) count.atEnter = count.reads; writes.push(keys.join(",")); });
  const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (value: string) => { frames.push(JSON.parse(value) as Frame); return 1; } };
  owner.data.attached.set("p", { keepSize: false });
  const pane = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent, agent_status: status, focused: false, revision: 0 };
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 80 };
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(_pane: string, run: () => T | Promise<T>): Promise<T> => { const next = tail.catch(() => {}).then(run); tail = next; return next; };
  const pending = createPendingDelivery({
    options: { submitDelayMs: 0 }, clients: new Set([owner]), attachments: new Map(), sight: (() => ({ facts: () => facts, write: () => {} })), serialize,
    lastTyped: new Map(), submitText: async (_pane: string, text: string) => { submitted.push(text); }, authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [pane] }), omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 1000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  } as unknown as Parameters<typeof createPendingDelivery>[0]);
  const submit = (id: number, delivery: "immediate" | "queue" | "hold") => pending.pendingFrames.submit(owner as never,
    { type: "submit", id, pane_id: "p", text: "> backup.txt\nkeep it", payload: delivery === "immediate" ? "> backup.txt\rkeep it" : "unused", delivery, agent_only: true } as never);
  const sendNow = (id: number, pendingId: string) => pending.pendingFrames["pending-action"](owner as never, { type: "pending-action", id, pane_id: "p", pending_id: pendingId, action: "steer" } as never);
  const result = (type: string, id: number) => frames.find((frame) => frame.type === type && frame.id === id);
  return { writes, submitted, submit, sendNow, result, front, count };
}

// #511: herdr can keep naming an agent that has exited; the pane's own shell in front is no agent for a message
// whose `> quote` lines a shell would run as redirects
it.each(["immediate", "queue", "hold"] as const)("refuses an agent-only %s send while herdr names Codex but the shell is in front", async (kind) => {
  const d = delivery({ pid: 41000, name: "bash" }, "idle");
  await d.submit(1, kind);
  expect(d.result("submit-result", 1)).toMatchObject({ ok: false, code: "agent_not_ready" });
  expect(d.writes).toEqual([]);
  expect(d.submitted).toEqual([]);
});

it("holds back the Enter of an agent-only Send now when Codex's question queue collapses during its paste", async () => {
  const d = delivery({ pid: 41001, name: "codex" }, "idle", COLLAPSED);
  await d.submit(1, "hold");
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  await d.sendNow(2, held.pending.id);
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~"]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false });
});

it("sends an agent-only Send now to Codex in front, paste and Enter (control)", async () => {
  const d = delivery({ pid: 41001, name: "codex" }, "idle");
  await d.submit(1, "hold");
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  await d.sendNow(2, held.pending.id);
  expect(d.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~", "Enter"]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: true });
});

it.each(["immediate", "queue", "hold"] as const)("refuses an agent-only %s send while herdr names Codex but a shell started since is in front", async (kind) => {
  const d = delivery({ pid: 41001, name: "bash" }, "idle");
  await d.submit(1, kind);
  expect(d.result("submit-result", 1)).toMatchObject({ ok: false, code: "agent_not_ready" });
  expect(d.writes).toEqual([]);
  expect(d.submitted).toEqual([]);
});

it("refuses Send now of an agent-only message once the Codex it was held for exec'd a shell at the same PID", async () => {
  const d = delivery({ pid: 41000, name: "codex" }, "idle");
  await d.submit(1, "hold");
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  d.front.now = { pid: 41000, name: "bash" };
  await d.sendNow(2, held.pending.id);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false });
  expect(d.writes).toEqual([]);
});

it("judges the process by the last read: a shell that replaced Codex between two reads is no agent", async () => {
  const d = delivery({ pid: 41000, name: "bash" }, "idle");
  d.front.next = [{ pid: 41000, name: "codex" }];
  await d.submit(1, "hold");
  expect(d.result("submit-result", 1)).toMatchObject({ ok: false, code: "agent_not_ready" });
  expect(d.writes).toEqual([]);
});

it.each([[true, "Codex under the pane's shell"], [false, "the shell alone"]] as const)("on Windows, where herdr names only the shell, looks for the agent under it: %s (%s)", async (runs) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  spyOn(gjcRuntime, "recentProcessTable").mockResolvedValue([
    { pid: 41000, parent: 1, path: "C:\\Windows\\pwsh.exe", commandLine: "pwsh.exe" },
    ...(runs ? [{ pid: 41002, parent: 41000, path: "C:\\tools\\codex.exe", commandLine: "codex.exe" }] : []),
  ]);
  try {
    const d = delivery({ pid: 41000, name: "pwsh.exe" }, "idle");
    await d.submit(1, "hold");
    expect(d.result("submit-result", 1)).toMatchObject(runs ? { ok: true } : { ok: false, code: "agent_not_ready" });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

it("sends to Claude's native build, which titles its process by its version", async () => {
  const d = delivery({ pid: 41000, name: "2.1.302", argv0: "Claude", argv: ["Claude"] }, "idle", undefined, "claude");
  await d.submit(1, "hold");
  expect(d.result("submit-result", 1)).toMatchObject({ ok: true });
});

it("sends to Pi run from its npm entry", async () => {
  const d = delivery({ pid: 41001, name: "node", argv: ["node", "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"] }, "idle", undefined, "pi");
  await d.submit(1, "hold");
  expect(d.result("submit-result", 1)).toMatchObject({ ok: true });
});

it("takes no OmO holder record for an agent once a shell runs at its PID", async () => {
  spyOn(omoModule, "heldOmoProcess").mockResolvedValue({ pid: 41000, started: 1000 } as Awaited<ReturnType<typeof omoModule.heldOmoProcess>>);
  const d = delivery({ pid: 41000, name: "bash" }, "idle", undefined, "omo");
  await d.submit(1, "hold");
  expect(d.result("submit-result", 1)).toMatchObject({ ok: false, code: "agent_not_ready" });
});

it("types nothing when the last read before the paste finds a shell exec'd at Codex's PID", async () => {
  // a control Send now counts the reads up to its paste
  const control = delivery({ pid: 41001, name: "codex" }, "idle");
  await control.submit(1, "hold");
  const before = control.count.reads;
  await control.sendNow(2, (control.result("submit-result", 1) as unknown as { pending: { id: string } }).pending.id);
  const toPaste = control.count.atPaste - before;
  mock.restore();
  const d = delivery({ pid: 41001, name: "codex" }, "idle");
  await d.submit(1, "hold");
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  // every read sees Codex but the last one before the paste, which finds a shell exec'd at its PID
  d.front.next = [...Array.from({ length: toPaste - 1 }, () => ({ pid: 41001, name: "codex" })), { pid: 41001, name: "bash" }];
  await d.sendNow(2, held.pending.id);
  expect(d.writes).toEqual([]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false });
});

/** A held agent-only message whose PID shows `after` from the `from`-th last process read before its Enter on: its result and writes. */
async function replacedBeforeEnter(after: { pid: number; name: string }, from: number) {
  const control = delivery({ pid: 41001, name: "codex" }, "idle");
  await control.submit(1, "hold");
  const start = control.count.reads;
  await control.sendNow(2, (control.result("submit-result", 1) as unknown as { pending: { id: string } }).pending.id);
  const reads = control.count.atEnter - start;
  mock.restore();
  const d = delivery({ pid: 41001, name: "codex" }, "idle");
  await d.submit(1, "hold");
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  d.front.next = Array.from({ length: reads - from }, () => ({ pid: 41001, name: "codex" }));
  d.front.now = after;
  await d.sendNow(2, held.pending.id);
  return { writes: d.writes, answer: d.result("pending-result", 2) };
}

// the very last read before the Enter sees a shell at Codex's PID: no Enter, and the held message stays
it("holds back the Enter when the last read before it finds a shell exec'd at Codex's PID", async () => {
  const { writes, answer } = await replacedBeforeEnter({ pid: 41001, name: "bash" }, 1);
  expect(writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~"]);
  expect(answer).toMatchObject({ ok: false, code: "agent_blocked" });
});

// after the paste, Codex's PID runs another program that is no shell: only the agent check before Enter refuses it
it("holds back the Enter when Codex's PID runs another program after the paste", async () => {
  const { writes, answer } = await replacedBeforeEnter({ pid: 41001, name: "python3" }, 3);
  expect(writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~"]);
  expect(answer).toMatchObject({ ok: false, code: "agent_blocked" });
});

// at Send now another program that is no shell runs at Codex's PID: nothing at all is typed
it("types nothing at Send now when Codex's PID already runs another program", async () => {
  const d = delivery({ pid: 41001, name: "codex" }, "idle");
  await d.submit(1, "hold");
  const held = d.result("submit-result", 1) as unknown as { pending: { id: string } };
  d.front.now = { pid: 41001, name: "python3" };
  await d.sendNow(2, held.pending.id);
  expect(d.writes).toEqual([]);
  expect(d.result("pending-result", 2)).toMatchObject({ ok: false, code: "agent_not_ready" });
});

import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import * as processStart from "../process-start.ts";
import { connectionData } from "./connections.ts";
import { createPendingDelivery, FIRST_MESSAGE_OWNER } from "./pending.ts";

afterEach(() => mock.restore());

/**
 * A Codex pane (pid 41001 in front of shell 41000), open on a device `cols` wide, and the PC's pending delivery with no
 * connection of its own (#2919). The pane's status has changed once since the server started, as a pane's first turn does.
 */
function delivery(status: string, startTimeoutMs?: number, cols = 80) {
  const writes: string[] = [];
  const front = { pid: 41001, name: "codex" };
  spyOn(herdr, "paneProcessInfo").mockImplementation(async () =>
    ({ pane_id: "p", shell_pid: 41000, foreground_processes: [{ argv: [front.name], ...front }] }) as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  spyOn(processStart, "processStartedAtAsync").mockResolvedValue(1000);
  const shown = { screen: "› Ask Codex to do anything\n" };
  spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: shown.screen }) as Awaited<ReturnType<typeof herdr.paneRead>>);
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text) => { writes.push(text); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys) => { writes.push(keys.join(",")); });
  const pane = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "codex", agent_status: status, focused: false, revision: 0 };
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(_pane: string, run: () => T | Promise<T>): Promise<T> => { const next = tail.catch(() => {}).then(run); tail = next; return next; };
  const attachments = new Map<string, { cols: number; rows: number; held?: boolean }>([["p", { cols, rows: 24 }]]);
  const pending = createPendingDelivery({
    options: { submitDelayMs: 0, ...(startTimeoutMs === undefined ? {} : { pendingStartTimeoutMs: startTimeoutMs }) }, clients: new Set(), attachments, sight: () => { throw new Error("no connection"); }, serialize,
    lastTyped: new Map(), submitText: async () => { throw new Error("not the immediate path"); }, authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [pane] }), omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 1000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  } as unknown as Parameters<typeof createPendingDelivery>[0]);
  pending.pending.status("p", "working");
  pending.pending.status("p", "idle");
  return { pending, writes, pane, front, shown, attachments };
}

it("types a scheduled message with no connection open: a paste and its Enter", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  expect(await d.pending.sendScheduled("p", "continue", identity, true, () => {})).toEqual({ ok: true });
  expect(d.writes).toEqual(["\u001b[200~continue\u001b[201~", "Enter"]);
});

it("keeps a scheduled message for the agent's next turn while it works, typing nothing", async () => {
  const d = delivery("working");
  const identity = await d.pending.scheduledIdentity("p");
  expect(await d.pending.sendScheduled("p", "continue", identity, true, () => {})).toMatchObject({ ok: false, code: "pending_wait" });
  expect(d.writes).toEqual([]);
});

it("refuses a scheduled message once another agent process runs in the pane", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  d.front.pid = 41002;
  expect(await d.pending.sendScheduled("p", "continue", identity, true, () => {})).toMatchObject({ ok: false, code: "pending_target_changed" });
  expect(d.writes).toEqual([]);
});

it("types nothing once the scheduler withdraws its authority", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  const revoked = () => { throw new herdr.HerdrError("device_revoked", "gone"); };
  expect(await d.pending.sendScheduled("p", "continue", identity, true, revoked)).toMatchObject({ ok: false, code: "device_revoked" });
  expect(d.writes).toEqual([]);
});

it("types nothing when the shell is in front where herdr still names the agent", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  d.front.pid = 41000;
  d.front.name = "bash";
  expect((await d.pending.sendScheduled("p", "continue", identity, true, () => {})).ok).toBe(false);
  expect(d.writes).toEqual([]);
});

it("keeps a second scheduled message for the turn the first one started", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  expect(await d.pending.sendScheduled("p", "first", identity, true, () => {})).toEqual({ ok: true });
  expect(await d.pending.sendScheduled("p", "second", identity, true, () => {})).toMatchObject({ ok: false, code: "pending_wait" });
  expect(d.writes).toEqual(["\u001b[200~first\u001b[201~", "Enter"]);
});

it("holds the next scheduled message for review when the turn the last one started was never confirmed", async () => {
  const d = delivery("idle", 0);
  const identity = await d.pending.scheduledIdentity("p");
  expect(await d.pending.sendScheduled("p", "first", identity, true, () => {})).toEqual({ ok: true });
  d.pending.pending.expire();
  expect(await d.pending.sendScheduled("p", "second", identity, true, () => {})).toMatchObject({ ok: false, code: "pending_turn_unconfirmed" });
  d.pending.pending.status("p", "working");
  d.pending.pending.status("p", "idle");
  expect(await d.pending.sendScheduled("p", "second", identity, true, () => {})).toEqual({ ok: true });
});

it("types nothing into a password prompt that wrapped at the open device's width", async () => {
  const d = delivery("idle", undefined, 25);
  const identity = await d.pending.scheduledIdentity("p");
  d.shown.screen = "Enter passphrase for key\n'/tmp/key': ";
  expect((await d.pending.sendScheduled("p", "continue", identity, true, () => {})).ok).toBe(false);
  expect(d.writes).toEqual([]);
});

it("never lifts the unconfirmed turn on a snapshot read, only on the pane's next status event", async () => {
  const d = delivery("idle", 0);
  const identity = await d.pending.scheduledIdentity("p");
  expect(await d.pending.sendScheduled("p", "first", identity, true, () => {})).toEqual({ ok: true });
  d.pending.pending.expire();
  d.pending.pending.observe("p", "idle", d.pending.pending.mark("p"));
  expect(await d.pending.sendScheduled("p", "second", identity, true, () => {})).toMatchObject({ ok: false, code: "pending_turn_unconfirmed" });
});

it("asks for the user's OK, typing nothing, while a queued message to the pane may sit in its input", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  const queued = d.pending.pending.enqueue(FIRST_MESSAGE_OWNER, "p", -1, "earlier", null, identity);
  expect(d.pending.pending.claim(queued, false)).toBe(true);
  d.pending.pending.settle(queued, { code: "submit_changed", message: "not confirmed" }, true);
  expect(await d.pending.sendScheduled("p", "continue", identity, true, () => {})).toMatchObject({ ok: false, code: "needs_ok" });
  expect(d.writes).toEqual([]);
});

it("keeps the unconfirmed turn through a baseline that repeats the pane's status", async () => {
  const d = delivery("idle", 0);
  const identity = await d.pending.scheduledIdentity("p");
  d.pending.pending.status("p", "idle");
  expect(await d.pending.sendScheduled("p", "first", identity, true, () => {})).toEqual({ ok: true });
  d.pending.pending.expire();
  d.pending.pending.status("p", "idle");
  expect(await d.pending.sendScheduled("p", "second", identity, true, () => {})).toMatchObject({ ok: false, code: "pending_turn_unconfirmed" });
  d.pending.pending.status("p", "working");
  d.pending.pending.status("p", "idle");
  expect(await d.pending.sendScheduled("p", "second", identity, true, () => {})).toEqual({ ok: true });
});

it("types nothing into a password prompt that wrapped mid-word at the open device's width", async () => {
  const d = delivery("idle", undefined, 15);
  const identity = await d.pending.scheduledIdentity("p");
  d.shown.screen = "Enter passphras\ne for key '/tmp\n/key': ";
  expect((await d.pending.sendScheduled("p", "continue", identity, true, () => {})).ok).toBe(false);
  expect(d.writes).toEqual([]);
});

it("lets no queued message of a connection go on its own while a scheduled one may sit in the pane's input", async () => {
  const writes: string[] = [];
  spyOn(herdr, "paneProcessInfo").mockImplementation(async () =>
    ({ pane_id: "p", shell_pid: 41000, foreground_processes: [{ pid: 41001, name: "codex", argv: ["codex"] }] }) as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  spyOn(processStart, "processStartedAtAsync").mockResolvedValue(1000);
  spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: "› Ask Codex to do anything\n" }) as Awaited<ReturnType<typeof herdr.paneRead>>);
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text) => { writes.push(text); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys) => { writes.push(keys.join(",")); });
  const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: () => 1 };
  owner.data.attached.set("p", { keepSize: false });
  const pane = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "codex", agent_status: "working", focused: false, revision: 0 };
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 80 };
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(_pane: string, run: () => T | Promise<T>): Promise<T> => { const next = tail.catch(() => {}).then(run); tail = next; return next; };
  let uncertain = true;
  const delivery = createPendingDelivery({
    options: { submitDelayMs: 0 }, clients: new Set([owner]), attachments: new Map(), sight: () => ({ facts: () => facts, write: () => {} }), serialize,
    lastTyped: new Map(), submitText: async () => {}, authorizeSocket: () => {}, clientSnapshot: async () => ({ panes: [pane] }), omo: { sessionOf: () => null },
    scheduledUncertain: () => uncertain, SUBMIT_DEADLINE_MS: 1000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  } as unknown as Parameters<typeof createPendingDelivery>[0]);
  await delivery.pendingFrames.submit(owner as never, { type: "submit", id: 1, pane_id: "p", text: "queued", payload: "unused", delivery: "queue" } as never);
  pane.agent_status = "idle";
  delivery.pending.status("p", "idle");
  delivery.drainPending("p");
  await serialize("p", () => {});
  expect(writes).toEqual([]);
  uncertain = false;
  delivery.drainPending("p");
  await serialize("p", () => {});
  await serialize("p", () => {});
  expect(writes).toEqual(["\u001b[200~queued\u001b[201~", "Enter"]);
});

it("types nothing into a wrapped password prompt below a row of wide characters, reading the open device's width", async () => {
  const d = delivery("idle", undefined, 15);
  const identity = await d.pending.scheduledIdentity("p");
  d.shown.screen = "👨‍👩‍👧‍👦👨‍👩‍👧‍👦\nEnter passphras\ne for key '/tmp\n/key': ";
  expect(await d.pending.sendScheduled("p", "continue", identity, true, () => {})).toMatchObject({ ok: false, code: "agent_blocked" });
  expect(d.writes).toEqual([]);
});

it("waits, typing nothing, while no device has the pane open to tell its width (#2951)", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  d.attachments.clear();
  expect(await d.pending.sendScheduled("p", "continue", identity, true, () => {})).toMatchObject({ ok: false, code: "input_not_ready" });
  expect(await d.pending.sendScheduled("p", "continue", identity, false, () => {})).toMatchObject({ ok: false, code: "input_not_ready" });
  expect(d.writes).toEqual([]);
});

it("waits, typing nothing, while another bridge holds the pane (#2951)", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  d.attachments.set("p", { cols: 80, rows: 24, held: true });
  expect(await d.pending.sendScheduled("p", "continue", identity, true, () => {})).toMatchObject({ ok: false, code: "attach_held" });
  expect(d.writes).toEqual([]);
});

it("types nothing once the last device leaves the pane while the send reads it (#2951)", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  spyOn(herdr, "paneRead").mockImplementation(async () => { d.attachments.clear(); return { text: "Enter passphras\ne: " } as Awaited<ReturnType<typeof herdr.paneRead>>; });
  expect((await d.pending.sendScheduled("p", "continue", identity, true, () => {})).ok).toBe(false);
  expect(d.writes).toEqual([]);
});

it("waits, typing nothing, while the pane's status has not changed since this server started (#2951)", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  d.pending.pending.forget("p");
  d.pending.pending.status("p", "idle");
  expect(await d.pending.sendScheduled("p", "continue", identity, true, () => {})).toMatchObject({ ok: false, code: "awaiting_status" });
  expect(d.writes).toEqual([]);
  d.pending.pending.status("p", "working");
  d.pending.pending.status("p", "idle");
  expect(await d.pending.sendScheduled("p", "continue", identity, true, () => {})).toEqual({ ok: true });
});

it("keeps a connection's queued message queued, typing nothing, while a scheduled paste may sit in an idle pane's input", async () => {
  const writes: string[] = [];
  spyOn(herdr, "paneProcessInfo").mockImplementation(async () =>
    ({ pane_id: "p", shell_pid: 41000, foreground_processes: [{ pid: 41001, name: "codex", argv: ["codex"] }] }) as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  spyOn(processStart, "processStartedAtAsync").mockResolvedValue(1000);
  spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: "› Ask Codex to do anything\n" }) as Awaited<ReturnType<typeof herdr.paneRead>>);
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text) => { writes.push(text); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys) => { writes.push(keys.join(",")); });
  const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: () => 1 };
  owner.data.attached.set("p", { keepSize: false });
  const pane = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "codex", agent_status: "idle", focused: false, revision: 0 };
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 80 };
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(_pane: string, run: () => T | Promise<T>): Promise<T> => { const next = tail.catch(() => {}).then(run); tail = next; return next; };
  const delivery = createPendingDelivery({
    options: { submitDelayMs: 0 }, clients: new Set([owner]), attachments: new Map(), sight: () => ({ facts: () => facts, write: () => {} }), serialize,
    lastTyped: new Map(), submitText: async () => {}, authorizeSocket: () => {}, clientSnapshot: async () => ({ panes: [pane] }), omo: { sessionOf: () => null },
    scheduledUncertain: () => true, SUBMIT_DEADLINE_MS: 1000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  } as unknown as Parameters<typeof createPendingDelivery>[0]);
  delivery.pending.status("p", "idle");
  await delivery.pendingFrames.submit(owner as never, { type: "submit", id: 1, pane_id: "p", text: "queued", payload: "unused", delivery: "queue" } as never);
  await serialize("p", () => {});
  expect(writes).toEqual([]);
  expect(delivery.pending.waiting("p")).toBe(true);
});

it("sends a message ending with a colon whose own paste is the input's last row", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  d.pending.pending.status("p", "idle");
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text) => { d.writes.push(text); d.shown.screen = "› Next steps:"; });
  expect(await d.pending.sendScheduled("p", "Next steps:", identity, true, () => {})).toEqual({ ok: true });
  expect(d.writes).toEqual(["\u001b[200~Next steps:\u001b[201~", "Enter"]);
});

it("types nothing when the open device resizes the pane while its screen is read (#2951)", async () => {
  const d = delivery("idle", undefined, 15);
  const identity = await d.pending.scheduledIdentity("p");
  spyOn(herdr, "paneRead").mockImplementation(async () => { d.attachments.set("p", { cols: 80, rows: 24 }); return { text: "Enter passphras\ne for key '/tmp\n/key': " } as Awaited<ReturnType<typeof herdr.paneRead>>; });
  expect((await d.pending.sendScheduled("p", "continue", identity, true, () => {})).ok).toBe(false);
  expect(d.writes).toEqual([]);
});

it("refuses Send now, typing nothing, while a queued message to the pane may sit in its input (#2951)", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  const queued = d.pending.pending.enqueue(FIRST_MESSAGE_OWNER, "p", -1, "earlier", null, identity);
  expect(d.pending.pending.claim(queued, false)).toBe(true);
  d.pending.pending.settle(queued, { code: "submit_changed", message: "not confirmed" }, true);
  expect(await d.pending.sendScheduled("p", "continue", identity, false, () => {})).toMatchObject({ ok: false, code: "pending_uncertain" });
  expect(d.writes).toEqual([]);
});

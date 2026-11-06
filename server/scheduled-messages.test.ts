import { afterEach, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "./herdr/client.ts";
import type { PendingIdentity } from "./pending-input.ts";
import { handleScheduledRequest, ScheduledError, ScheduledMessages, type ScheduledDeps } from "./scheduled-messages.ts";

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** the core's pendingText as far as these tests lean on it: trailing line breaks go, and blank text is refused */
const pendingText = (text: string): string => {
  const trimmed = text.replace(/[\r\n]+$/, "");
  if (!trimmed.trim()) throw new Error("A pending chat message must be nonempty text");
  return trimmed;
};
const IDENTITY: PendingIdentity = { agent: "claude", terminalId: "t1", session: "claude:herdr:s1", processPid: 7, processBirth: 1 };
type Send = Parameters<ScheduledDeps["send"]>;

/** A store over a fresh state folder whose sends answer `answers` in turn (ok once they run out). */
function store(answers: Array<{ ok: boolean; code?: string; message?: string } | Error> = [], over: Partial<ScheduledDeps> = {}) {
  const stateDir = over.stateDir ?? mkdtempSync(join(tmpdir(), "ovis-scheduled-"));
  if (!over.stateDir) dirs.push(stateDir);
  const sends: Send[] = [];
  let changes = 0;
  const waiters: Array<() => void> = [];
  const clock = { now: Date.parse("2026-11-05T10:00:00Z") };
  const scheduled = new ScheduledMessages({
    stateDir, checkText: pendingText, identity: async () => ({ ...IDENTITY }), mayDrive: () => true, changed: () => { changes++; }, now: () => clock.now,
    send: async (...args) => {
      sends.push(args);
      args[4]();
      waiters.shift()?.();
      const answer = answers.shift() ?? { ok: true };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    ...over,
  });
  stops.push(() => scheduled.stop());
  const sent = () => new Promise<void>((resolve) => { waiters.push(resolve); });
  return { scheduled, sends, stateDir, clock, sent, changes: () => changes };
}

/** every fake here answers in microtasks: a macrotask turn sees each delivery settled */
const settle = () => new Promise<void>((resolve) => { setImmediate(resolve); });

it("keeps a scheduled message in the state folder, readable only by this user, and lists it after a restart", async () => {
  const { scheduled, stateDir } = store();
  const message = await scheduled.create({ pane_id: "p1", text: "continue\r\n", send_at: "2026-11-05T21:00:00+09:00" }, "dev1");
  expect(message).toMatchObject({ pane_id: "p1", text: "continue", send_at: "2026-11-05T12:00:00.000Z", state: "scheduled" });
  const file = join(stateDir, "scheduled-messages.json");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  const again = new ScheduledMessages({ stateDir, checkText: pendingText, identity: async () => IDENTITY, send: async () => ({ ok: true }), mayDrive: () => true, changed: () => {}, now: () => Date.parse("2026-11-05T10:00:00Z") });
  expect(again.list()).toEqual([message]);
});

it("sends a due message to the identity it was scheduled for, then removes it", async () => {
  const { scheduled, sends, clock } = store();
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T10:00:00Z" }, null);
  clock.now += 1;
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(sends.map(([pane, text, identity, automatic]) => [pane, text, identity, automatic])).toEqual([["p1", "continue", IDENTITY, true]]);
  expect(scheduled.list()).toEqual([]);
});

it("sends a message at its time from the timer alone, with no pane event", async () => {
  const { scheduled, sends, sent, clock } = store();
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: new Date(clock.now + 20).toISOString() }, null);
  clock.now += 20;
  const delivered = sent();
  scheduled.start();
  await delivered;
  expect(sends).toHaveLength(1);
});

it("waits while the agent works, saying why, and goes at the pane's next event", async () => {
  const { scheduled, sends } = store([{ ok: false, code: "pending_wait", message: "The agent is working again" }]);
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(scheduled.list()[0]).toMatchObject({ state: "scheduled", error: { code: "pending_wait" } });
  scheduled.paneEvent("p1");
  await settle();
  expect(sends).toHaveLength(2);
  expect(scheduled.list()).toEqual([]);
});

it("never types over a draft: input_draft keeps it waiting", async () => {
  const { scheduled } = store([{ ok: false, code: "input_draft", message: "Claude Code's input box is not empty" }]);
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(scheduled.list()[0]).toMatchObject({ state: "scheduled", error: { code: "input_draft" } });
});

it("holds a message whose pane now runs another session, until the user sends or discards it", async () => {
  const { scheduled, sends } = store([{ ok: false, code: "pending_target_changed", message: "changed" }]);
  const message = await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(scheduled.list()[0]).toMatchObject({ state: "held", error: { code: "pending_target_changed" } });
  scheduled.paneEvent("p1");
  await settle();
  expect(sends).toHaveLength(1);
  expect(await scheduled.sendNow({ id: message.id }, null)).toEqual({ ok: true });
  expect(sends[1]![3]).toBe(false);
  expect(scheduled.list()).toEqual([]);
});

it("holds a message for a pane that is gone", async () => {
  const { scheduled } = store([new HerdrError("pane_not_found", "pane p1 not found")]);
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(scheduled.list()[0]).toMatchObject({ state: "held", error: { code: "pane_not_found" } });
});

it("claims a message before typing: a Send now during its send is refused and it goes once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sends: Send[] = [];
  const { scheduled } = store([], { send: async (...args) => { sends.push(args); await gate; return { ok: true }; } });
  const message = await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  scheduled.paneEvent("p1");
  expect(scheduled.list()[0]!.state).toBe("sending");
  await expect(scheduled.sendNow({ id: message.id }, null)).rejects.toMatchObject({ code: "pending_busy" });
  expect(() => scheduled.discard({ id: message.id })).toThrow(ScheduledError);
  release();
  await settle();
  expect(sends).toHaveLength(1);
});

it("never sends again on its own a message the PC stopped in the middle of", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-scheduled-"));
  dirs.push(stateDir);
  writeFileSync(join(stateDir, "scheduled-messages.json"), JSON.stringify([{ identity: IDENTITY, device: null,
    message: { id: "a", pane_id: "p1", text: "continue", send_at: "2026-11-05T09:00:00Z", created_at: "2026-11-05T08:00:00Z", state: "sending" } }]));
  const { scheduled, sends } = store([], { stateDir });
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(sends).toEqual([]);
  expect(scheduled.list()[0]).toMatchObject({ state: "uncertain", error: { code: "submit_changed" } });
  await expect(scheduled.sendNow({ id: "a" }, null)).rejects.toMatchObject({ code: "pending_uncertain" });
});

it("does not send for a device that may no longer drive this PC", async () => {
  let drives = true;
  const { scheduled, sends } = store([], { mayDrive: () => drives });
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, "dev1");
  drives = false;
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(sends).toEqual([]);
  expect(scheduled.list()[0]).toMatchObject({ state: "held", error: { code: "device_revoked" } });
});

it("edits a held message back to scheduled, and follows its pane when herdr moves it", async () => {
  const { scheduled } = store([{ ok: false, code: "pending_target_changed", message: "changed" }]);
  const message = await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  scheduled.stop();
  expect(scheduled.update({ id: message.id, text: "go on", send_at: "2026-11-05T12:00:00Z" })).toMatchObject({ text: "go on", state: "scheduled", send_at: "2026-11-05T12:00:00.000Z" });
  expect(scheduled.list()[0]!.error).toBeUndefined();
  scheduled.paneMoved("p1", "p9");
  expect(scheduled.list()[0]!.pane_id).toBe("p9");
});

it("refuses a time more than 30 days ahead, an empty text and a pane that is gone", async () => {
  const { scheduled } = store([], { identity: async () => { throw new HerdrError("pane_not_found", "gone"); } });
  await expect(scheduled.create({ pane_id: "p1", text: "x", send_at: "2026-12-06T10:00:00Z" }, null)).rejects.toMatchObject({ code: "invalid_send_at" });
  await expect(scheduled.create({ pane_id: "p1", text: " \n", send_at: "2026-11-05T11:00:00Z" }, null)).rejects.toMatchObject({ code: "invalid_submit_text" });
  await expect(scheduled.create({ pane_id: "p1", text: "x", send_at: "2026-11-05T11:00:00Z" }, null)).rejects.toMatchObject({ code: "pane_not_found", status: 404 });
});

it("answers a watching device read_only, and lists and creates for one that drives", async () => {
  const { scheduled } = store();
  const post = (path: string, body: unknown) => new Request(`http://pc${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const watch = await handleScheduledRequest(new Request("http://pc/api/scheduled"), "/api/scheduled", scheduled, { readOnly: true, device: "w" });
  expect(watch?.status).toBe(403);
  const created = await handleScheduledRequest(post("/api/scheduled", { pane_id: "p1", text: "continue", send_at: "2026-11-05T11:00:00Z" }), "/api/scheduled", scheduled, { readOnly: false, device: "d" });
  expect(created?.status).toBe(201);
  const listed = await handleScheduledRequest(new Request("http://pc/api/scheduled"), "/api/scheduled", scheduled, { readOnly: false, device: "d" });
  expect(((await listed!.json()) as { messages: unknown[] }).messages).toHaveLength(1);
  expect(await handleScheduledRequest(new Request("http://pc/api/scheduledx"), "/api/scheduledx", scheduled, { readOnly: false, device: "d" })).toBeNull();
});

it("keeps the session a message was scheduled for when a Send now to another one is refused", async () => {
  const other: PendingIdentity = { ...IDENTITY, session: "claude:herdr:s2" };
  let current = IDENTITY;
  const { scheduled, sends } = store([{ ok: false, code: "agent_blocked", message: "waits for an answer" }], { identity: async () => ({ ...current }) });
  const message = await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  current = other;
  expect(await scheduled.sendNow({ id: message.id }, null)).toMatchObject({ ok: false });
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  // Send now goes to the session it was scheduled for until its row says the pane runs another (#2951)
  expect(sends.map((send) => send[2].session)).toEqual(["claude:herdr:s1", "claude:herdr:s1"]);
});

it("leaves a message as it was when an edit is refused", async () => {
  const { scheduled } = store();
  const message = await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T11:00:00Z" }, null);
  expect(() => scheduled.update({ id: message.id, text: "something else", send_at: "2027-01-01T00:00:00Z" })).toThrow(ScheduledError);
  expect(scheduled.list()[0]!.text).toBe("continue");
});

it("sets an unreadable state file aside instead of writing over it", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-scheduled-"));
  dirs.push(stateDir);
  writeFileSync(join(stateDir, "scheduled-messages.json"), "{ not json");
  const { scheduled } = store([], { stateDir });
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T11:00:00Z" }, null);
  const kept = readdirSync(stateDir).filter((name) => name.startsWith("scheduled-messages.json.unreadable-"));
  expect(kept).toHaveLength(1);
  expect(readFileSync(join(stateDir, kept[0]!), "utf8")).toBe("{ not json");
});

it("sends nothing more into a pane while one of its messages may sit typed in its input", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-scheduled-"));
  dirs.push(stateDir);
  const entry = (id: string, state: string) => ({ identity: IDENTITY, device: null,
    message: { id, pane_id: "p1", text: id, send_at: "2026-11-05T09:00:00Z", created_at: "2026-11-05T08:00:00Z", state } });
  writeFileSync(join(stateDir, "scheduled-messages.json"), JSON.stringify([entry("a", "sending"), entry("b", "scheduled")]));
  const { scheduled, sends } = store([], { stateDir });
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(sends).toEqual([]);
  expect(scheduled.list().find((message) => message.id === "b")).toMatchObject({ state: "held", error: { code: expect.stringMatching(/^needs_ok/) } });
});

it("asks for the user's OK on a due message once its pane has one that may sit in its input", async () => {
  const { scheduled, sends, clock } = store([{ ok: false, code: "pasted_not_sent", message: "pasted" }]);
  await scheduled.create({ pane_id: "p1", text: "first", send_at: "2026-11-05T09:59:00Z" }, null);
  await scheduled.create({ pane_id: "p1", text: "second", send_at: "2026-11-05T10:30:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  clock.now = Date.parse("2026-11-05T10:31:00Z");
  scheduled.paneEvent("p1");
  await settle();
  expect(sends.map((send) => send[1])).toEqual(["first"]);
  expect(scheduled.list().find((message) => message.text === "second")).toMatchObject({ state: "held", error: { code: "needs_ok" } });
});

it("asks for the user's OK on a message already due when the server starts again", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-scheduled-"));
  dirs.push(stateDir);
  writeFileSync(join(stateDir, "scheduled-messages.json"), JSON.stringify([{ identity: IDENTITY, device: null,
    message: { id: "a", pane_id: "p1", text: "a", send_at: "2026-11-05T09:00:00Z", created_at: "2026-11-05T08:00:00Z", state: "scheduled" } },
    { identity: IDENTITY, device: null,
    message: { id: "b", pane_id: "p1", text: "b", send_at: "2026-11-05T12:00:00Z", created_at: "2026-11-05T08:00:00Z", state: "scheduled" } }]));
  const { scheduled, sends } = store([], { stateDir });
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(sends).toEqual([]);
  expect(scheduled.list().map((message) => [message.id, message.state, message.error?.code])).toEqual([["a", "held", "needs_ok_restart"], ["b", "scheduled", undefined]]);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("leaves a message as it was when its edit or discard cannot be written", async () => {
  const { scheduled, stateDir } = store();
  const message = await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T11:00:00Z" }, null);
  chmodSync(stateDir, 0o500);
  try {
    expect(() => scheduled.update({ id: message.id, text: "edited" })).toThrow();
    expect(() => scheduled.discard({ id: message.id })).toThrow();
    expect(scheduled.list()).toEqual([message]);
  } finally { chmodSync(stateDir, 0o700); }
});

it("keeps a message the server stopped before typing for its next start", async () => {
  const { scheduled } = store([{ ok: false, code: "cancelled", message: "This PC's server is stopping" }]);
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(scheduled.list()[0]!.state).toBe("scheduled");
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps nothing of a message whose write was refused", async () => {
  const { scheduled, stateDir } = store();
  chmodSync(stateDir, 0o500);
  try {
    await expect(scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T11:00:00Z" }, null)).rejects.toThrow();
    expect(scheduled.list()).toEqual([]);
  } finally { chmodSync(stateDir, 0o700); }
});

it("holds the pane's queued messages behind a send it may have left in the input", async () => {
  const held: string[] = [];
  const { scheduled } = store([{ ok: false, code: "pasted_not_sent", message: "pasted" }], { uncertain: (paneId) => { held.push(paneId); } });
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(scheduled.list()[0]!.state).toBe("uncertain");
  expect(held).toEqual(["p1"]);
});

it("sets no timer for a message waiting behind its pane's message on its way", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-scheduled-"));
  dirs.push(stateDir);
  const entry = (id: string, state: string) => ({ identity: IDENTITY, device: null,
    message: { id, pane_id: "p1", text: id, send_at: "2026-11-05T09:00:00Z", created_at: "2026-11-05T08:00:00Z", state } });
  writeFileSync(join(stateDir, "scheduled-messages.json"), JSON.stringify([entry("a", "uncertain"), entry("b", "scheduled")]));
  const timers = spyOn(globalThis, "setTimeout");
  const { scheduled } = store([], { stateDir });
  scheduled.start();
  await settle();
  expect(timers.mock.calls.filter(([, ms]) => typeof ms === "number" && ms < 1000)).toHaveLength(0);
  timers.mockRestore();
});

it("keeps a held message held when its edit leaves the time in the past: Save never sends it", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-scheduled-"));
  dirs.push(stateDir);
  writeFileSync(join(stateDir, "scheduled-messages.json"), JSON.stringify([{ identity: IDENTITY, device: null,
    message: { id: "a", pane_id: "p1", text: "a", send_at: "2026-11-05T09:00:00Z", created_at: "2026-11-05T08:00:00Z", state: "scheduled" } }]));
  const { scheduled, sends } = store([], { stateDir });
  scheduled.start();
  expect(scheduled.update({ id: "a", text: "edited" })).toMatchObject({ text: "edited", state: "held", error: { code: "needs_ok_restart" } });
  scheduled.paneEvent("p1");
  await settle();
  expect(sends).toEqual([]);
  expect(scheduled.update({ id: "a", send_at: "2026-11-05T11:00:00Z" })).toMatchObject({ state: "scheduled" });
});

it("asks for the user's OK on every scheduled message of a pane herdr moved", async () => {
  const { scheduled, sends, clock } = store();
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T10:30:00Z" }, null);
  scheduled.start();
  scheduled.paneMoved("p1", "p9");
  clock.now = Date.parse("2026-11-05T10:31:00Z");
  scheduled.paneEvent("p9");
  await settle();
  expect(sends).toEqual([]);
  expect(scheduled.list()[0]).toMatchObject({ pane_id: "p9", state: "held", error: { code: "needs_ok_moved" } });
});

it("schedules nothing for a pane with no program in front, which any agent started there later would receive", async () => {
  const { scheduled } = store([], { identity: async () => ({ agent: "codex", terminalId: "t1", session: null, processPid: null, processBirth: null }) });
  await expect(scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T11:00:00Z" }, null)).rejects.toMatchObject({ code: "agent_not_ready" });
  expect(scheduled.list()).toEqual([]);
});

it("sends an edited message only while the editing device may still drive this PC", async () => {
  const paired = new Set(["A", "B"]);
  const { scheduled, sends, clock } = store([], { mayDrive: (device) => device === null || paired.has(device) });
  const message = await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T10:30:00Z" }, "A");
  scheduled.update({ id: message.id, text: "edited by B" }, "B");
  paired.delete("B");
  scheduled.start();
  clock.now = Date.parse("2026-11-05T10:31:00Z");
  scheduled.paneEvent("p1");
  await settle();
  expect(sends).toEqual([]);
  expect(scheduled.list()[0]).toMatchObject({ state: "held", error: { code: "device_revoked" } });
});

it("refuses a time more than a minute past, which would only ever be sent at once", async () => {
  const { scheduled } = store();
  await expect(scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:00:00Z" }, null)).rejects.toMatchObject({ code: "invalid_send_at" });
  const message = await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T11:00:00Z" }, null);
  expect(() => scheduled.update({ id: message.id, send_at: "2026-11-05T09:00:00Z" })).toThrow(ScheduledError);
});

it("asks for the user's OK when herdr moved the pane while a send to it was refused", async () => {
  let release!: (reply: { ok: boolean; code?: string; message?: string }) => void;
  const sends: Send[] = [];
  const { scheduled } = store([], { send: async (...args) => { sends.push(args); return await new Promise((resolve) => { release = resolve; }); } });
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:30Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  scheduled.paneMoved("p1", "p9");
  release({ ok: false, code: "agent_not_ready", message: "not yet" });
  await settle();
  scheduled.paneEvent("p9");
  await settle();
  expect(sends).toHaveLength(1);
  expect(scheduled.list()[0]).toMatchObject({ pane_id: "p9", state: "held", error: { code: "needs_ok_moved" } });
});

it("holds every message of a pane that ended, one left uncertain included, so every pane's list shows it (#2951)", async () => {
  const { scheduled } = store([{ ok: false, code: "pasted_not_sent", message: "pasted" }]);
  await scheduled.create({ pane_id: "p1", text: "first", send_at: "2026-11-05T09:59:00Z" }, null);
  await scheduled.create({ pane_id: "p1", text: "second", send_at: "2026-11-05T11:00:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(scheduled.list()[0]!.state).toBe("uncertain");
  scheduled.paneGone("p1");
  // the uncertain one stays never-resendable: it may have gone already
  expect(scheduled.list().map((message) => [message.text, message.state, message.error?.code])).toEqual([["first", "uncertain", "pane_not_found"], ["second", "held", "pane_not_found"]]);
});

it("lets the pane's queued messages go again once its uncertain scheduled message is discarded (#2951)", async () => {
  const released: string[] = [];
  const { scheduled } = store([{ ok: false, code: "pasted_not_sent", message: "pasted" }], { released: (paneId) => { released.push(paneId); } });
  const message = await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  scheduled.discard({ id: message.id });
  expect(released).toEqual(["p1"]);
});

it("sends a Send now to the session the message was scheduled for, not one that replaced it unseen (#2951)", async () => {
  const other: PendingIdentity = { ...IDENTITY, session: "claude:herdr:s2", processPid: 8 };
  const { scheduled, sends } = store([], { identity: async () => ({ ...other }) });
  const message = await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T11:00:00Z" }, null);
  await scheduled.sendNow({ id: message.id }, null);
  expect(sends[0]![2]).toEqual(other);
  const bound = store([]);
  const kept = await bound.scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T11:00:00Z" }, null);
  // the pane now runs another session, which the row has not said
  (bound.scheduled as unknown as { deps: ScheduledDeps }).deps.identity = async () => ({ ...other });
  await bound.scheduled.sendNow({ id: kept.id }, null);
  expect(bound.sends[0]![2]).toEqual(IDENTITY);
});

it("refuses Send now while another of the pane's messages may sit in its input (#2951)", async () => {
  const { scheduled, sends } = store([{ ok: false, code: "pasted_not_sent", message: "pasted" }]);
  await scheduled.create({ pane_id: "p1", text: "first", send_at: "2026-11-05T09:59:00Z" }, null);
  const second = await scheduled.create({ pane_id: "p1", text: "second", send_at: "2026-11-05T11:00:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  await expect(scheduled.sendNow({ id: second.id }, null)).rejects.toMatchObject({ code: "pending_uncertain" });
  expect(sends.map((send) => send[1])).toEqual(["first"]);
});

it("holds a message whose pane ended while it was being sent, once that send is refused (#2951)", async () => {
  let release: (answer: { ok: boolean; code?: string; message?: string }) => void = () => {};
  const { scheduled } = store([], { send: () => new Promise((resolve) => { release = resolve; }) });
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  scheduled.paneGone("p1");
  release({ ok: false, code: "input_not_ready", message: "no device" });
  await settle();
  expect(scheduled.list()[0]).toMatchObject({ state: "held", error: { code: "pane_not_found" } });
});

it("keeps a copy of a state file with an entry it cannot read, before writing over it (#2951)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-scheduled-"));
  dirs.push(stateDir);
  const raw = JSON.stringify([{ identity: IDENTITY, device: null, message: { id: "a", pane_id: "p1", text: "a", send_at: "not a date", created_at: "2026-11-05T08:00:00Z", state: "scheduled" } }]);
  writeFileSync(join(stateDir, "scheduled-messages.json"), raw);
  const { scheduled } = store([], { stateDir });
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T11:00:00Z" }, null);
  const kept = readdirSync(stateDir).filter((name) => name.startsWith("scheduled-messages.json.unreadable-"));
  expect(kept).toHaveLength(1);
  expect(readFileSync(join(stateDir, kept[0]!), "utf8")).toBe(raw);
});

it("keeps a message waiting for its pane's first status change since a restart, and sends it at the next event (#2951)", async () => {
  const { scheduled, sends } = store([{ ok: false, code: "awaiting_status", message: "waits for the agent's next status change" }]);
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(scheduled.list()[0]).toMatchObject({ state: "scheduled", error: { code: "awaiting_status" } });
  scheduled.paneEvent("p1");
  await settle();
  expect(sends).toHaveLength(2);
  expect(scheduled.list()).toEqual([]);
});

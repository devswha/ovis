// The queue's turn gate (#4118): once the queue has typed a message and its Enter, it types no further message of the
// pane until statuses that came after that Enter have shown the turn to start and to finish. A pane with Codex in
// front and one page, as in pending-left-lease.test.ts: the real createPendingDelivery, PendingInputs and
// interruptCodexSteering, with herdr's client faked. `on.keys` is what herdr and the agent do as a key lands.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { StatusCollectorDeps } from "../collector.ts";
import * as herdr from "../herdr/client.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { PendingInputs } from "../pending-input.ts";
import * as processStart from "../process-start.ts";
import { connectionData } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";
import { handlers, hub, originalCollector, root } from "./status.fake.ts";

afterEach(() => { mock.restore(); });

type Row = { id: string; state: string; text: string; error?: { code: string } };
const steeringPanel = (entry: string) => `• Working (2s • esc to interrupt)\n• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\n  ↳ ${entry}\n› Ask Codex to do anything\n  gpt-6.1 default · /workspace\n`;

function pane() {
  const typed: string[] = [];
  const now = { status: "working", screen: "" };
  const on: { keys?: (keys: string[]) => void; read?: (count: number) => void } = {};
  let reads = 0;
  spyOn(processStart, "processStartedAtAsync").mockImplementation(async () => 1000);
  spyOn(herdr, "paneProcessInfo").mockImplementation(async () => ({ pane_id: "p", shell_pid: 41000, foreground_processes: [{ pid: 41001, name: "codex", argv: ["codex"] }] }) as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  spyOn(herdr, "paneRead").mockImplementation(async () => { on.read?.(++reads); return { text: now.screen } as Awaited<ReturnType<typeof herdr.paneRead>>; });
  // as herdrRpc does: the guard is asked right before the write, and a refused write sends nothing
  const refused = (guard?: () => boolean): void => { if (guard && !guard()) throw new herdr.HerdrError("cancelled", "the write was withheld"); };
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text, _socket, guard) => { refused(guard); typed.push(text.replace("\u001b[200~", "paste:").replace("\u001b[201~", "")); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys, _socket, guard) => { refused(guard); typed.push(keys.join(",")); on.keys?.(keys); });
  const page = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: () => 1 };
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(_pane: string, run: () => T | Promise<T>): Promise<T> => { const next = tail.catch(() => {}).then(run); tail = next; return next; };
  const delivery = createPendingDelivery({
    options: { submitDelayMs: 0 }, clients: new Set<unknown>([page]), attachments: new Map(), serialize, lastTyped: new Map(),
    sight: () => ({ facts: () => ({ attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true,
      ready: true, held: false, currentHeld: false, mirror: false, cols: 80 }), write: () => {} }),
    submitText: async () => { typed.push("immediate"); },
    authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [{ pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "codex", agent_status: now.status, focused: false, revision: 0 }] }),
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  } as unknown as Parameters<typeof createPendingDelivery>[0]);
  const settled = async () => {
    for (let turn = 0; turn < 20; turn++) {
      for (let before: unknown; before !== tail;) { before = tail; await tail.catch(() => {}); }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  page.data.attached.set("p", { keepSize: false });
  /** what status.ts does with a status event of herdr's: pending.status, then drainPending */
  const event = (status: "working" | "idle"): void => { delivery.pending.status("p", status); delivery.drainPending("p"); };
  let id = 0;
  /** a chat message sent while the agent works: pendingFrames.submit with delivery "queue" */
  const queue = async (text: string): Promise<void> => { await delivery.pendingFrames.submit(page as never, { type: "submit", id: ++id, pane_id: "p", text, payload: text, delivery: "queue" } as never); };
  const rows = (): string[] => (delivery.pending.list(page as never, "p") as Row[]).map((row) => `${row.text} ${row.state}`);
  /** Send now on a pending row: pendingFrames["pending-action"], action "steer" */
  const sendNow = (text: string): Promise<void> => {
    const row = (delivery.pending.list(page as never, "p") as Row[]).find((candidate) => candidate.text === text);
    if (!row) throw new Error(`no row ${text}`);
    return delivery.pendingFrames["pending-action"](page as never, { type: "pending-action", id: ++id, pane_id: "p", pending_id: row.id, action: "steer" } as never);
  };
  /** herdr reads the turn the queue's last Enter started, and its end: the queue goes on */
  const turnSeen = async (): Promise<void> => {
    on.keys = undefined;
    now.status = "working"; event("working");
    now.status = "idle"; event("idle");
    await settled();
  };
  return { delivery, typed, now, on, settled, event, queue, rows, sendNow, turnSeen };
}

describe("the queue's turn gate (#4118)", () => {
  it("A: types nothing behind a Send now whose Enter landed as the turn ended, until that Enter's own turn is seen", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    await d.queue("Y");
    // every read of X's send says working; its Enter lands as the turn ends, and that turn's idle is applied right after
    d.on.keys = (keys) => {
      if (!keys.includes("Enter") || d.typed.filter((key) => key === "Enter").length !== 1) return;
      d.now.status = "idle";
      d.event("idle");
    };
    await d.sendNow("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.rows()).toEqual(["Y queued"]);
    await d.turnSeen();
    expect(d.typed).toEqual(["paste:X", "Enter", "paste:Y", "Enter"]);
  });

  it("A': a ready told just before a Send now's Enter makes that Enter a turn of its own, which a later submit's idle reading does not end", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    await d.queue("Y");
    // the 6th screen read of a Send now is the last before its Enter (noMaskedPrompt), after the read that said working
    d.on.read = (count) => { if (count === 6) { d.now.status = "idle"; d.delivery.pending.status("p", "idle"); } };
    await d.sendNow("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    // herdr still reads idle (X's turn has begun, herdr has not said so); the user queues Z
    await d.queue("Z");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.rows()).toEqual(["Y queued", "Z queued"]);
  });

  it("B: status events that a snapshot overtook say nothing of the turn the queue's Enter started", async () => {
    const d = pane();
    // herdr's working event is still on its way when X is queued from a snapshot that says working
    await d.queue("X");
    // the turn ends, and the snapshot of Y's submit says so before the events do: the queue takes up X
    d.now.status = "idle";
    // as X's Enter is written, the two events of the old turn are applied
    d.on.keys = (keys) => {
      if (!keys.includes("Enter") || d.typed.filter((key) => key === "Enter").length !== 1) return;
      d.event("working");
      d.event("idle");
    };
    await d.queue("Y");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.rows()).toEqual(["Y queued"]);
    await d.turnSeen();
    expect(d.typed).toEqual(["paste:X", "Enter", "paste:Y", "Enter"]);
  });

  it("C: a second Send now during a Codex restart keeps waiting for the restarted turn to start", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    await d.queue("Y");
    await d.queue("Z");
    // Send now on X: after its Enter Codex shows it in the steering panel, and Escape is pressed
    d.on.keys = (keys) => {
      if (keys.includes("Enter")) d.now.screen = steeringPanel("X");
      if (keys.includes("Escape")) d.now.screen = "";
    };
    await d.sendNow("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter", "Escape"]);
    // Send now on Y while herdr still reads working; herdr's idle for the interruption is applied after Y's Enter
    d.on.keys = (keys) => {
      if (!keys.includes("Enter")) return;
      d.now.status = "idle";
      d.event("idle");
    };
    await d.sendNow("Y");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter", "Escape", "paste:Y", "Enter"]);
    expect(d.rows()).toEqual(["Z queued"]);
    await d.turnSeen();
    expect(d.typed.slice(-2)).toEqual(["paste:Z", "Enter"]);
  });

  it("C control: without the second Send now, the interruption's idle types nothing", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    await d.queue("Y");
    d.on.keys = (keys) => {
      if (keys.includes("Enter")) d.now.screen = steeringPanel("X");
      if (keys.includes("Escape")) d.now.screen = "";
    };
    await d.sendNow("X");
    await d.settled();
    d.now.status = "idle";
    d.event("idle");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter", "Escape"]);
    expect(d.rows()).toEqual(["Y queued"]);
  });

  it("E: a message sent to the queue right behind the queue's Enter waits behind that Enter's turn", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    // the turn ends and the queue types X; herdr has not read X's turn yet
    d.now.status = "idle";
    d.event("idle");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    await d.queue("Y");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.rows()).toEqual(["Y queued"]);
    await d.turnSeen();
    expect(d.typed).toEqual(["paste:X", "Enter", "paste:Y", "Enter"]);
  });

  it("D: a reconcile's older idle snapshot, told after the working event of the turn just started, does not end that turn's wait", async () => {
    const PANE = "w1:p1";
    const shown = (status: string) => ({ pane_id: PANE, workspace_id: "w1", tab_id: "w1:t1", agent: "pi", agent_status: status, cwd: root });
    const pending = new PendingInputs<string, null>(() => {});
    const h = hub(undefined, pending);
    // the real collector, with herdr's two channels faked: the status subscription, and a snapshot that can be held
    type Callbacks = Parameters<StatusCollectorDeps["subscribe"]>[1];
    const subscriptions: { types: string[]; callbacks: Callbacks }[] = [];
    let panes = [shown("working")];
    let held: Promise<void> | null = null;
    let released = false;
    const asked = Promise.withResolvers<void>(), reconciled = Promise.withResolvers<void>();
    const collector = originalCollector({ ...handlers, onReconciled: (read: readonly HerdrPane[]) => { handlers.onReconciled(read); if (released) reconciled.resolve(); } } as never, {
      reconnectMinMs: 5, reconnectMaxMs: 40, backstopMs: 60_000, debounceMs: 5, snapshotRetryMs: 5, replaySettleMs: 5,
      subscribe: (subs, callbacks) => { subscriptions.push({ types: subs.map((sub) => sub.type), callbacks }); queueMicrotask(() => callbacks.onStarted?.()); return { close() {} }; },
      snapshot: async () => { const read = { panes: structuredClone(panes) }; if (held) { asked.resolve(); await held; } return read as never; },
    });
    const emit = (status: string) => subscriptions.filter((sub) => sub.types.includes("pane.agent_status_changed")).at(-1)?.callbacks.onEvent({ event: "pane.agent_status_changed", data: { pane_id: PANE, agent_status: status, agent: "pi" } });
    try {
      h.herdrSays(shown("working"));
      await collector.ready;
      emit("working");
      const x = pending.enqueue("a", PANE, 1, "X", null, { agent: "pi", terminalId: PANE, session: null });
      const y = pending.enqueue("a", PANE, 2, "Y", null, { agent: "pi", terminalId: PANE, session: null });
      // the turn ends; the queue types X, as drainPending and dispatchPending do with the class
      panes = [shown("idle")]; h.herdrSays(shown("idle"));
      emit("idle");
      expect(pending.next(PANE)).toBe(x);
      expect(pending.claim(x, true)).toBe(true);
      pending.committing(x);
      pending.settle(x);
      // a reconcile reads its snapshot while herdr still reads the pane at rest, and the read takes a while
      const release = Promise.withResolvers<void>();
      held = release.promise;
      collector.refresh();
      await asked.promise;
      // herdr reads X's turn; then the reconcile goes on with the snapshot it read before that event
      emit("working");
      held = null;
      released = true;
      release.resolve();
      await reconciled.promise;
      expect(pending.next(PANE)).toBeNull();
      emit("idle");
      expect(pending.next(PANE)).toBe(y);
    } finally { collector.stop(); }
  });

  it("ends a Send now's wait without holding the queue when no turn of its own starts after the ready that came right behind it", () => {
    let clock = 0;
    const pending = new PendingInputs<string, null>(() => {}, () => clock, 10);
    const identity = { agent: "codex", terminalId: "p", session: null };
    pending.status("p", "working");
    const x = pending.enqueue("a", "p", 1, "X", null, identity);
    const y = pending.enqueue("a", "p", 2, "Y", null, identity);
    expect(pending.claim(x, false)).toBe(true);
    pending.committing(x, true);
    pending.status("p", "idle");
    pending.settle(x);
    expect(pending.next("p")).toBeNull();
    clock = 10;
    expect(pending.expire()).toEqual(["p"]);
    expect(pending.next("p")).toBe(y);
    expect(y.message.state).toBe("queued");
  });
});

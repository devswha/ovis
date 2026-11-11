import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import * as processStart from "../process-start.ts";
import { connectionData } from "./connections.ts";
import { createPendingDelivery, FIRST_MESSAGE_OWNER } from "./pending.ts";

afterEach(() => mock.restore());

type Frame = { type: string; [key: string]: unknown };
type Row = { id: string; state: string; error?: { code: string } };
const SHELL = 41000, OMP = 41001;
/** an omp that loads herdr's omp integration by its own arguments (ompLoadsIntegration): nothing is read from disk */
const INTEGRATED = ["omp", "-e", "/opt/herdr/herdr-omp-agent-state.ts"];
/** the session herdr's omp integration reports from omp's `session_start`, once omp takes an Enter */
const SESSION = { agent: "omp", kind: "path", source: "herdr:omp", value: "/fixture/session.jsonl" };
const PASTE = "\u001b[200~first words\u001b[201~";
const GONE = { code: "pane_not_found", message: "The pane ended; its pending messages were not sent" };

/**
 * An omp pane herdr shows at rest, as it does once omp has drawn its input box and before omp takes an Enter
 * (composer.ts untilOmpReported). `calls`: each look the wait takes at the pane, then what was written. The
 * clock is this fixture's: `advance` moves it, so a wait runs out or a deadline passes without that time passing.
 */
function omp(setup: { startedAgo?: number; argv?: readonly string[]; reported?: boolean } = {}) {
  const calls: string[] = [], frames: Frame[] = [];
  const pane: Record<string, unknown> = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "omp", agent_status: "idle", focused: false, revision: 0,
    ...(setup.reported ? { agent_session: SESSION } : {}) };
  /** called at each look of the wait and at each read of the pane's screen, with how many there were */
  const hooks: { look?: (looks: number) => void; read?: (reads: number) => void; processes?: (asked: number) => boolean } = {};
  let looks = 0, reads = 0, asked = 0, allowed = true, skew = 0;
  /** herdr answers no snapshot for now; the pane is gone from herdr */
  const herdrNow = { silent: false, paneGone: false };
  const realNow = Date.now.bind(Date);
  spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  // the omp started when it is first asked about, so that its half minute is counted from inside the wait
  let started: number | undefined;
  spyOn(processStart, "processStartedAt").mockImplementation(() => started ??= Date.now() - (setup.startedAgo ?? 0));
  spyOn(processStart, "processStartedAtAsync").mockResolvedValue(1000);
  // `hooks.processes`: whether herdr fails to answer this read of the pane's processes, by how many were asked for
  spyOn(herdr, "paneProcessInfo").mockImplementation(async () => {
    asked += 1;
    if (hooks.processes?.(asked)) throw new herdr.HerdrError("herdr_unavailable", "herdr did not answer");
    return { pane_id: "p", shell_pid: SHELL,
      foreground_processes: pane["agent"] === "omp" ? [{ pid: OMP, name: "omp", argv: setup.argv ?? INTEGRATED }] : [{ pid: SHELL, name: "bash", argv: ["bash"] }] } as Awaited<ReturnType<typeof herdr.paneProcessInfo>>;
  });
  spyOn(herdr, "paneGet").mockImplementation(async () => {
    looks += 1; hooks.look?.(looks); calls.push("look");
    if (herdrNow.paneGone) throw new herdr.HerdrError("pane_not_found", "pane p not found");
    return { ...pane } as unknown as Awaited<ReturnType<typeof herdr.paneGet>>;
  });
  spyOn(herdr, "paneRead").mockImplementation(async () => { reads += 1; hooks.read?.(reads); return { text: "" } as Awaited<ReturnType<typeof herdr.paneRead>>; });
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text) => { calls.push(text); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys) => { calls.push(keys.join(",")); });
  const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (value: string) => { frames.push(JSON.parse(value) as Frame); return 1; } };
  owner.data.attached.set("p", { keepSize: false });
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 80 };
  // the pane's lane: what is typed into the pane waits its turn in it, behind a send that is under way
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(_pane: string, run: () => T | Promise<T>): Promise<T> => { const next = tail.catch(() => {}).then(run); tail = next; return next; };
  const clients = new Set<unknown>([owner]);
  const delivery = createPendingDelivery({
    options: { submitDelayMs: 0, ompReportPollMs: 1 },
    clients, attachments: new Map(), sight: (() => ({ facts: () => facts, write: () => {} })), serialize,
    lastTyped: new Map(), submitText: async () => { calls.push("immediate"); },
    authorizeSocket: () => { if (!allowed) throw new herdr.HerdrError("read_only", "this device may only watch"); },
    clientSnapshot: async () => {
      if (herdrNow.silent) throw new herdr.HerdrError("herdr_unavailable", "herdr did not answer");
      return { panes: herdrNow.paneGone ? [] : [pane] };
    },
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  } as unknown as Parameters<typeof createPendingDelivery>[0]);
  const result = (type: string, id: number) => frames.find((frame) => frame.type === type && frame.id === id);
  /** the pane's queue as its page was last told it */
  const listed = () => (frames.filter((frame) => frame.type === "pending-messages").at(-1)?.["messages"] ?? []) as Row[];
  /** every send and drain under way has run, and so has what each started in turn */
  const settled = async () => {
    for (let turn = 0; turn < 20; turn++) {
      for (let before: unknown; before !== tail;) { before = tail; await tail.catch(() => {}); }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  /** `done` came true, by the real clock: the queue's own wait for omp is no part of the lane */
  const eventually = async (what: string, done: () => boolean) => {
    for (const deadline = performance.now() + 4_000; !done();) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}; calls ${JSON.stringify(calls)}`);
      await Bun.sleep(1);
    }
    await settled();
  };
  /** a pane event at rest: the queue is drained */
  const rest = async () => { delivery.pending.status("p", "idle"); delivery.drainPending("p"); await settled(); };
  /** `queued`: run once the message is queued, before the pane comes to rest */
  const first = async (queued?: () => void): Promise<Row> => {
    const message = await delivery.queueFirstMessage("p", "first words", "omp", owner.data.connectionId, OMP);
    queued?.();
    await rest();
    return message as unknown as Row;
  };
  const ways = {
    /** a queue request that finds the pane at rest is typed at once */
    "a queue request typed at once": async (): Promise<Frame | undefined> => {
      await delivery.pendingFrames.submit(owner as never, { type: "submit", id: 1, pane_id: "p", text: "first words", payload: "unused", delivery: "queue" } as never);
      await settled();
      return result("submit-result", 1);
    },
    /** a message kept for the user, then sent with its Send now */
    "Send now of a held message": async (): Promise<Frame | undefined> => {
      await delivery.pendingFrames.submit(owner as never, { type: "submit", id: 1, pane_id: "p", text: "first words", payload: "unused", delivery: "hold" } as never);
      const held = result("submit-result", 1) as unknown as { pending: { id: string } };
      await delivery.pendingFrames["pending-action"](owner as never, { type: "pending-action", id: 2, pane_id: "p", pending_id: held.pending.id, action: "steer" } as never);
      await settled();
      return result("pending-result", 2);
    },
    /** a new pane's first message, which the queue sends by itself once the pane is at rest: `until` says when it is through */
    "a new pane's first message": async (until: () => boolean = () => calls.includes("Enter"), queued?: () => void): Promise<Frame | undefined> => {
      await first(queued);
      await eventually("the first message's send", until);
      return undefined;
    },
  };
  const typed = () => calls.filter((call) => call !== "look");
  /** the pane ended, as the status hub tells the queue (status.ts paneGone) */
  const paneEnds = () => { delivery.holdPendingPane("p", GONE); delivery.pending.forget("p"); };
  return { calls, typed, looks: () => looks, asked: () => asked, pane, facts, hooks, ways, first, listed, rest, settled, eventually, serialize, delivery, owner, result, paneEnds, clients, herdrNow,
    report: () => { pane["agent_session"] = SESSION; }, revoke: () => { allowed = false; }, advance: (ms: number) => { skew += ms; } };
}
type Way = "a queue request typed at once" | "Send now of a held message" | "a new pane's first message";
const WAYS: Way[] = ["a queue request typed at once", "Send now of a held message", "a new pane's first message"];
/** the sends a person makes: they wait for omp as part of the send, as the immediate send does */
const BY_HAND: Way[] = ["a queue request typed at once", "Send now of a held message"];

// omp draws its input box, and herdr shows it at rest, seconds before it takes an Enter: a message typed meanwhile stays
// in the box and never runs, while its row says sent. The immediate send waits for herdr's omp integration to report
// the session; so does every send the queue makes
it.each(WAYS)("types %s into an omp still starting only once its session is reported", async (way) => {
  const d = omp();
  d.hooks.look = (looks) => {
    if (looks !== 3) return;
    expect(d.typed(), "nothing is typed before omp takes an Enter").toEqual([]);
    d.report();
  };
  const answer = await d.ways[way]();
  expect(d.calls).toEqual(["look", "look", "look", PASTE, "Enter"]);
  if (answer) expect(answer).toMatchObject({ ok: true });
  expect(d.listed().filter((message) => message.state !== "sending")).toEqual([]);
});

it.each(WAYS)("types %s at once into an omp whose session is reported, with no look at its start", async (way) => {
  const d = omp({ reported: true });
  await d.ways[way]();
  expect(d.calls).toEqual([PASTE, "Enter"]);
});

it.each([
  ["that started half a minute ago: it takes input, reported or not", { startedAgo: 31_000 }],
  ["that loads no integration: nothing would report it", { argv: ["omp", "--no-extensions"] }],
] as const)("types a queued message at once into an omp %s", async (_case, setup) => {
  const d = omp(setup);
  await d.ways["a new pane's first message"]();
  expect(d.calls).toEqual([PASTE, "Enter"]);
});

it.each(WAYS)("types %s once the wait for an omp that never reports runs out, and says so in the server log", async (way) => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const d = omp();
  // half a minute after omp started, with no report
  d.hooks.look = (looks) => { if (looks === 3) d.advance(30_001); };
  await d.ways[way]();
  expect(d.calls).toEqual(["look", "look", "look", PASTE, "Enter"]);
  expect(warn.mock.calls.flat().join(" ")).toContain("reported no session");
});

it.each(BY_HAND)("types nothing of %s when the omp it waited for quits while it starts, and says the pane changed", async (way) => {
  const d = omp();
  // omp ended: herdr names no agent in the pane, and its shell is in front
  d.hooks.look = (looks) => { if (looks === 2) d.pane["agent"] = null; };
  expect(await d.ways[way]()).toMatchObject({ ok: false, code: "pending_target_changed" });
  expect(d.calls).toEqual(["look", "look"]);
  // the queue request was never accepted, so its text is still the composer's; the held message keeps its row
  if (way === "Send now of a held message") expect(d.listed().map((message) => [message.state, message.error?.code])).toEqual([["held", "pending_target_changed"]]);
});

it("holds a new pane's first message when the omp started for it quits while it starts, with that reason", async () => {
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 2) d.pane["agent"] = null; };
  await d.ways["a new pane's first message"](() => d.listed()[0]?.state === "held");
  expect(d.typed()).toEqual([]);
  expect(d.listed().map((message) => [message.state, message.error?.code])).toEqual([["held", "first_message_launch_ended"]]);
});

it.each(BY_HAND.flatMap((way) => [[way, "its device may no longer type"], [way, "its page no longer has the pane ready"]] as const))(
  "stops waiting to type %s once %s, and types nothing", async (way, loss) => {
    const d = omp();
    d.hooks.look = (looks) => {
      if (looks !== 2) return;
      if (loss === "its device may no longer type") d.revoke(); else d.facts.ready = false;
    };
    expect(await d.ways[way]()).toMatchObject({ ok: false });
    // no third look: the wait ended with the sender's leave to type, not with omp's report or its half minute
    expect(d.calls).toEqual(["look", "look"]);
  });

it("leaves a new pane's first message queued for its page when that page may no longer type by omp's report", async () => {
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 2) d.revoke(); else if (looks === 3) d.report(); };
  await d.ways["a new pane's first message"](() => d.looks() >= 3);
  expect(d.calls).toEqual(["look", "look", "look"]);
  expect(d.listed().map((message) => message.state)).toEqual(["queued"]);
});

it("types nothing of a message a person sends that waited for a starting omp past its deadline, counted from when it was asked for", async () => {
  // the deadline passes during the wait
  const during = omp();
  during.hooks.look = (looks) => { if (looks === 2) during.advance(45_001); };
  expect(await during.ways["a queue request typed at once"]()).toMatchObject({ ok: false, code: "submit_timeout" });
  expect(during.calls).toEqual(["look", "look"]);
  mock.restore();
  // and one that had passed before the wait began (the request waited its turn behind other input): not one look
  const before = omp();
  before.hooks.read = (reads) => { if (reads === 2) before.advance(45_001); };
  expect(await before.ways["a queue request typed at once"]()).toMatchObject({ ok: false, code: "submit_timeout" });
  expect(before.calls).toEqual([]);
});

it("queues a queue request whose omp is at work by its report, and types it at that turn's end", async () => {
  const d = omp();
  // the pane was at rest when the request came; omp reports, already at work (it was started with a prompt of its own)
  d.hooks.look = (looks) => { if (looks === 2) { d.report(); d.pane["agent_status"] = "working"; } };
  expect(await d.ways["a queue request typed at once"]()).toMatchObject({ ok: true, pending: { state: "queued" } });
  expect(d.typed()).toEqual([]);
  d.pane["agent_status"] = "idle";
  await d.rest();
  expect(d.typed()).toEqual([PASTE, "Enter"]);
});

it("types a new pane's first message that waited for a starting omp only while the pane is still at rest", async () => {
  const d = omp();
  // omp reported, and by then it works on something else (a message typed in the terminal): the queue waits its turn
  d.hooks.look = (looks) => { if (looks === 2) { d.report(); d.pane["agent_status"] = "working"; } };
  await d.ways["a new pane's first message"](() => d.looks() >= 2);
  expect(d.typed()).toEqual([]);
  expect(d.listed().map((message) => message.state)).toEqual(["queued"]);
  // its turn ends: the message goes, with no further wait
  d.pane["agent_status"] = "idle";
  await d.rest();
  expect(d.calls).toEqual(["look", "look", PASTE, "Enter"]);
});

// what the queue sends by itself waits for omp with nothing claimed: the pane and the message are as free as before it
it("lets what is typed into the pane through while its first message waits for omp, ahead of that message", async () => {
  const d = omp();
  d.hooks.look = (looks) => {
    // terminal typing, a key from the key bar, a prompt's answer: each takes its turn in the pane's lane
    if (looks === 2) void d.serialize("p", () => { d.calls.push("typed in the terminal"); });
    if (looks === 5) d.report();
  };
  await d.ways["a new pane's first message"]();
  expect(d.typed()).toEqual(["typed in the terminal", PASTE, "Enter"]);
  // it went while the wait was still on, not once the message had gone
  expect(d.calls.indexOf("typed in the terminal")).toBeLessThan(d.calls.lastIndexOf("look"));
});

it("shows a new pane's first message as queued, not as being sent, while it waits for omp", async () => {
  const d = omp();
  let shown: string[] | undefined;
  d.hooks.look = (looks) => { if (looks === 2) shown = d.listed().map((message) => message.state); else if (looks === 3) d.report(); };
  await d.ways["a new pane's first message"]();
  expect(shown).toEqual(["queued"]);
});

it("takes a first message with its pane when the pane ends while the message waits for omp", async () => {
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 2) d.paneEnds(); };
  await d.first();
  await d.eventually("the pane's end", () => d.looks() >= 2);
  // nothing is left under the pane's id for the pane herdr gives it to next, and the wait is over
  expect([d.typed(), d.listed(), d.delivery.pending.holds("p")]).toEqual([[], [], false]);
  const looks = d.looks();
  await d.settled();
  expect(d.looks()).toBe(looks);
});

// a first message has no connection whose end would expire it: one on its way when its pane ends cannot go with the pane
// then, and went back to the queue under the dead pane's id, where the next pane herdr gives that id found it
it("takes a first message with its pane once its send has ended, when the pane ended while the queue was sending it", async () => {
  const d = omp({ reported: true });
  // the pane ends during the send's own reads of it
  d.hooks.read = (reads) => { if (reads === 1) d.paneEnds(); };
  await d.first();
  expect([d.typed(), d.listed(), d.delivery.pending.holds("p")]).toEqual([[], [], false]);
  // the id is free for a new pane's own first message
  expect((await d.delivery.queueFirstMessage("p", "another", "omp", d.owner.data.connectionId, OMP)).state).toBe("queued");
});

it("takes a first message with its pane once its Send now has ended, when the pane ended while that waited for omp", async () => {
  const d = omp();
  const message = await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  let ended = false;
  // the pane ends at the first look Send now's own wait takes
  d.hooks.look = () => { if (!ended && d.delivery.pending.get(FIRST_MESSAGE_OWNER, "p", message.id)?.inFlight) { ended = true; d.paneEnds(); } };
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 9, pane_id: "p", pending_id: message.id, action: "steer" } as never);
  await d.settled();
  expect(ended).toBe(true);
  expect(d.result("pending-result", 9)).toMatchObject({ ok: false });
  expect([d.typed(), d.listed(), d.delivery.pending.holds("p")]).toEqual([[], [], false]);
});

it.each(["steer", "discard"] as const)("lets Send now or Discard take a first message that waits for omp: %s", async (action) => {
  const d = omp();
  const message = await d.first();
  await d.eventually("the wait for omp", () => d.looks() >= 2);
  // from the look after the action's own, omp has reported
  d.hooks.look = () => { d.report(); };
  await d.delivery.pendingFrames["pending-action"](d.owner as never, { type: "pending-action", id: 9, pane_id: "p", pending_id: message.id, action } as never);
  await d.settled();
  expect(d.result("pending-result", 9)).toMatchObject({ ok: true });
  // sent once, by the hand that asked, or not at all; and the wait is over
  expect(d.typed()).toEqual(action === "steer" ? [PASTE, "Enter"] : []);
  const looks = d.looks();
  await d.settled();
  expect(d.looks()).toBe(looks);
});

it("leaves a pane's first message queued when only an earlier pane of that id ended", async () => {
  const d = omp({ reported: true });
  // herdr gave the id of a pane that ended to this one
  d.paneEnds();
  d.advance(5);
  // its page loses the pane during the send: nothing is typed, and the message waits for the page, as before
  d.hooks.read = (reads) => { if (reads === 1) d.facts.ready = false; };
  await d.first();
  expect([d.typed(), d.listed().map((message) => message.state), d.delivery.pending.holds("p")]).toEqual([[], ["queued"], true]);
});

it("goes on waiting for omp while herdr does not answer, and sends the first message at the report", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const d = omp();
  // herdr fails for a moment while the queue waits (a slow start under load is when its calls time out): the wait is
  // no send that could fail, and nothing else would drain the pane again once omp has reported
  d.hooks.look = (looks) => {
    d.herdrNow.silent = looks === 2 || looks === 3;
    if (d.herdrNow.silent) throw new herdr.HerdrError("herdr_unavailable", "herdr did not answer");
    if (looks === 5) d.report();
  };
  await d.ways["a new pane's first message"]();
  expect([d.looks(), d.typed()]).toEqual([5, [PASTE, "Enter"]]);
  expect(warn.mock.calls).toEqual([]);
});

it("ends the queue's wait for omp when the pane is gone", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const d = omp();
  d.hooks.look = (looks) => { if (looks === 2) d.herdrNow.paneGone = true; };
  await d.first();
  await d.eventually("the look that finds no pane", () => d.looks() >= 2);
  const looks = d.looks();
  await d.settled();
  expect([d.looks(), d.typed()]).toEqual([looks, []]);
  expect(warn.mock.calls.flat().join(" ")).toContain("pane_not_found");
});

it("never holds the pane's lane for a send of the queue's own: one that finds omp starting after all goes back to the queue", async () => {
  const d = omp();
  d.hooks.look = (looks) => {
    if (looks === 2) void d.serialize("p", () => { d.calls.push("typed in the terminal"); });
    if (looks === 5) d.report();
  };
  let missed = 0;
  await d.ways["a new pane's first message"](undefined, () => {
    // herdr does not answer the queue's look at omp's start (the fifth read of the pane's processes its drain makes,
    // after the four that bind the message to what was launched), so the send is taken up as for an omp that takes input
    const from = d.asked();
    d.hooks.processes = (asked) => asked === from + 5 && ++missed > 0;
  });
  expect(missed).toBe(1);
  // the send found omp starting and gave the message back: what was typed in the terminal went ahead of it
  expect(d.typed()).toEqual(["typed in the terminal", PASTE, "Enter"]);
  expect(d.calls.indexOf("typed in the terminal")).toBeLessThan(d.calls.lastIndexOf("look"));
});

it("keeps a connection's own message for it when its pane ends while the queue is sending it", async () => {
  const d = omp({ reported: true });
  // a message queued behind a turn, sent by the queue at the turn's end
  d.pane["agent_status"] = "working";
  expect(await d.ways["a queue request typed at once"]()).toMatchObject({ ok: true, pending: { state: "queued" } });
  d.hooks.read = () => { d.paneEnds(); d.hooks.read = undefined; };
  d.pane["agent_status"] = "idle";
  await d.rest();
  // held for its owner with its reason, not removed: only a first message has no connection to end with
  expect([d.typed(), d.listed().map((message) => message.state), d.delivery.pending.holds("p")]).toEqual([[], ["held"], true]);
});

it("types a queue request at once into an omp that is at work by the send's own read, when nothing was waited for: as before", async () => {
  const d = omp({ reported: true });
  // at rest when the request came, at work a moment later: only a wait for omp makes the send look again
  d.hooks.read = (reads) => { if (reads === 2) d.pane["agent_status"] = "working"; };
  expect(await d.ways["a queue request typed at once"]()).toMatchObject({ ok: true, typed_now: true });
  expect(d.typed()).toEqual([PASTE, "Enter"]);
});

it("leaves nothing of a first message taken with its pane for the next pane of that id", async () => {
  const d = omp({ reported: true });
  d.hooks.read = (reads) => { if (reads === 1) d.paneEnds(); };
  await d.first();
  // a page that attaches the pane herdr gave the id to is told of no message of the old one's
  const told: Frame[] = [];
  const page = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (value: string) => { told.push(JSON.parse(value) as Frame); return 1; } };
  page.data.attached.set("p", { keepSize: false });
  d.clients.add(page);
  d.delivery.attached(page as never, "p");
  expect(told.filter((frame) => frame.type === "pending-messages" && ((frame["messages"] as unknown[]).length > 0 || frame["removed"] !== undefined))).toEqual([]);
});

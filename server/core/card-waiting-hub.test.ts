import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as prompt from "../prompt.ts";
import * as served from "../runtime/capabilities.ts";
import { HERDR, HERDR_CORE } from "../runtime/capabilities.ts";
import { handlers, hub, root } from "./status.fake.ts";
import type { CardRead } from "../card-waits.ts";
import { shouldNotifyStatus } from "../../shared/notify-policy.ts";
import type { AgentStatus } from "../../shared/protocol.ts";

const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
/** the server serves herdr-core (or herdr's TUI, `false`) */
const serving = (core: boolean) => { spies.push(spyOn(served, "capabilities").mockReturnValue(core ? HERDR_CORE : HERDR)); };
/** what the dialog readers find on the pane's screen from now on, and the panes read */
function screen(initial: CardRead) {
  const read: string[] = [];
  let shows: CardRead = initial;
  spies.push(spyOn(prompt, "waitingCard").mockImplementation(async (pane) => { read.push(pane.pane_id); return shows; }));
  return { read, show: (next: CardRead) => { shows = next; } };
}
const question = { kind: "question" as const, id: "q1" };
const pane = (agent: string | null, agent_status: string, extra: Record<string, unknown> = {}) => ({ pane_id: "t1", workspace_id: "w1", tab_id: "w1:t1", agent, agent_status, cwd: "/tmp", ...extra });
/** the waiting alerts web push would schedule: it takes a status equal to the last one as no change (push.ts onStatus) */
const waitingAlerts = (alerts: string[]) => alerts.filter((status, at) => status === "blocked" && alerts[at - 1] !== "blocked").length;
/** A hub that knows the pane as herdr and its agent's own reports tell it, its snapshot read once (what the card reads go over). */
async function started(shown: ReturnType<typeof pane>, reported: string | null = shown.agent_status, stateDir?: string) {
  const h = hub(undefined, undefined, undefined, undefined, stateDir);
  h.herdrSays(shown);
  handlers.onBaseline([shown]);
  if (reported !== null) handlers.onStatus("t1", reported as never, shown.agent);
  await h.snapshot();
  return h;
}
/**
 * What web push hears of the pane from now on, in order: each status (`alerts`) and each status it is told to take as the
 * last one heard (push.assume: `=` over what it heard, `?` only where it heard nothing). Returns the waiting alerts push
 * sends for it: a blocked that is news after the last status (shouldNotifyStatus), an assumed status alerting nothing.
 */
function pushHears(h: Awaited<ReturnType<typeof started>>): () => number {
  spies.push(spyOn(h.status.push, "assume").mockImplementation((_paneId: string, status: string, replace?: boolean) => { h.alerts.push(`${replace ? "=" : "?"}${status}`); }));
  return () => {
    let last: AgentStatus | undefined;
    let sent = 0;
    for (const told of h.alerts) {
      if (told.startsWith("=") || told.startsWith("?")) { if (told.startsWith("=") || last === undefined) last = told.slice(1) as AgentStatus; continue; }
      if (told === "blocked" && shouldNotifyStatus(last, "blocked")) sent++;
      last = told as AgentStatus;
    }
    return sent;
  };
}

describe("a herdr-core pane whose agent asks on screen what it did not report", () => {
  it("waits for its user while Codex keeps reporting working over its question, with one waiting alert", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    screen(question);
    await h.status.cardTick();
    expect(h.last().status).toBe("blocked");
    // the inbox's Needs you and the Agents list go by this status (src/lib/agentInbox.ts inboxStatus)
    expect((await h.snapshot()).panes[0]).toMatchObject({ agent_status: "blocked", agent_kind: "question" });
    handlers.onStatus("t1", "working", "codex");
    expect(h.last().status).toBe("blocked");
    expect(waitingAlerts(h.alerts)).toBe(1);
  });

  it("raises one waiting alert for the same card redrawn five times", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    screen(question);
    for (let redraw = 0; redraw < 6; redraw++) await h.status.cardTick();
    expect(waitingAlerts(h.alerts)).toBe(1);
  });

  it("works again at once when the card is answered, the agent's own status back and no alert after it", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const shown = screen(question);
    await h.status.cardTick();
    h.status.cards.answer("t1");
    shown.show(null);
    await h.status.cardTick();
    expect(h.last().status).toBe("working");
    expect(h.alerts.at(-1)).toBe("working");
    expect(waitingAlerts(h.alerts)).toBe(1);
    expect((await h.snapshot()).panes[0]).not.toHaveProperty("agent_kind");
  });

  it("waits at Claude Code's folder trust, where Claude reports nothing yet", async () => {
    serving(true);
    const h = await started(pane("claude", "unknown"), null);
    screen({ kind: null, id: "trust" });
    await h.status.cardTick();
    expect(h.last().status).toBe("blocked");
    expect((await h.snapshot()).panes[0]).toMatchObject({ agent_status: "blocked" });
  });

  it("shows nothing for a program that reports nothing and runs no agent", async () => {
    serving(true);
    const h = await started(pane(null, "unknown"), null);
    const shown = screen(question);
    await h.status.cardTick();
    expect(shown.read).toEqual([]);
    expect(h.last().status).toBeUndefined();
    expect((await h.snapshot()).panes[0]).toMatchObject({ agent_status: "unknown" });
    expect(h.alerts).toEqual([]);
  });

  it("changes nothing where the agent already reports blocked: its own kind and words stand, no second alert", async () => {
    serving(true);
    const h = await started(pane("claude", "blocked", { agent_kind: "permission", agent_message: "approve Write" }));
    const before = [...h.alerts];
    screen(question);
    await h.status.cardTick();
    expect(h.alerts).toEqual(before);
    expect((await h.snapshot()).panes[0]).toMatchObject({ agent_status: "blocked", agent_kind: "permission", agent_message: "approve Write" });
  });

  it("leaves classic herdr's statuses, rows and alerts exactly as they were", async () => {
    serving(false);
    const h = await started(pane("codex", "working"));
    const plain = JSON.stringify(await h.snapshot());
    const alerts = [...h.alerts];
    const shown = screen(question);
    await h.status.cardTick();
    expect(shown.read).toEqual([]);
    expect(JSON.stringify(await h.snapshot())).toBe(plain);
    expect(h.alerts).toEqual(alerts);
  });
});

describe("how often the cards are read", () => {
  it("reads a terminal no page in use shows on every third tick, and one a page in use shows on every tick", async () => {
    serving(true);
    const h = hub();
    const panes = [pane("codex", "working"), pane("codex", "working", { pane_id: "t2" })];
    h.herdrSays(...panes);
    handlers.onBaseline(panes);
    for (const shown of panes) handlers.onStatus(shown.pane_id, "working", "codex");
    await h.snapshot();
    const shown = screen(null);
    const readsIn = async (ticks: number) => {
      shown.read.splice(0);
      for (let tick = 0; tick < ticks; tick++) await h.tickCards();
      return { t1: shown.read.filter((id) => id === "t1").length, t2: shown.read.filter((id) => id === "t2").length };
    };
    // nobody watching
    expect(await readsIn(6)).toEqual({ t1: 2, t2: 2 });
    // a page shows t2 but is not in use (hidden, or out of focus)
    h.client.data.attached.set("t2", { keepSize: false });
    expect(await readsIn(6)).toEqual({ t1: 2, t2: 2 });
    // the page is in use: t2 is read on every tick, t1, which it does not show, still on every third
    h.present.add(h.client);
    expect(await readsIn(6)).toEqual({ t1: 2, t2: 6 });
  });

  it("skips the read of every terminal that falls due while the last one is still under way", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const read: string[] = [];
    const held = Promise.withResolvers<CardRead>();
    spies.push(spyOn(prompt, "waitingCard").mockImplementation(async (shown) => { read.push(shown.pane_id); return read.length === 1 ? held.promise : null; }));
    // the first read hangs across the next three ticks, the third of which is due a read of every terminal
    const first = h.tickCards();
    for (let tick = 0; tick < 3; tick++) void h.tickCards();
    held.resolve(null);
    await first;
    // the two ticks after it are not due: the turn that fell due meanwhile was taken by the read under way
    await h.tickCards();
    await h.tickCards();
    expect(read).toEqual(["t1"]);
    await h.tickCards();
    expect(read).toEqual(["t1", "t1"]);
  });
});

describe("what ends a card's wait, and what it leaves", () => {
  it("ends the wait when the agent exits at its card: the shell pane is not waiting, and its exit is not made blocked", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    screen(question);
    await h.status.cardTick();
    expect(h.last().status).toBe("blocked");
    // Ctrl-C at Codex's question (or Claude's folder trust answered "No, exit"): the shell is back, no agent runs there
    h.herdrSays(pane(null, "unknown"));
    handlers.onStatus("t1", "unknown", null);
    expect(h.last().status).toBe("unknown");
    expect((await h.snapshot()).panes[0]).toMatchObject({ agent: null, agent_status: "unknown" });
    expect(h.status.cards.waiting("t1")).toBe(false);
  });

  it("ends the wait at the next read when the pane's agent is gone without a status of its own", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    screen(question);
    await h.status.cardTick();
    h.herdrSays(pane(null, "working"));
    await h.snapshot();
    // the agent is known from the snapshot alone: the next read finds none in front and ends the wait
    handlers.onStatus("t1", "working", null);
    await h.status.cardTick();
    expect(h.status.cards.waiting("t1")).toBe(false);
    expect((await h.snapshot()).panes[0]!.agent_status).not.toBe("blocked");
  });

  it("keeps the finish of a turn that ended while a card's wait was on (an agent other than Codex)", async () => {
    serving(true);
    // Hermes: no tracker of its own decides its turns, only what it reports
    const h = await started(pane("hermes", "working"));
    const shown = screen(question);
    await h.status.cardTick();
    expect(h.last().status).toBe("blocked");
    // the turn ends while the card is still drawn: still waiting, and the finish is kept for after
    handlers.onStatus("t1", "idle", "hermes");
    expect(h.last().status).toBe("blocked");
    h.status.cards.answer("t1");
    shown.show(null);
    await h.status.cardTick();
    expect(h.last().status).toBe("done");
    expect(h.alerts.at(-1)).toBe("done");
  });

  it("falls back to the newest report, never to an older snapshot's status", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const shown = screen(question);
    await h.status.cardTick();
    // the agent reports idle; herdr's last snapshot still says working
    handlers.onStatus("t1", "idle", "codex");
    h.status.cards.answer("t1");
    shown.show(null);
    await h.status.cardTick();
    expect(h.last().status).not.toBe("working");
    expect(h.last().status).not.toBe("blocked");
  });
});

describe("a card's alert across a restart of the server, and its first sighting", () => {
  it("tells web push the agent's own status before the card's wait, so a wait first heard as blocked still alerts", async () => {
    serving(true);
    // push heard nothing of the pane before: Claude at its folder trust reports nothing
    const h = await started(pane("claude", "unknown"), null);
    const assumed: [string, string, boolean | undefined][] = [];
    spies.push(spyOn(h.status.push, "assume").mockImplementation((paneId: string, status: string, replace?: boolean) => { assumed.push([paneId, status, replace]); }));
    screen({ kind: null, id: "trust" });
    await h.status.cardTick();
    expect(assumed).toEqual([["t1", "unknown", false]]);
    expect(h.alerts.at(-1)).toBe("blocked");
  });

  it("tells web push the same card found again after a restart as the wait it already had", async () => {
    serving(true);
    const stateDir = join(root, "card-restart");
    mkdirSync(stateDir, { recursive: true });
    const before = await started(pane("codex", "working"), "working", stateDir);
    screen(question);
    await before.status.cardTick();
    expect(before.status.cards.waiting("t1")).toBe(true);
    for (const spy of spies.splice(0)) spy.mockRestore();
    serving(true);
    // the server starts again on the same state folder; the agent still reports working and still shows its card
    const after = await started(pane("codex", "working"), "working", stateDir);
    const assumed: [string, string, boolean | undefined][] = [];
    spies.push(spyOn(after.status.push, "assume").mockImplementation((paneId: string, status: string, replace?: boolean) => { assumed.push([paneId, status, replace]); }));
    screen(question);
    await after.status.cardTick();
    expect(assumed).toEqual([["t1", "blocked", true]]);
    expect(after.last().status).toBe("blocked");
  });

  it("reads a pane whose first status event named no agent, once the snapshot names one", async () => {
    serving(true);
    // the shell's status event came before Claude was in front; Claude then reports nothing
    const h = await started(pane("claude", "unknown"), null);
    handlers.onStatus("t1", "unknown", null);
    await h.snapshot();
    const shown = screen({ kind: null, id: "trust" });
    await h.status.cardTick();
    expect(shown.read).toEqual(["t1"]);
    expect(h.last().status).toBe("blocked");
  });

  it("reads the agent the snapshot names when the status event newer than it named none", async () => {
    serving(true);
    // the shell, before Claude started
    const h = await started(pane(null, "unknown"), null);
    h.herdrSays(pane("claude", "unknown"));
    // a snapshot read begins and will name Claude; the shell's status event, newer than that read, names no agent
    const open = await h.heldSnapshot();
    handlers.onStatus("t1", "unknown", null);
    await open();
    const shown = screen({ kind: null, id: "trust" });
    await h.status.cardTick();
    expect(shown.read).toEqual(["t1"]);
    expect(h.last().status).toBe("blocked");
  });

  it("reads the agent the newest status event names before any snapshot names it", async () => {
    serving(true);
    const h = await started(pane(null, "unknown"), null);
    handlers.onStatus("t1", "working", "codex");
    const shown = screen(question);
    await h.status.cardTick();
    expect(shown.read).toEqual(["t1"]);
  });

  it("reads an agent that works or has reported nothing, never one at rest", async () => {
    serving(true);
    const h = await started(pane("codex", "idle"));
    const shown = screen(question);
    await h.status.cardTick();
    expect(shown.read).toEqual([]);
    handlers.onStatus("t1", "working", "codex");
    await h.status.cardTick();
    expect(shown.read).toEqual(["t1"]);
  });
});

describe("a card's wait across a restart of the core, and across an exit", () => {
  it("keeps the wait, with no second alert, through a restart of the core as the adapter tells it", async () => {
    serving(true);
    const h = await started(pane("codex", "working"));
    const sent = pushHears(h);
    screen(question);
    await h.status.cardTick();
    expect(sent()).toBe(1);
    // `hc server restart`: the stopping core no longer knows the process in front, which the adapter tells nobody
    // (server/herdr-core/adapter.ts `foreground`); the stream it closed is opened again, resynced from a snapshot that
    // names the same agent, and its reports go on naming it
    handlers.onResync([pane("codex", "working")] as never, new Set());
    handlers.onStatus("t1", "working", "codex");
    for (let tick = 0; tick < 3; tick++) await h.status.cardTick();
    expect(h.status.cards.waiting("t1")).toBe(true);
    expect(h.last().status).toBe("blocked");
    expect(sent()).toBe(1);
  });

  /** `answered`: through its card; `left`: the card stays drawn on the screen after it */
  const exits: { exit: string; agent: string; card: CardRead; reported: string | null; answered: boolean; left: boolean }[] = [
    { exit: "Ctrl-C at Codex's question", agent: "codex", card: question, reported: "working", answered: false, left: false },
    { exit: "Claude's folder trust answered \"No, exit\"", agent: "claude", card: { kind: null, id: "trust" }, reported: null, answered: true, left: false },
    { exit: "Codex killed with its card left whole on screen", agent: "codex", card: question, reported: "working", answered: false, left: true },
  ];
  it.each(exits)("still ends the wait for good when the agent exits at its card: $exit", async ({ agent, card, reported, answered, left }) => {
    serving(true);
    const h = await started(pane(agent, reported ?? "unknown"), reported);
    const sent = pushHears(h);
    const shown = screen(card);
    await h.status.cardTick();
    expect(sent()).toBe(1);
    if (answered) h.status.cards.answer("t1");
    if (!left) shown.show(null);
    const reads = shown.read.length;
    // the shell is back: its event names no agent, and the core's next snapshot names none either
    h.herdrSays(pane(null, "unknown"));
    handlers.onStatus("t1", "unknown", null);
    await h.snapshot();
    for (let tick = 0; tick < 3; tick++) await h.status.cardTick();
    expect(shown.read.length).toBe(reads);
    expect(h.status.cards.waiting("t1")).toBe(false);
    expect(h.last().status).not.toBe("blocked");
    expect((await h.snapshot()).panes[0]!.agent_status).not.toBe("blocked");
    expect(sent()).toBe(1);
  });

  it.each(exits)("alerts again for the same card asked anew once the agent exits at it and is started again: $exit", async ({ agent, card, reported, answered, left }) => {
    serving(true);
    const h = await started(pane(agent, reported ?? "unknown"), reported);
    const sent = pushHears(h);
    const shown = screen(card);
    await h.status.cardTick();
    if (answered) h.status.cards.answer("t1");
    if (!left) shown.show(null);
    h.herdrSays(pane(null, "unknown"));
    handlers.onStatus("t1", "unknown", null);
    await h.snapshot();
    for (let tick = 0; tick < 3; tick++) await h.status.cardTick();
    expect(sent()).toBe(1);
    // the same agent started again in that terminal shows the same card: a new asking
    h.herdrSays(pane(agent, reported ?? "unknown"));
    handlers.onStatus("t1", (reported ?? "unknown") as never, agent);
    await h.snapshot();
    shown.show(card);
    await h.status.cardTick();
    expect(h.last().status).toBe("blocked");
    expect(sent()).toBe(2);
  });
});

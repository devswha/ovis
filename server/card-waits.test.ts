import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CardWaits, type CardRead } from "./card-waits.ts";
import { codexQueuedPrompt } from "./codex-queue.ts";
import { finishPrompt, publicPrompt } from "./dialogs/shared.ts";
import { parseInteractivePrompt, waitingKindOf } from "./prompt.ts";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

// screens drawn by the real programs on a herdr-core test core (todo 67): Claude Code 2.1.321, Codex 0.167.0
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "herdr-core-cards", name), "utf8");

const pane = (agent: string | null, agent_status: HerdrPane["agent_status"] = "working", extra: Partial<HerdrPane> = {}) =>
  ({ pane_id: "t1", workspace_id: "w1", tab_id: "w1:t1", agent, agent_status, ...extra }) as HerdrPane;

/** CardWaits over reads the test hands out one at a time, and every change it told. */
function waits(reads: CardRead[], kept: Record<string, string> = {}) {
  const told: [string, boolean][] = [];
  const resumed: boolean[] = [];
  const read: string[] = [];
  const saved: Record<string, string>[] = [];
  const cards = new CardWaits(async (seen) => { read.push(seen.pane_id); return reads.shift(); }, (paneId, waiting, again) => { told.push([paneId, waiting]); if (waiting) resumed.push(again); },
    { load: () => kept, save: (cards) => saved.push(cards) });
  return { cards, told, read, resumed, saved };
}
/** every pane with an agent is read */
const all = () => true;
const card = (kind: "permission" | "question" | null, id = "c1") => ({ kind, id });

describe("which cards are an agent waiting for its user", () => {
  it("reads Claude Code's folder trust as waiting, with no kind of its own", () => {
    const card = parseInteractivePrompt("claude", fixture("claude-folder-trust-2.1.321.txt"));
    expect(card).toMatchObject({ kind: "menu", title: "Accessing workspace" });
    expect(waitingKindOf(card!)).toBeNull();
  });

  it("reads Codex's collapsed question as waiting on a question", () => {
    const card = codexQueuedPrompt(fixture("codex-question-queued-0.167.0.txt"), [{ key: "k1", title: "Which color?", options: ["red", "blue"] }]);
    expect(card).toMatchObject({ kind: "question", question: "Which color?", queued: "collapsed" });
    expect(waitingKindOf(card!)).toBe("question");
  });

  it("reads Codex's update menu at its start as waiting, with no kind of its own", () => {
    const card = parseInteractivePrompt("codex", fixture("codex-update-menu-0.167.0.txt"));
    expect(card).toMatchObject({ kind: "menu", title: "Codex" });
    expect(waitingKindOf(card!)).toBeNull();
  });

  it("does not read a picker the user opened, nor a fallback card, as waiting", () => {
    const picker = publicPrompt(finishPrompt("codex", { kind: "menu", title: "Select Model and Effort", question: "Pick a model", body: null, options: [{ label: "a", description: null }, { label: "b", description: null }], multi_select: false, custom_option_index: null },
      { responder: "codex-model", menuLabels: ["a", "b"], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null }));
    expect(waitingKindOf(picker)).toBeUndefined();
    const fallback = publicPrompt(finishPrompt("amp", { kind: "menu", title: "", question: "Continue?", body: null, options: [{ label: "Yes", description: null }, { label: "No", description: null }], multi_select: false, custom_option_index: null },
      { responder: "fallback-menu", menuLabels: ["Yes", "No"], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null }));
    expect(waitingKindOf(fallback)).toBeUndefined();
  });
});

describe("a wait on a card", () => {
  it("begins once, and the same card redrawn five times is the same wait", async () => {
    const { cards, told } = waits([card("question"), card("question"), card("question"), card("question"), card("question"), card("question")]);
    for (let read = 0; read < 6; read++) await cards.tick([pane("codex")], all);
    expect(told).toEqual([["t1", true]]);
    expect(cards.kindOf("t1")).toBe("question");
  });

  it("survives one read caught mid-repaint and ends at the second read without a card", async () => {
    const { cards, told } = waits([card("permission"), null, card("permission"), null, null]);
    for (let read = 0; read < 3; read++) await cards.tick([pane("claude")], all);
    expect(told).toEqual([["t1", true]]);
    await cards.tick([pane("claude")], all);
    expect(cards.waiting("t1")).toBe(true);
    await cards.tick([pane("claude")], all);
    expect(told).toEqual([["t1", true], ["t1", false]]);
  });

  it("ends at the first read without a card after an answer from a card", async () => {
    const { cards, told } = waits([card("question"), card("question"), null]);
    await cards.tick([pane("codex")], all);
    cards.answer("t1");
    // the answered card can still be drawn for a moment
    await cards.tick([pane("codex")], all);
    expect(cards.waiting("t1")).toBe(true);
    await cards.tick([pane("codex")], all);
    expect(told).toEqual([["t1", true], ["t1", false]]);
  });

  it("keeps a wait through reads that say nothing, and ends it after ten in a row rather than stay stuck", async () => {
    const { cards, told } = waits([card("question"), ...Array<CardRead>(9).fill(undefined), card("question"), ...Array<CardRead>(10).fill(undefined)]);
    for (let read = 0; read < 11; read++) await cards.tick([pane("codex")], all);
    expect(told).toEqual([["t1", true]]);
    for (let read = 0; read < 10; read++) await cards.tick([pane("codex")], all);
    expect(told).toEqual([["t1", true], ["t1", false]]);
  });

  it("never reads a terminal no agent runs in, nor one another tracker tells", async () => {
    const { cards, told, read } = waits([card("question"), card("question")]);
    await cards.tick([pane(null, "unknown")], all);
    await cards.tick([pane("omo")], all, () => true);
    expect(read).toEqual([]);
    expect(told).toEqual([]);
  });

  it("forgets a pane no longer listed, telling nobody", async () => {
    const { cards, told } = waits([card("question")]);
    await cards.tick([pane("codex")], all);
    await cards.tick([], all);
    expect(cards.waiting("t1")).toBe(false);
    expect(told).toEqual([["t1", true]]);
  });

  it("shows a waiting pane blocked with the card's kind, and leaves the agent's own blocked and its words alone", async () => {
    const { cards } = waits([card("question")]);
    await cards.tick([pane("codex")], all);
    expect(cards.status("t1", "working")).toBe("blocked");
    const snapshot = (panes: HerdrPane[]) => ({ panes, agents: panes.map(({ pane_id, agent, agent_status }) => ({ pane_id, agent, agent_status })) }) as unknown as SessionSnapshot;
    expect(cards.apply(snapshot([pane("codex", "working")])).panes[0]).toMatchObject({ agent_status: "blocked", agent_kind: "question" });
    expect(cards.apply(snapshot([pane("codex", "working")])).agents[0]).toMatchObject({ agent_status: "blocked" });
    const own = pane("codex", "blocked", { agent_kind: "permission", agent_message: "approve rm" });
    expect(cards.apply(snapshot([own])).panes[0]).toEqual(own);
  });

  it("ends a wait at once when the pane's agent is gone, without reading it", async () => {
    const { cards, told, read } = waits([card("question"), card("question")]);
    await cards.tick([pane("codex")], all);
    // Ctrl-C at its question, or its folder trust answered "No, exit": a shell is back, no agent runs there
    await cards.tick([pane(null, "unknown")], all);
    expect(told).toEqual([["t1", true], ["t1", false]]);
    expect(read).toEqual(["t1"]);
    expect(cards.status("t1", "unknown")).toBe("unknown");
  });

  it("reads only the panes the rule picks, and every pane that waits", async () => {
    const { cards, read } = waits([card("question"), null, null]);
    const atRest = (seen: HerdrPane) => seen.agent_status === "working" || seen.agent_status === "unknown";
    await cards.tick([pane("codex", "idle")], atRest);
    expect(read).toEqual([]);
    await cards.tick([pane("codex", "working")], atRest);
    // a pane that waits is read whatever its agent says now, so that its wait can end
    await cards.tick([pane("codex", "idle")], atRest);
    expect(read).toEqual(["t1", "t1"]);
  });
});

describe("a wait across a restart of the server", () => {
  it("keeps each wait's card, and drops it when the wait ends", async () => {
    const { cards, saved } = waits([card("question", "c7"), null, null]);
    await cards.tick([pane("codex")], all);
    expect(saved.at(-1)).toEqual({ t1: "c7" });
    await cards.tick([pane("codex")], all);
    await cards.tick([pane("codex")], all);
    expect(saved.at(-1)).toEqual({});
  });

  it("tells the same card found again after a restart as the wait it was, and another card as a new one", async () => {
    const same = waits([card("question", "c7")], { t1: "c7" });
    await same.cards.tick([pane("codex")], all);
    expect(same.resumed).toEqual([true]);
    const other = waits([card("question", "c8")], { t1: "c7" });
    await other.cards.tick([pane("codex")], all);
    expect(other.resumed).toEqual([false]);
  });

  it("forgets a remembered card whose pane is gone, or shows none", async () => {
    const gone = waits([], { t9: "c7" });
    await gone.cards.tick([pane("codex")], () => false);
    expect(gone.saved.at(-1)).toEqual({});
    const none = waits([null], { t1: "c7" });
    await none.cards.tick([pane("codex")], all);
    expect(none.saved.at(-1)).toEqual({});
  });
});

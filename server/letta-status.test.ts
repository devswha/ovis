import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { createLettaStatus, lettaPanes, lettaRefreshKey, lettaTitleStatus, lettaTurnAfter } from "./letta-status.ts";
import { noTurn } from "./omo-status.ts";

// One turn of letta-code 0.34.44's local backend (old-desktop, 2026-11-08): the prompt, a Bash call, its result, the answer
const turn = readFileSync(join(import.meta.dir, "fixtures", "letta", "messages-turn-0.34.44.jsonl"), "utf8").trim().split("\n");

const pane = (id: string, agent: string | null, status: HerdrPane["agent_status"]): HerdrPane => ({
  pane_id: id, workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/p", foreground_cwd: "/p", agent, agent_status: status,
} as HerdrPane);

describe("a Letta pane's status from its local messages", () => {
  it("works from the prompt through each tool call and its result, and rests on the answer", () => {
    const seen: (string | null)[] = [];
    let state = noTurn();
    for (const line of turn) { state = lettaTurnAfter(state, { text: line }); seen.push(state.status); }
    expect(seen).toEqual(["working", "working", "working", "idle"]);
    expect(state.at).toBe(Date.parse("2026-11-08T02:29:09.323Z"));
  });

  it("finds only Letta panes no report gives a status, with the messages file of the conversation it shows", async () => {
    const found = await lettaPanes([pane("t1", "letta", "unknown"), pane("t2", "letta", "working"), pane("t3", "claude", "unknown"), pane("t4", "letta", "unknown")], {
      resolve: async (target) => target.pane_id === "t1"
        ? { store: "/h/.letta/lc-local-backend", agent: "agent-local-a", conversation: "default", startedAt: 1000 }
        : null,
    });
    expect([...found]).toEqual([
      ["t1", { path: join("/h/.letta/lc-local-backend", "conversations", Buffer.from("default:agent-local-a").toString("base64url"), "messages.jsonl"), startedAt: 1000 }],
      // a pane whose conversation cannot be told keeps its status unknown
      ["t4", { path: null, startedAt: null }],
    ]);
  });

  it("takes Letta's own title where no report and no tracked messages file gave a status", () => {
    const titled = (id: string, status: HerdrPane["agent_status"], title: string, agent = "letta") => ({ ...pane(id, agent, status), terminal_title: title } as HerdrPane);
    const panes = [titled("t1", "unknown", "⠋ Tutor"), titled("t2", "unknown", "Tutor"), titled("t3", "unknown", "⠋ Tutor"), titled("t4", "blocked", "⠋ Tutor"), titled("t5", "unknown", "⠋ x", "claude")];
    const last = new Map<string, HerdrPane["agent_status"]>();
    // a first look at rest tells nobody; one at work does, so its end is a finish
    expect(lettaTitleStatus({ panes: panes }, (paneId) => paneId === "t3", last)).toEqual([{ paneId: "t1", status: "working" }]);
    expect(panes.map((p) => p.agent_status)).toEqual(["working", "idle", "unknown", "blocked", "unknown"]);
    // a turn ends in t1 and starts in t2: both are told, as a tracked pane's turns are
    const next = [titled("t1", "unknown", "Tutor"), titled("t2", "unknown", "⠙ Tutor")];
    expect(lettaTitleStatus({ panes: next }, () => false, last)).toEqual([{ paneId: "t1", status: "idle" }, { paneId: "t2", status: "working" }]);
    // a pane gone, or given a status by a report, is forgotten: its next title is a first look again
    expect(lettaTitleStatus({ panes: [titled("t2", "working", "Tutor")] }, () => false, last)).toEqual([]);
    expect([...last.keys()]).toEqual([]);
  });

  it("shows a tracked pane waiting on the user's approval as blocked, where its messages only show the pending call", () => {
    const titled = (id: string, status: HerdrPane["agent_status"], title: string) => ({ ...pane(id, "letta", status), terminal_title: title } as HerdrPane);
    const last = new Map<string, HerdrPane["agent_status"]>();
    expect(lettaTitleStatus({ panes: [titled("t1", "working", "⠋ Tutor")] }, () => true, last)).toEqual([]);
    const waiting = [titled("t1", "working", "[ ! ] Action Required | Tutor")];
    expect(lettaTitleStatus({ panes: waiting }, () => true, last)).toEqual([{ paneId: "t1", status: "blocked" }]);
    expect(waiting[0]!.agent_status).toBe("blocked");
    // approved: the call runs, and its file says working again
    expect(lettaTitleStatus({ panes: [titled("t1", "working", "⠙ Tutor")] }, () => true, last)).toEqual([{ paneId: "t1", status: "working" }]);
  });

  it("finds a pane again early when its title's name or its spinner changes, not on every spinner frame", () => {
    const titled = (title: string) => ({ ...pane("t1", "letta", "unknown"), terminal_title: title } as HerdrPane);
    expect(lettaRefreshKey(titled("⠋ Tutor"))).toBe(lettaRefreshKey(titled("⠙ Tutor")));
    expect(lettaRefreshKey(titled("⠋ Tutor"))).not.toBe(lettaRefreshKey(titled("Tutor")));
    expect(lettaRefreshKey(titled("Tutor"))).not.toBe(lettaRefreshKey(titled("Coder")));
    expect(lettaRefreshKey(titled("Tutor"))).not.toBe(lettaRefreshKey(titled("[ ! ] Action Required | Tutor")));
  });

  it("looks a pane up again within its refresh interval only when its refresh key changes", async () => {
    let lookups = 0;
    const tracker = createLettaStatus({ discover: async () => { lookups += 1; return new Map(); }, snapshot: async () => ({ panes: [] }) as never, onChange: () => {} });
    const titled = (title: string) => [{ ...pane("t1", "letta", "unknown"), terminal_title: title } as HerdrPane];
    await tracker.refresh(titled("Tutor"));
    await tracker.refresh(titled("Tutor"));
    expect(lookups).toBe(1);
    await tracker.refresh(titled("⠋ Tutor"));
    expect(lookups).toBe(2);
    tracker.stop();
  });

  it("goes on from the status a tracked messages file gave when the file stops speaking", () => {
    const titled = (id: string, status: HerdrPane["agent_status"], title: string) => ({ ...pane(id, "letta", status), terminal_title: title } as HerdrPane);
    const last = new Map<string, HerdrPane["agent_status"]>();
    // the file said working; then it is no longer tracked and the title rests: that is the turn's end
    expect(lettaTitleStatus({ panes: [titled("t1", "working", "⠋ Tutor")] }, () => true, last)).toEqual([]);
    expect(lettaTitleStatus({ panes: [titled("t1", "unknown", "Tutor")] }, () => false, last)).toEqual([{ paneId: "t1", status: "idle" }]);
  });

  it("keeps a cloud conversation, whose messages are on the server, without a file", async () => {
    const found = await lettaPanes([pane("t1", "letta", "unknown")], { resolve: async () => ({ store: "/s", agent: "agent-a", conversation: "conv-123", startedAt: 5 }) });
    expect(found.get("t1")).toEqual({ path: null, startedAt: 5 });
  });
});

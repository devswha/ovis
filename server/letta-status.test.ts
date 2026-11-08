import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { lettaPanes, lettaTitleStatus, lettaTurnAfter } from "./letta-status.ts";
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
    // the first look tells nobody
    expect(lettaTitleStatus(panes, (paneId) => paneId === "t3", last)).toEqual([]);
    expect(panes.map((p) => p.agent_status)).toEqual(["working", "idle", "unknown", "blocked", "unknown"]);
    // a turn ends in t1 and starts in t2: both are told, as a tracked pane's turns are
    const next = [titled("t1", "unknown", "Tutor"), titled("t2", "unknown", "⠙ Tutor")];
    expect(lettaTitleStatus(next, () => false, last)).toEqual([{ paneId: "t1", status: "idle" }, { paneId: "t2", status: "working" }]);
    // a pane gone, or given a status by a report, is forgotten: its next title is a first look again
    expect(lettaTitleStatus([titled("t2", "working", "Tutor")], () => false, last)).toEqual([]);
    expect([...last.keys()]).toEqual([]);
  });

  it("keeps a cloud conversation, whose messages are on the server, without a file", async () => {
    const found = await lettaPanes([pane("t1", "letta", "unknown")], { resolve: async () => ({ store: "/s", agent: "agent-a", conversation: "conv-123", startedAt: 5 }) });
    expect(found.get("t1")).toEqual({ path: null, startedAt: 5 });
  });
});

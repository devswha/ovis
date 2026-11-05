import { describe, expect, it } from "bun:test";

import type { Machine } from "../../shared/machines.ts";
import type { AgentInfo, AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { agentInbox, type AgentInboxSource } from "./agentInbox.ts";

const pane = (pane_id: string, status: AgentStatus, extra: Partial<HerdrPane> = {}): HerdrPane => ({
  pane_id,
  workspace_id: "w1",
  tab_id: "w1:t1",
  terminal_id: `term-${pane_id}`,
  focused: false,
  revision: 1,
  agent: "claude",
  agent_status: status,
  ...extra,
});

const agent = (row: HerdrPane, seq: number): AgentInfo => ({
  pane_id: row.pane_id,
  workspace_id: row.workspace_id,
  tab_id: row.tab_id,
  terminal_id: row.terminal_id,
  focused: false,
  revision: 1,
  agent: row.agent,
  agent_status: row.agent_status,
  state_change_seq: seq,
});

function snapshot(panes: HerdrPane[], seqs: Record<string, number>, agents = panes.filter((row) => row.agent).map((row) => agent(row, seqs[row.pane_id] ?? 0))): SessionSnapshot {
  return {
    protocol: 22,
    version: "0.9.5",
    layouts: [],
    panes,
    agents,
    workspaces: [{ workspace_id: "w1", label: "checkout", number: 1, focused: false, pane_count: panes.length, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1, focused: false, pane_count: panes.length, agent_status: "idle" }],
  };
}

const machine = (id: string, panes: HerdrPane[], seqs: Record<string, number>, state: Machine["state"] = "connected", agents?: AgentInfo[]): Machine => ({
  id,
  name: id.toUpperCase(),
  kind: id === "local" ? "local" : "ssh",
  enabled: true,
  state,
  error: null,
  snapshot: snapshot(panes, seqs, agents),
});

function source(machines: readonly Machine[]): AgentInboxSource {
  return {
    seqs: (machineId) => new Map((machines.find((item) => item.id === machineId)?.snapshot?.agents ?? []).map((row) => [row.pane_id, row.state_change_seq ?? 0])),
    status: (_machineId, row) => row.background_wait && row.agent_status !== "working" && row.agent_status !== "blocked" ? "waiting" : row.agent_status,
  };
}

describe("agentInbox", () => {
  it("aggregates blocked agent panes across connected PCs in PC and Activity order", () => {
    const machines = [
      machine("local", [pane("old", "blocked"), pane("running", "working"), pane("new", "blocked")], { old: 2, running: 8, new: 9 }),
      machine("remote", [pane("remote-question", "blocked")], { "remote-question": 50 }),
    ];

    expect(agentInbox(machines, source(machines)).items.map(({ machine, entry }) => `${machine.id}:${entry.pane.pane_id}`))
      .toEqual(["local:new", "local:old", "remote:remote-question"]);
  });

  it("uses authoritative blocked state, not background waiting, completion, or a blocked shell", () => {
    const shell = pane("shell", "blocked", { agent: null });
    const machines = [machine("local", [
      pane("question", "blocked", { agent_kind: "question" }),
      pane("background", "done", { background_wait: true }),
      pane("done", "done"),
      pane("idle", "idle"),
      shell,
    ], { question: 5, background: 4, done: 3, idle: 2, shell: 1 })];

    expect(agentInbox(machines, source(machines)).items.map(({ entry }) => entry.pane.pane_id)).toEqual(["question"]);
  });

  it("deduplicates repeated agent records and excludes cached offline PCs", () => {
    const livePane = pane("same", "blocked");
    const duplicate = agent(livePane, 4);
    const online = machine("local", [livePane], { same: 4 }, "connected", [duplicate, { ...duplicate, name: "duplicate" }]);
    const offline = machine("remote", [pane("away", "blocked")], { away: 8 }, "disconnected");
    const state = agentInbox([online, offline], source([online, offline]));

    expect(state.items.map(({ entry }) => entry.pane.pane_id)).toEqual(["same"]);
    expect(state.offline).toBe(1);
  });

  it("reports loading while the roster or a connected PC snapshot is pending", () => {
    const pending: Machine = { id: "local", name: "Host", kind: "local", enabled: true, state: "connected", error: null, snapshot: null };
    expect(agentInbox([], source([]), false)).toMatchObject({ loading: true, items: [] });
    expect(agentInbox([pending], source([pending]), true)).toMatchObject({ loading: true, items: [] });
  });
});

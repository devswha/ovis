import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { appendFileSync } from "node:fs";
import type { HerdrPane } from "../../shared/protocol.ts";
import * as conversation from "../conversation.ts";
import { MIN, ompSession, records as r } from "../omp-subagents.fixture.ts";
import { claude, handlers, hub, line } from "./status.fake.ts";

const TODO = 'Remaining items (2):\n  - Read [in_progress] (Build)\n  - Fix [pending] (Build)\nOverall: 0/2 done, 2 open.\nActive phase 1/1 "Build" (0/2).\n  Build:\n    - [ ] Read (in progress)\n    - [ ] Fix';

let lookup: Mock<typeof conversation.ompPaneSession> | undefined;
afterEach(() => {
  lookup?.mockRestore();
  lookup = undefined;
});

describe("an omp pane in the status hub", () => {
  it("shows the plan its transcript keeps and the subagents it has running, in its snapshot and as they change", async () => {
    const s = ompSession();
    const now = Date.now();
    appendFileSync(s.path, line({ type: "message", timestamp: new Date(now - MIN).toISOString(), message: { role: "toolResult", toolName: "todo", content: [{ type: "text", text: TODO }] } }));
    s.agent("Busy", now - 5 * MIN, [r.prompt(now - 5 * MIN), r.calls(now - 4 * MIN)]);
    s.agent("Done", now - 9 * MIN, [r.prompt(now - 9 * MIN), r.answered(now - 8 * MIN)]);
    const pane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent_status: "idle", agent: "omp", cwd: s.root, agent_session: { agent: "omp", source: "herdr:omp", kind: "path", value: s.path } };
    lookup = spyOn(conversation, "ompPaneSession").mockResolvedValue({ path: s.path, startedAt: null });
    const h = hub();
    h.herdrSays(pane);
    handlers.onBaseline([pane]);
    // the trackers look the pane's session up as the hub's snapshot reads ask them to; here they are asked and awaited
    await h.status.plans.refresh([pane as unknown as HerdrPane]);
    await h.status.ompAgents.refresh([pane as unknown as HerdrPane]);
    h.status.plans.poll();
    expect((await h.status.clientSnapshot()).panes[0]).toMatchObject({ agent: "omp", plan: { done: 0, total: 2, current: "Read" }, background_tasks: 1 });
    // a subagent starting is told at once, to the sidebar's count
    s.agent("Second", now - 2 * MIN, [r.prompt(now - 2 * MIN)]);
    h.status.ompAgents.poll();
    expect(h.last().tasks).toBe(2);
    expect((await h.status.clientSnapshot()).panes[0]?.background_tasks).toBe(2);
  });

  it("looks no omp session up for a pane that runs another agent, and counts none of its subagents", async () => {
    lookup = spyOn(conversation, "ompPaneSession").mockResolvedValue({ path: "/never.jsonl", startedAt: null });
    const h = hub();
    h.herdrSays(claude);
    handlers.onBaseline([claude]);
    await h.snapshot();
    await h.status.ompAgents.refresh([claude as unknown as HerdrPane]);
    await h.status.plans.refresh([claude as unknown as HerdrPane]);
    expect(lookup).not.toHaveBeenCalled();
    expect(h.status.ompAgents.countOf(claude.pane_id)).toBe(0);
    expect(h.status.ompAgents.sessionOf(claude.pane_id)).toBeNull();
  });
});

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane } from "../../shared/protocol.ts";
import { createPushService } from "../push.ts";
import { startFakePushService } from "../push.fake.ts";
import { FriendStore } from "./friends.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const pane = (id: string, workspace: string, parent?: string): HerdrPane => ({
  pane_id: id, workspace_id: workspace, parent_pane_id: parent, tab_id: "t1", terminal_id: id,
  agent: "pi", agent_status: "working", focused: false, revision: 0,
});

for (const managed of [false, true]) {
  test(`alerts use collector project metadata before any browser request, manager ${managed ? "stale" : "disabled"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-friends-"));
    dirs.push(dir);
    const store = new FriendStore(dir, () => 0);
    // The collector knows the new panes before the manager publishes its next roster.
    const stale = managed ? [{ id: "local", snapshot: { panes: [pane("p1", "old-workspace")] } }] : [];
    const fake = await startFakePushService();
    const push = createPushService({
      stateDir: dir, loopbackHttp: true, timing: { short: 0, long: 0, longTurn: 0 },
      friendOf: (machine, id, sources = stale) => store.friendOf(machine, id, sources),
    });
    try {
      push.subscribe(fake.subscription);
      const panes = [pane("p1", "project"), pane("p2", "project"), pane("helper", "elsewhere", "p1")];
      push.seed(panes);
      for (const current of panes) { await push.onStatus(current.pane_id, "blocked"); await push.settled(); }
      const friends = fake.received.map((message) => message.payload.friend);
      expect(friends).toHaveLength(3);
      expect(friends[0]).toBeDefined();
      expect(new Set(friends).size).toBe(1);
      const listed = store.see(panes.map((current) => `local:${current.pane_id}`), ["local"], [{ id: "local", snapshot: { panes } }]).friends;
      expect(friends).toEqual(Object.values(listed));
    } finally { fake.stop(); }
  });
}

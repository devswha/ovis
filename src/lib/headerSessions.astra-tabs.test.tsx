import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { nextWaitingTarget, useWaitingRosters } from "./headerSessions.ts";
import { setPcNewness } from "./relay/newPcHere.ts";

test("the unnamed next-waiting action does not target either session of a new PC", async () => {
  const panes = ["first", "second"].map((pane_id) => ({ pane_id, tab_id: "tab", workspace_id: "work", agent: "claude", agent_status: "blocked" }) as HerdrPane);
  const local: Machine = { id: "local", name: "Desk", kind: "local", enabled: true, state: "connected", error: null, snapshot: { panes } as SessionSnapshot };
  let target: ReturnType<typeof nextWaitingTarget> = null;
  function Probe() {
    const rosters = useWaitingRosters([local], local, (_machine, pane) => pane.agent_status);
    target = nextWaitingTarget(rosters, { machineId: "local", paneId: null });
    return null;
  }
  let tree: ReactTestRenderer | undefined;
  setPcNewness({ until: Date.now() + 3_600_000 });
  try {
    await act(async () => { tree = create(<Probe />); });
    expect(target).toBeNull();
  } finally {
    await act(async () => tree?.unmount());
    setPcNewness(null);
  }
});

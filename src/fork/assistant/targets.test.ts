import { describe, expect, it } from "bun:test";

import type { Machine } from "../../../shared/machines.ts";
import { assistantTargets } from "./targets.ts";

describe("side-button assistant targets", () => {
  it("includes a hidden Pi on another machine, without offering shells or other agents", () => {
    const machines = [{ id: "remote", name: "Home", snapshot: { panes: [
      { pane_id: "p1", agent: "pi", label: "general", ovis_hidden: true },
      { pane_id: "p2", agent: null },
      { pane_id: "p3", agent: "claude" },
    ] } }] as Machine[];
    expect(assistantTargets(machines)).toEqual([
      { machineId: "remote", paneId: "p1", label: "general", machineName: "Home" },
    ]);
  });
});

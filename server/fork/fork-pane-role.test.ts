import { expect, it } from "bun:test";
import type { HerdrPane } from "../../shared/protocol.ts";
import { buildSnapshot, type HcTerminal } from "../herdr-core/snapshot.ts";

it("projects only known hc role labels as optional pane metadata", () => {
  const roles = ["implement", "review", "explore", "unknown", "", undefined];
  const terminals: HcTerminal[] = roles.map((role, index) => ({
    address: `t${index}`, cols: 80, rows: 24, cwd: "/repo", state: "live",
    ...(role === undefined ? {} : { labels: { role } }),
  }));
  for (const layout of [null, { spaces: [{ id: "s", tabs: terminals.map((terminal) => ({ id: terminal.address, root: { type: "block", content: { terminal: terminal.address } } })) }] }]) {
    const panes = buildSnapshot(terminals, layout, "test").panes as HerdrPane[];
    expect(panes.map((pane) => Reflect.get(pane, "agent_role"))).toEqual(["implement", "review", "explore", undefined, undefined, undefined]);
    for (const pane of panes.slice(3)) expect(Object.hasOwn(pane, "agent_role")).toBe(false);
  }
});

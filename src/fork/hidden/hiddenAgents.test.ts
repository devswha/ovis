import { expect, it } from "bun:test";
import { HIDDEN_WORKSPACE_ID } from "../../../shared/fork/pane.ts";
import type { Machine } from "../../../shared/machines.ts";
import type { AgentStatus } from "../../../shared/protocol.ts";
import machinesFixture from "../../../site/demo/fixtures/machines.json";
import { inboxFiltered, inboxOrder } from "../../lib/agentInbox.ts";
import type { SidebarActivity } from "../../lib/sidebarActivity.tsx";
import { holdSelected, inboxMachines, shownMachines, useHiddenLens, useHiddenSelection } from "./hiddenAgents.ts";

const activity: SidebarActivity = { seqs: () => new Map(), status: (): AgentStatus => "blocked" };
const hide = (id: string): Machine[] => {
  const machines: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
  const snapshot = machines[0]!.snapshot!;
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === id);
  // as server/herdr-core/snapshot.ts places it: a workspace of its own, a tab each
  if (pane) {
    const tab_id = `${HIDDEN_WORKSPACE_ID}:${id}`;
    Object.assign(pane, { ovis_hidden: true, workspace_id: HIDDEN_WORKSPACE_ID, tab_id });
    snapshot.workspaces.push({ ...snapshot.workspaces[0]!, workspace_id: HIDDEN_WORKSPACE_ID, pane_count: 1, tab_count: 1 });
    snapshot.tabs.push({ ...snapshot.tabs[0]!, tab_id, workspace_id: HIDDEN_WORKSPACE_ID, pane_count: 1 });
  }
  return machines;
};
const ids = (machines: Machine[], filter: "all" | "blocked" | "hidden", pcs = machines): string[] => inboxFiltered(inboxOrder(inboxMachines(filter, pcs, machines), activity), filter, activity).map(({ entry }) => entry.pane.pane_id);

it("lists a hidden agent under the Hidden filter alone, and every other filter never", () => {
  const all = hide("w1E:p1");
  expect(ids(all, "hidden")).toEqual(["w1E:p1"]);
  for (const filter of ["all", "blocked"] as const) expect(ids(all, filter)).not.toContain("w1E:p1");
  expect(ids(all, "all").length).toBe(ids(hide("none"), "all").length - 1);
});

it("keeps the roster the app reads free of a hidden agent unless it is the one open", () => {
  const all = hide("w1E:p1");
  expect(shownMachines(all)[0]!.snapshot!.panes.map((pane) => pane.pane_id)).not.toContain("w1E:p1");
  expect(shownMachines(all, { machineId: all[0]!.id, paneId: "w1E:p1" })[0]!.snapshot!.panes.map((pane) => pane.pane_id)).toContain("w1E:p1");
  // the lists read that roster through `useListedMachines`, which shows the open one no more than any other
  const open = shownMachines(all, { machineId: all[0]!.id, paneId: "w1E:p1" });
  expect(shownMachines(open)[0]!.snapshot!.panes.map((pane) => pane.pane_id)).not.toContain("w1E:p1");
  const plain = hide("none");
  expect(shownMachines(plain)).toBe(plain);
});

it("admits a hidden agent to the roster the thread view reads once any selection picks it, and drops it when another is picked", async () => {
  const { createElement } = await import("react");
  const { act, create } = await import("react-test-renderer");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const all = hide("w1E:p1");
  let read: Machine[] = [];
  const Probe = () => { read = useHiddenLens(all); return null; };
  const panes = (): string[] => read[0]!.snapshot!.panes.map((pane) => pane.pane_id);
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(Probe)); });
  expect(panes()).not.toContain("w1E:p1");
  await act(async () => { holdSelected(all[0]!.id, "w1E:p1"); });
  expect(panes()).toContain("w1E:p1");
  await act(async () => { holdSelected(all[0]!.id, "w1E:p2"); });
  expect(panes()).not.toContain("w1E:p1");
  await act(async () => { renderer.unmount(); });
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

it("admits the hidden agent a fresh page starts on (a saved selection, a link, a notification) without any selecting", async () => {
  const { createElement } = await import("react");
  const { act, create } = await import("react-test-renderer");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const all = hide("w1E:p1");
  let read: Machine[] = [];
  const Probe = ({ pane }: { pane: string | null }) => { read = useHiddenLens(all); useHiddenSelection(all[0]!.id, pane); return null; };
  const panes = (): string[] => read[0]!.snapshot!.panes.map((pane) => pane.pane_id);
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(Probe, { pane: "w1E:p1" })); });
  expect(panes()).toContain("w1E:p1");
  await act(async () => { renderer.update(createElement(Probe, { pane: "w1E:p2" })); });
  expect(panes()).not.toContain("w1E:p1");
  await act(async () => { renderer.unmount(); });
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

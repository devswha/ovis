import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { HerdrPane, HerdrTab } from "../../../shared/protocol.ts";
import { ForkTabChips } from "./TabChips.tsx";

const tabs: HerdrTab[] = ["implement", "review", "explore"].map((role, index) => ({ tab_id: role, workspace_id: "w", label: `Job · ${role}`, number: index + 1, pane_count: 1, focused: false, agent_status: "working" }));
const panes: HerdrPane[] = tabs.map((tab) => ({ pane_id: `pane:${tab.tab_id}`, tab_id: tab.tab_id, workspace_id: "w", terminal_id: tab.tab_id, revision: 1, focused: false, agent_status: "working", agent_role: tab.tab_id as HerdrPane["agent_role"] }));
let renderer: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; });

it("uses role chips, not repeated friends, and opens the child's pane", async () => {
  let selected = "";
  await act(async () => { renderer = create(<ForkTabChips tabs={tabs} paneFor={(tab) => panes.find((pane) => pane.tab_id === tab.tab_id)} nameOf={(tab) => tab.label} selectedTab="review" onSelect={(id) => { selected = id; }} onMenu={() => {}} status={() => "working"} />); });
  const buttons = renderer!.root.findAllByType("button");
  expect(buttons.map((button) => button.props["aria-label"])).toEqual(tabs.map((tab) => tab.label));
  expect(buttons.map((button) => button.props.title)).toEqual(tabs.map((tab) => tab.label));
  expect(buttons.map((button) => button.props["aria-selected"])).toEqual([false, true, false]);
  expect(buttons[1]!.props.tabIndex).toBe(0);
  expect(renderer!.root.findAllByType("svg").map((svg) => svg.props.className)).toEqual(["lucide lucide-code-xml lucide-code-2", "lucide lucide-check", "lucide lucide-search"]);
  expect(renderer!.root.findAllByProps({ "data-status": "working" })).toHaveLength(3);
  expect(renderer!.root.findAllByType("img")).toHaveLength(0);
  await act(async () => buttons[0]!.props.onClick({ ctrlKey: false, currentTarget: { focus() {} } }));
  expect(selected).toBe("pane:implement");
});

it("keeps overflow chips reachable by the More menu's arrow keys", async () => {
  await act(async () => { renderer = create(<ForkTabChips tabs={[tabs[0]!]} paneFor={() => panes[0]} nameOf={(tab) => tab.label} selectedTab="implement" onSelect={() => {}} onMenu={() => {}} sheet popup="menu" status={() => null} />); });
  const chip = renderer!.root.findByType("button");
  expect(chip.props.role).toBe("menuitemcheckbox");
  expect(chip.props["aria-checked"]).toBe(true);
  expect(chip.props["aria-pressed"]).toBeUndefined();
});

it("offers sibling moves by keyboard without selecting the child", async () => {
  const actions: unknown[] = [];
  await act(async () => { renderer = create(<ForkTabChips tabs={tabs} paneFor={(tab) => panes.find((pane) => pane.tab_id === tab.tab_id)} nameOf={(tab) => tab.label} selectedTab="parent" onSelect={() => actions.push("select")} onMenu={() => {}} onMove={(id, direction) => actions.push([id, direction])} status={() => null} />); });
  const [first] = renderer!.root.findAllByType("button");
  const event = { key: "ArrowRight", altKey: true, shiftKey: true, repeat: false, preventDefault() {}, stopPropagation() {} };
  await act(async () => first!.props.onKeyDown(event));
  expect(actions).toEqual([["implement", 1]]);
});

it("keeps close, rename and a contextual menu on chips, also in a phone sheet", async () => {
  const actions: string[] = [];
  await act(async () => { renderer = create(<ForkTabChips tabs={[tabs[0]!]} paneFor={() => panes[0]} nameOf={(tab) => tab.label} selectedTab="implement" onSelect={() => actions.push("select")} onMenu={() => actions.push("menu")} onClose={() => actions.push("close")} onRename={() => actions.push("rename")} onDismiss={() => actions.push("dismiss")} sheet popup="dialog" status={() => null} />); });
  const chip = renderer!.root.findByType("button");
  expect(chip.props.className).toContain("row-sheet-aside");
  expect(chip.props["aria-pressed"]).toBe(true);
  expect(chip.props.role).toBeUndefined();
  const event = { key: "F2", repeat: false, preventDefault() {}, stopPropagation() {}, currentTarget: { focus() {}, closest() { return null; } } };
  await act(async () => { chip.props.onKeyDown(event); chip.props.onKeyDown({ ...event, key: "Delete" }); chip.props.onContextMenu(event); chip.props.onClick({ ...event, ctrlKey: false }); });
  expect(actions).toEqual(["rename", "close", "dismiss", "menu", "select", "dismiss"]);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../../shared/machines.ts";
import fixture from "../../../site/demo/fixtures/machines.json";
import { InboxList } from "../../components/InboxList.tsx";
import { SettingsProvider } from "../../lib/settings.ts";
import type { SidebarActivity } from "../../lib/sidebarActivity.tsx";
import { newQuestionReads } from "../../lib/useInboxQuestions.ts";
import { SummaryReads } from "../../lib/useInboxSummaries.ts";

const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const events = new EventTarget();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    body: { nodeType: 1, children: [] }, querySelector: () => null,
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: (key: string) => key === "ovis:settings" ? '{"agentFriends":true}' : null, setItem() {} },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    history: { state: null, pushState() {}, replaceState() {}, back() {} }, location: { href: "http://localhost/", search: "" },
  } });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

test.each([false, true])("a conductor arriving during keyboard focus cannot move rows or connect to an unrelated row (other first: %s)", async (otherFirst) => {
  const machines = structuredClone(fixture.machines) as Machine[];
  const machine = machines[0]!;
  const panes = machine.snapshot!.panes.slice(0, 3);
  const [helper, other, conductor] = panes;
  helper!.parent_pane_id = conductor!.pane_id;
  const initial = otherFirst ? [other!, helper!] : [helper!, other!];
  const roster = (withConductor: boolean): Machine[] => [{ ...machine, snapshot: { ...machine.snapshot!, panes: withConductor ? [...initial, conductor!] : initial } }];
  // Within a state the inbox sorts by activity, not snapshot pane order (workspace order wins ties).
  const activity: SidebarActivity = { seqs: () => new Map(initial.map((pane, index) => [pane.pane_id, index])), status: () => "working" };
  const questionReads = newQuestionReads(() => () => {});
  const summaryReads = new SummaryReads(() => new Promise(() => {}), () => () => {});
  const scroll = { current: 0 };
  const focus = { opening: 1, taken: { current: 1 } };
  const view = (withConductor: boolean) => <SettingsProvider><InboxList machines={roster(withConductor)} activity={activity}
    watching={false} wide filter="all" onFilter={() => {}} query="" onQuery={() => {}} scroll={scroll} focus={focus}
    onOpen={() => {}} onNew={() => {}} questionReads={questionReads} summaryReads={summaryReads} /></SettingsProvider>;
  await act(async () => { renderer = create(view(false)); });
  const root = renderer!.root;
  const order = () => root.findAll((node) => node.type === "li" && node.props["data-pane"]).map((node) => node.props["data-pane"]);
  const list = () => root.findByType("ul");
  expect(order()).toEqual(initial.map((pane) => pane.pane_id));
  await act(async () => { list().props.onFocus({ target: { matches: () => true } }); });
  await act(async () => { renderer!.update(view(true)); });
  expect(order()).toEqual([...initial, conductor!].map((pane) => pane.pane_id));
  expect(root.findAll((node) => node.type === "li" && String(node.props.className).includes("fork-inbox-helper"))).toHaveLength(0);
  await act(async () => { list().props.onBlur({ relatedTarget: null, currentTarget: {} }); });
  expect(order()).toEqual((otherFirst ? [other!, conductor!, helper!] : [conductor!, helper!, other!]).map((pane) => pane.pane_id));
  expect(root.findAll((node) => node.type === "li" && String(node.props.className).includes("fork-inbox-helper"))).toHaveLength(1);
});

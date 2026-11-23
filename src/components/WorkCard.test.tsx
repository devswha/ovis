import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer, type TestRendererOptions } from "react-test-renderer";

import * as sheetModule from "./BackgroundAgentDetail.tsx";
import { WorkCard } from "./WorkCard.tsx";
import type { PaneTasksRead, PlanRead } from "../lib/api.ts";
import * as machineContext from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { WORK_CARD_FOLD_KEY } from "../lib/workCard.ts";
import type { OmoTask, PlanStep, PlanSummary } from "../../shared/protocol.ts";

// the detail sheet draws into the document body through a portal, which the test renderer cannot
const realSheet = { ...sheetModule };
await mock.module("./BackgroundAgentDetail.tsx", () => ({
  BackgroundAgentDetail: ({ task, onClose }: { task: OmoTask; onClose: () => void }) => createElement("section", { "data-sheet": task.id }, createElement("button", { "data-close": "", onClick: onClose })),
}));
afterAll(() => { void mock.module("./BackgroundAgentDetail.tsx", () => realSheet); });

const SERVER = "2026-10-02T05:04:12.000Z";
const PLAN: PlanSummary = { done: 1, total: 3, current: "Wire the todo reader" };
const step = (id: string, status: PlanStep["status"], label: string): PlanStep => ({ id, label, active: null, status, blocked_by: [], owner: null, started_at: null, ended_at: null });
const STEPS = [step("a", "completed", "Read the session format"), step("b", "in_progress", "Wire the todo reader"), step("c", "pending", "Write the tests")];
const task = (id: string, over: Partial<OmoTask> = {}): OmoTask => ({ id, title: `agent ${id}`, category: null, model: null, status: "running", started_at: "2026-10-02T05:03:00.000Z", ended_at: null, turns: null, tool_calls: null, tokens: null, detail_kind: null, ...over });
const listed = (...tasks: OmoTask[]): PaneTasksRead => ({ tasks, runs: [], serverTime: SERVER, moreRunning: 0 });

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;
let stored: Map<string, string>;
let visibility: "visible" | "hidden";
let visibilityListeners: Set<() => void>;
let planRead: () => Promise<PlanRead>;
let tasksRead: () => Promise<PaneTasksRead>;
const fetchPanePlan = mock(async (_pane: string): Promise<PlanRead> => planRead());
const fetchPaneOmoActivity = mock(async (_pane: string): Promise<PaneTasksRead> => tasksRead());

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  stored = new Map([["ovis:work-card", "true"]]);
  visibility = "visible";
  visibilityListeners = new Set();
  planRead = async () => ({ steps: STEPS, serverTime: SERVER });
  tasksRead = async () => listed();
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: {
      ...listen,
      localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } },
      matchMedia: () => ({ ...listen, matches: false }),
    },
    document: {
      documentElement: { lang: "", dataset: {}, style },
      querySelector: () => null,
      get visibilityState() { return visibility; },
      addEventListener: (type: string, listener: () => void) => { if (type === "visibilitychange") visibilityListeners.add(listener); },
      removeEventListener: (type: string, listener: () => void) => { if (type === "visibilitychange") visibilityListeners.delete(listener); },
    },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  });
  fetchPanePlan.mockClear();
  fetchPaneOmoActivity.mockClear();
  // only the reads the card makes
  spyOn(machineContext, "useMachineApi").mockReturnValue({ fetchPanePlan, fetchPaneOmoActivity } as never);
  jest.useFakeTimers();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.useRealTimers();
  mock.restore();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const card = (props: { plan?: PlanSummary | null; count?: number } = {}): ReactElement =>
  createElement(SettingsProvider, { children: createElement(WorkCard, { paneId: "p1", plan: PLAN, count: 0, ...props }) });
const show = async (element = card(), options?: TestRendererOptions): Promise<void> => { await act(async () => { renderer = create(element, options); }); };
const update = async (element: ReactElement): Promise<void> => { await act(async () => { renderer!.update(element); }); };
const later = async (): Promise<void> => { await act(async () => { jest.runOnlyPendingTimers(); }); };
const hosts = (match: (node: ReactTestInstance) => boolean): ReactTestInstance[] => renderer!.root.findAll((node) => typeof node.type === "string" && match(node));
const classed = (type: string, name: string): ReactTestInstance[] => hosts((node) => node.type === type && String(node.props["className"] ?? "").split(" ").includes(name));
const header = (): ReactTestInstance => classed("button", "work-card-head")[0]!;
const body = (): ReactTestInstance => classed("div", "work-card-body")[0]!;
const rows = (): ReactTestInstance[] => hosts((node) => node.type === "li");
const sheets = (): ReactTestInstance[] => hosts((node) => node.type === "section" && node.props["data-sheet"] !== undefined);
const figures = (): string => classed("span", "work-card-figures")[0]!.children.join("");
const text = (): string => JSON.stringify(renderer?.toJSON());
const press = async (node: ReactTestInstance): Promise<void> => { await act(async () => { node.props["onClick"]({ currentTarget: { focus() {} } }); }); };
const visibilityIs = async (next: "visible" | "hidden"): Promise<void> => { visibility = next; await act(async () => { for (const listener of [...visibilityListeners]) listener(); }); };

describe("while Settings leaves the Plan card off", () => {
  it("draws nothing and asks for nothing, with a plan and tasks running", async () => {
    stored.delete("ovis:work-card");
    await show(card({ count: 2 }));
    expect(renderer?.toJSON()).toBeNull();
    expect(fetchPanePlan).not.toHaveBeenCalled();
    expect(fetchPaneOmoActivity).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("with Settings turning it on", () => {
  it("draws nothing for a pane with no plan and no running task", async () => {
    await show(card({ plan: null, count: 0 }));
    expect(renderer?.toJSON()).toBeNull();
    expect(fetchPanePlan).not.toHaveBeenCalled();
    expect(fetchPaneOmoActivity).not.toHaveBeenCalled();
  });

  it("draws the plan's head and steps open, the step in progress marked", async () => {
    await show();
    expect(header().props["aria-expanded"]).toBe(true);
    expect(header().props["aria-label"]).toBe("Plan: 1 of 3 done · Wire the todo reader");
    expect(figures()).toBe("1/3");
    expect(classed("span", "work-card-current")).toHaveLength(1);
    expect(rows().map((row) => row.props["aria-current"])).toEqual([undefined, "step", undefined]);
    expect(rows().map((row) => row.props["title"])).toEqual(["Read the session format", "Wire the todo reader", "Write the tests"]);
    expect(body().props["hidden"]).toBe(false);
    expect(fetchPanePlan).toHaveBeenCalledWith("p1");
    expect(fetchPaneOmoActivity).not.toHaveBeenCalled();
  });

  it("reads the steps again every few seconds while it is open", async () => {
    await show();
    expect(fetchPanePlan).toHaveBeenCalledTimes(1);
    await later();
    expect(fetchPanePlan).toHaveBeenCalledTimes(2);
    await later();
    expect(fetchPanePlan).toHaveBeenCalledTimes(3);
  });

  it("names the tasks alone when the pane keeps no plan, and asks about nothing else", async () => {
    tasksRead = async () => listed(task("a"), task("b"));
    await show(card({ plan: null, count: 2 }));
    expect(header().props["aria-label"]).toBe("2 background tasks");
    expect(text()).toContain("2 background tasks");
    expect(classed("span", "work-card-agents")).toHaveLength(0);
    expect(fetchPanePlan).not.toHaveBeenCalled();
    expect(fetchPaneOmoActivity).toHaveBeenCalledWith("p1");
  });

  it("says the plan and the tasks together in the head's name, the count after the step", async () => {
    tasksRead = async () => listed(task("a"), task("b"));
    await show(card({ count: 2 }));
    expect(header().props["aria-label"]).toBe("Plan: 1 of 3 done · Wire the todo reader · 2 background tasks");
    expect(classed("span", "work-card-agents")).toHaveLength(1);
  });

  it("lists the running tasks only, each with its time, under a heading", async () => {
    tasksRead = async () => listed(task("a"), task("b", { status: "completed", ended_at: "2026-10-02T05:03:30.000Z" }));
    await show(card({ plan: null, count: 1 }));
    expect(text()).toContain("Background tasks");
    expect(text()).toContain("agent a");
    expect(text()).not.toContain("agent b");
    expect(text()).toContain("1m 12s");
  });

  it("opens the detail of a task the PC can show, and leaves one it cannot a plain row", async () => {
    tasksRead = async () => listed(task("claude", { detail_kind: "claude-subagent" }), task("omp", { detail_kind: null }), task("older", { detail_kind: undefined }));
    await show(card({ plan: null, count: 3 }));
    const opens = classed("button", "bg-task-open");
    expect(opens).toHaveLength(1);
    expect(opens[0]!.props["aria-haspopup"]).toBe("dialog");
    expect(rows()).toHaveLength(3);
    expect(sheets()).toHaveLength(0);
    await press(opens[0]!);
    expect(sheets().map((sheet) => sheet.props["data-sheet"])).toEqual(["claude"]);
    expect(classed("button", "bg-task-open")[0]!.props["aria-expanded"]).toBe(true);
    await act(async () => { hosts((node) => node.type === "button" && node.props["data-close"] !== undefined)[0]!.props["onClick"](); });
    expect(sheets()).toHaveLength(0);
  });

  it("says what failed to be read, in the chip's words", async () => {
    planRead = async () => { throw new Error("offline"); };
    tasksRead = async () => { throw new Error("offline"); };
    await show(card({ count: 1 }));
    expect(text()).toContain("Couldn't read the plan. Trying again…");
    expect(text()).toContain("Couldn't load the background tasks");
    tasksRead = async () => listed(task("a"));
    planRead = async () => ({ steps: STEPS, serverTime: SERVER });
    await later();
    expect(text()).not.toContain("Couldn't");
    tasksRead = async () => { throw new Error("offline"); };
    await later();
    expect(text()).toContain("Couldn't refresh: this is the list as it last read");
    expect(text()).toContain("agent a");
  });

  it("shows the tasks' heading only for tasks it can list", async () => {
    tasksRead = async () => listed();
    await show(card({ count: 1 }));
    expect(text()).not.toContain("Background tasks");
    expect(rows()).toHaveLength(3);
  });

  it("says a plan not read yet, and a session that keeps none", async () => {
    const reply = Promise.withResolvers<PlanRead>();
    planRead = () => reply.promise;
    await show();
    expect(text()).toContain("Reading the plan…");
    await act(async () => { reply.resolve({ steps: null, serverTime: SERVER }); });
    expect(text()).toContain("This session keeps no plan right now");
  });

  it("does not show a plan that went away from memory when another comes", async () => {
    await show(card({ count: 1 }));
    expect(rows()).toHaveLength(3);
    await update(card({ plan: null, count: 1 }));
    expect(classed("ol", "bg-task-list")).toHaveLength(0);
    const reply = Promise.withResolvers<PlanRead>();
    planRead = () => reply.promise;
    await update(card({ plan: { done: 0, total: 1, current: null }, count: 1 }));
    expect(text()).toContain("Reading the plan…");
    expect(text()).not.toContain("Read the session format");
  });
});

describe("its fold", () => {
  it("folds to its head on a press, remembers it on this device, and asks for nothing while folded", async () => {
    await show();
    await press(header());
    expect(header().props["aria-expanded"]).toBe(false);
    expect(body().props["hidden"]).toBe(true);
    expect(rows()).toHaveLength(0);
    expect(stored.get(WORK_CARD_FOLD_KEY)).toBe("true");
    expect(jest.getTimerCount()).toBe(0);
    const reads = fetchPanePlan.mock.calls.length;
    await later();
    expect(fetchPanePlan).toHaveBeenCalledTimes(reads);
    await press(header());
    expect(header().props["aria-expanded"]).toBe(true);
    expect(stored.get(WORK_CARD_FOLD_KEY)).toBe("false");
    expect(rows()).toHaveLength(3);
    expect(fetchPanePlan).toHaveBeenCalledTimes(reads + 1);
  });

  it("starts folded where this device folded it, and has asked for nothing", async () => {
    stored.set(WORK_CARD_FOLD_KEY, "true");
    await show(card({ count: 1 }));
    expect(header().props["aria-expanded"]).toBe(false);
    expect(figures()).toBe("1/3");
    expect(rows()).toHaveLength(0);
    expect(fetchPanePlan).not.toHaveBeenCalled();
    expect(fetchPaneOmoActivity).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("keeps the focus where it was on a press, as the buttons beside the message box do", async () => {
    await show();
    let prevented = 0;
    header().props["onPointerDown"]({ preventDefault: () => { prevented += 1; } });
    expect(prevented).toBe(1);
  });
});

describe("a page nobody sees", () => {
  it("asks for nothing, keeps the rows it has, and reads again at once on return", async () => {
    await show();
    expect(rows()).toHaveLength(3);
    await visibilityIs("hidden");
    expect(jest.getTimerCount()).toBe(0);
    expect(rows()).toHaveLength(3);
    const reads = fetchPanePlan.mock.calls.length;
    await later();
    expect(fetchPanePlan).toHaveBeenCalledTimes(reads);
    await visibilityIs("visible");
    expect(fetchPanePlan).toHaveBeenCalledTimes(reads + 1);
    expect(rows()).toHaveLength(3);
  });
});

describe("the step in progress", () => {
  let rowTop = 300;
  const list = { scrollTop: 0, clientHeight: 100, querySelector: (selector: string) => selector === "[data-current]" ? { offsetTop: rowTop, offsetHeight: 20 } : null };
  const nodes: TestRendererOptions = { createNodeMock: ({ props }) => typeof props === "object" && props !== null && "className" in props && props.className === "work-card-body" ? list : null };

  beforeEach(() => { rowTop = 300; list.scrollTop = 0; });

  it("is brought into view when the card is drawn, once, and again when the plan moves on", async () => {
    await show(card(), nodes);
    expect(list.scrollTop).toBe(260);
    // a reader scrolled elsewhere: the next read of the same step leaves the list where it is
    list.scrollTop = 0;
    await later();
    expect(list.scrollTop).toBe(0);
    planRead = async () => ({ steps: [step("a", "completed", "Read the session format"), step("b", "completed", "Wire the todo reader"), step("c", "in_progress", "Write the tests")], serverTime: SERVER });
    rowTop = 500;
    await later();
    expect(list.scrollTop).toBe(460);
  });

  it("is brought into view again when the card is unfolded", async () => {
    await show(card(), nodes);
    await press(header());
    list.scrollTop = 0;
    await press(header());
    expect(list.scrollTop).toBe(260);
  });

  it("leaves a list alone while the step is in view", async () => {
    rowTop = 40;
    await show(card(), nodes);
    expect(list.scrollTop).toBe(0);
  });
});

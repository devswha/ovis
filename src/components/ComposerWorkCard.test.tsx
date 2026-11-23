import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { Composer, type ComposerProps } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import type { PaneTasksRead, PlanRead } from "../lib/api.ts";
import * as machineContext from "../lib/machineContext.tsx";
import { composerDrafts } from "../lib/composerDraft.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import { usageCounters } from "../lib/usageCounters.ts";
import type { PlanSummary } from "../../shared/protocol.ts";

const pane = "work-card-pane", draftKey = `ovis:composer-draft:${pane}`;
const globals = ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let extraSettings: Partial<settingsModule.Settings> = {};
const fetchPaneOmoActivity = mock(async (_pane: string): Promise<PaneTasksRead> => ({ tasks: [], runs: [], serverTime: null, moreRunning: 0 }));
const fetchPanePlan = mock(async (_pane: string): Promise<PlanRead> => ({ steps: null, serverTime: null }));

beforeEach(() => {
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const listen = { addEventListener() {}, removeEventListener() {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 0 },
    window: { ...listen, location: { href: "https://ovis.test/" }, matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout },
    document: { ...listen, querySelector: () => null },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const data = new Map<string, string>();
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => data.get(key) ?? null);
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  // only what the composer reads of each hook
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false, ...extraSettings }, resolvedLanguage: "en" }) as never);
  spyOn(commandsModule, "usePaneCommands").mockReturnValue([]);
  spyOn(usageModule, "useUsage").mockReturnValue({ report: null } as never);
  spyOn(facesModule, "useFacesArrived").mockReturnValue(0);
  spyOn(voiceModule, "useDictation").mockReturnValue({ shown: false, voice: { state: "idle" }, forget() {} } as never);
  spyOn(usageCounters, "paneUse").mockImplementation(() => {});
  // the reads the composer's chip and the Plan card make, and the file list it never asks for here
  spyOn(machineContext, "useMachineApi").mockReturnValue({ fetchPaneFiles: async () => [], fetchPaneOmoActivity, fetchPanePlan } as never);
  fetchPaneOmoActivity.mockClear();
  fetchPanePlan.mockClear();
  composerDrafts.set(draftKey, "");
  extraSettings = {};
  jest.useFakeTimers();
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = undefined;
  composerDrafts.set(draftKey, "");
  jest.useRealTimers();
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

const PLAN: PlanSummary = { done: 1, total: 2, current: "Wire the todo reader" };
const props = (over: Partial<ComposerProps> = {}): ComposerProps => ({ paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, onSend: () => true, onAbort() {}, onUploadImage: async () => "", ...over });
const hosts = (match: (node: ReactTestInstance) => boolean): ReactTestInstance[] => renderer!.root.findAll((node) => typeof node.type === "string" && match(node));
const classed = (type: string, name: string): ReactTestInstance[] => hosts((node) => node.type === type && String(node.props["className"] ?? "").split(" ").includes(name));

describe("the chip's subagents", () => {
  it.each([["omp", true], ["claude", true], ["opencode", true], ["codex", false], ["omo", false]] as const)("a %s pane's chip looks for its agents without being opened: %s", async (agent, looks) => {
    await act(async () => { renderer = create(<Composer {...props({ agent })} />); });
    expect(fetchPaneOmoActivity.mock.calls.map((call) => call[0])).toEqual(looks ? [pane] : []);
  });

  it("is shown for an omp pane once its subagents are listed", async () => {
    fetchPaneOmoActivity.mockImplementationOnce(async () => ({ tasks: [{ id: "t1", title: "Review the diff", category: "reviewer", model: null, status: "completed" as const, started_at: null, ended_at: null, turns: null, tool_calls: null, tokens: null, detail_kind: null }], runs: [], serverTime: null, moreRunning: 0 }));
    await act(async () => { renderer = create(<Composer {...props({ agent: "omp" })} />); });
    expect(classed("button", "bg-tasks-toggle")).toHaveLength(1);
  });
});

describe("the Plan card", () => {
  it("is not in the composer while Settings leaves it off, and nothing is read for it", async () => {
    await act(async () => { renderer = create(<Composer {...props({ plan: PLAN, backgroundTasks: 1 })} />); });
    expect(classed("section", "work-card")).toHaveLength(0);
    expect(fetchPanePlan).not.toHaveBeenCalled();
    expect(fetchPaneOmoActivity).not.toHaveBeenCalled();
  });

  it("is the first thing in the composer, over the input card, once Settings turns it on", async () => {
    extraSettings = { workCard: true };
    await act(async () => { renderer = create(<Composer {...props({ plan: PLAN })} />); });
    const composer = hosts((node) => node.type === "div" && node.props["role"] === "group" && node.props["aria-label"] === "Message composer")[0]!;
    const inside = composer.findAll((node) => typeof node.type === "string" && node.props["aria-label"] !== "Message composer");
    expect(inside[0]?.props["className"]).toBe("work-card");
    expect(classed("section", "work-card")).toHaveLength(1);
    expect(inside.findIndex((node) => node.props["className"] === "work-card")).toBeLessThan(inside.findIndex((node) => String(node.props["className"]).startsWith("composer-surface")));
    expect(fetchPanePlan).toHaveBeenCalledWith(pane);
  });

  it("is drawn for background tasks alone, and not for a pane with neither", async () => {
    extraSettings = { workCard: true };
    await act(async () => { renderer = create(<Composer {...props({ backgroundTasks: 2 })} />); });
    expect(classed("section", "work-card")).toHaveLength(1);
    await act(async () => { renderer!.update(<Composer {...props({ backgroundTasks: 0 })} />); });
    expect(classed("section", "work-card")).toHaveLength(0);
  });

  it("leaves the chip as it is beside it", async () => {
    extraSettings = { workCard: true };
    await act(async () => { renderer = create(<Composer {...props({ plan: PLAN })} />); });
    expect(classed("button", "bg-tasks-toggle")).toHaveLength(1);
  });
});

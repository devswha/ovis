import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { forgetWaitingSends, rememberWaitingSend, waitingKey } from "../lib/sentWaiting.ts";
import { LegendList } from "@legendapp/list/react";
import { ChatView } from "../components/ChatView.tsx";
import { FORK_DEFAULTS } from "./settings.ts";

class Box extends EventTarget {
  clientHeight = 758; clientWidth = 600; scrollHeight = 2000; scrollTop = 0;
  readonly children: never[] = []; readonly offsetHeight = 0; readonly style = { setProperty() {} }; firstElementChild = null;
  scrollTo({ top }: { top: number }): void { this.scrollTop = top; }
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 758, right: 600, width: 600, height: 758 }; }
  contains(target: unknown): boolean { return target === this; }
  closest(): null { return null; }
  querySelector(): null { return null; }
  querySelectorAll(): never[] { return []; }
}

const names = ["IS_REACT_ACT_ENVIRONMENT", "Node", "Element", "HTMLElement", "HTMLDivElement", "requestAnimationFrame", "cancelAnimationFrame", "navigator", "localStorage", "window", "document", "getComputedStyle", "ResizeObserver", "MutationObserver", "CSS"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let restored: string | null = null;
let outcomes: object[] = [];
const outcome = (id: string, text: string) => ({ id, pane_id: "p", text, state: "accepted", evidence: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

beforeEach(() => {
  const storage = { getItem: (key: string) => key === "ovis:fork-settings" ? JSON.stringify({ ...FORK_DEFAULTS, chatMotion: true }) : null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: Box, Element: Box, HTMLElement: Box, HTMLDivElement: Box,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    navigator: { languages: ["en"], platform: "Linux" }, localStorage: storage,
    window: { ...listen, localStorage: storage, sessionStorage: storage, innerWidth: 1440, matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, getSelection: () => null },
    document: { ...listen, visibilityState: "visible", activeElement: null, querySelector: () => null, getElementById: () => null, documentElement: { lang: "", dataset: {}, style, hasAttribute: () => false } },
    getComputedStyle: () => style,
    ResizeObserver: class {
      constructor(private readonly callback: (entries: unknown[]) => void) {}
      observe(target: unknown) { queueMicrotask(() => this.callback([{ target, contentRect: { x: 0, y: 0, top: 0, left: 0, width: 600, height: 758 }, borderBoxSize: [{ inlineSize: 600, blockSize: 758 }] }])); }
      unobserve() {}
      disconnect() {}
    },
    MutationObserver: class { observe() {} disconnect() {} },
    CSS: { escape: (value: string) => value },
  };
  for (const name of names) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  }
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("pane/commands")) return Response.json({ commands: [] });
    if (url.includes("pane/prompt")) return Response.json({ prompt: null, suggestion: null, restored, outcomes });
    return Response.json({
      source: "claude-transcript", server_time: new Date().toISOString(), history_id: "h1",
      turns: [{ role: "assistant", ts: "2026-11-01T09:59:00Z", parts: [{ kind: "text", text: "Ready." }] }],
    });
  }, { preconnect: globalThis.fetch.preconnect }));
});
afterEach(async () => {
  outcomes = [];
  await act(async () => renderer?.unmount());
  renderer = undefined;
  fetchSpy.mockRestore();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
});

/** the rows ChatView hands its timeline: what it draws, in order */
const rows = (): { key: string; turn: { parts: { text?: string }[] } | null; outcome: { id: string } | null; sendAt?: number }[] => renderer!.root.findByType(LegendList).props.data;

async function mount(pane: string): Promise<void> {
  await act(async () => {
    renderer = create(createElement(SettingsProvider, null, createElement(ChatView, { paneId: pane, refreshKey: 0, connected: true, ended: false, agent: "claude", agentStatus: "idle" })),
      { createNodeMock: () => new Box() });
  });
  // the conversation and the prompt are read: the transcript's turn is drawn and the prompt answered
  const read = (): boolean => fetchSpy.mock.calls.some(([input]) => String(input).includes("pane/prompt")) && rows().some((row) => row.turn?.parts[0]?.text === "Ready.");
  const deadline = Date.now() + 5_000;
  await act(async () => {
    while (!read()) {
      if (Date.now() > deadline) throw new Error("the chat never read its conversation and prompt");
      await Bun.sleep(5);
    }
  });
  // the prompt's answer lands in state after its read resolves
  for (let pass = 0; pass < 3; pass += 1) await act(async () => { await Promise.resolve(); });
}

const sendKeys = (): string[] => rows().filter((row) => row.sendAt !== undefined).map((row) => row.key);
const key = (pane: string): string => waitingKey("local", pane);

test("a send waiting for its transcript turn is a row of the chat", async () => {
  restored = null;
  rememberWaitingSend(key("waiting"), "fix the test", Date.now(), null);
  await mount("waiting");
  expect(sendKeys()).toHaveLength(1);
  forgetWaitingSends(key("waiting"));
});

test("a send cancelled and restored before its transcript arrives leaves no bubble", async () => {
  restored = "fix the test";
  rememberWaitingSend(key("cancelled"), "fix the test", Date.now(), null);
  await mount("cancelled");
  // the prompt read says the agent's box holds the message again: the send is no sent row
  expect(sendKeys()).toEqual([]);
  expect(rows().map((row) => row.turn?.parts[0]?.text)).toEqual(["Ready."]);
  forgetWaitingSends(key("cancelled"));
});

test("a cancelled send stays away once the restored input is cleared", async () => {
  restored = "fix the test";
  rememberWaitingSend(key("retired"), "fix the test", Date.now(), null);
  await mount("retired");
  expect(sendKeys()).toEqual([]);
  // the user clears the restored text in the agent's box: the next prompt read answers none
  restored = null;
  const reads = (): number => fetchSpy.mock.calls.filter(([input]) => String(input).includes("pane/prompt")).length;
  const before = reads();
  const deadline = Date.now() + 8_000;
  await act(async () => {
    while (reads() === before) {
      if (Date.now() > deadline) throw new Error("the chat never read the prompt again");
      await Bun.sleep(25);
    }
  });
  for (let pass = 0; pass < 3; pass += 1) await act(async () => { await Promise.resolve(); });
  expect(sendKeys()).toEqual([]);
  // the chat is left for the terminal and comes back: the cancelled send stays retired
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await mount("retired");
  expect(sendKeys()).toEqual([]);
  forgetWaitingSends(key("retired"));
}, 15_000);

test("a queued delivery stays out of the rows", async () => {
  restored = null;
  rememberWaitingSend(key("queued"), "from the queue", Date.now(), null, true);
  await mount("queued");
  expect(sendKeys()).toEqual([]);
  forgetWaitingSends(key("queued"));
});

test("a send's own outcome is drawn on the send's row, not as a row beside it", async () => {
  restored = null;
  outcomes = [outcome("o1", "@effect apply it")];
  rememberWaitingSend(key("owned"), "@effect apply it", Date.now(), null, false, []);
  await mount("owned");
  expect(rows().map((row) => [row.key.startsWith("send:"), row.outcome?.id ?? null])).toEqual([[false, null], [true, "o1"]]);
  forgetWaitingSends(key("owned"));
});

test("an outcome the chat had read before the send is not the send's own", async () => {
  restored = null;
  outcomes = [outcome("o1", "@effect apply it")];
  rememberWaitingSend(key("older"), "@effect apply it", Date.now(), null, false, ["o1"]);
  await mount("older");
  expect(rows().map((row) => [row.key.startsWith("send:"), row.key.startsWith("outcome:")])).toEqual([[false, false], [false, true], [true, false]]);
  forgetWaitingSends(key("older"));
});

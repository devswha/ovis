import { describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { ChatRowMemoryContext, type ChatRowMemory } from "../lib/chatRowState.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { Turn } from "./ChatView.tsx";

const text = (value: string): ConversationPart => ({ kind: "text", text: value });
const tool = (command: string): ConversationPart => ({ kind: "tool", name: "Bash", summary: command, input: JSON.stringify({ command }), output: "" });

const render = (parts: ConversationPart[], state: { live: boolean; waiting?: boolean }): string => {
  const turn: ConversationTurn = { role: "assistant", ts: "2026-01-01T12:00:00Z", end_ts: "2026-01-01T12:01:00Z", parts };
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Turn, {
      paneId: "w1:p1", turn, rowKey: "turn:1", live: state.live, waiting: state.waiting ?? false, showThinking: false,
    }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

const titles = (html: string) => [...html.matchAll(/class="work-block-title">([^<]*)</g)].map((match) => match[1]);
const expanded = (html: string) => [...html.matchAll(/class="work-block-head" aria-expanded="(true|false)"/g)].map((match) => match[1] === "true");

describe("an agent turn's work blocks", () => {
  it("says Working… for a running turn that has written no work or words yet", () => {
    for (const parts of [[], [text("\n\n")]]) {
      const html = render(parts, { live: true });
      expect(html).toContain("work-block is-live is-pending");
      expect(titles(html)).toEqual(["Working…"]);
      expect(titles(render(parts, { live: false }))).toEqual([]);
    }
  });

  it("draws each run where the agent ran it, with the turn's state and duration on the last", () => {
    const parts = [text("Checking first."), tool("ls"), text("Now the loans."), tool("cat loans"), text("No book is on loan.")];
    const settled = render(parts, { live: false });
    const order = ["Checking first.", "Worked<", "Now the loans.", "Worked for 1m", "No book is on loan."].map((needle) => settled.indexOf(needle));
    expect(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!))).toBe(true);
    expect(titles(settled)).toEqual(["Worked", "Worked for 1m"]);
    expect(expanded(settled)).toEqual([false, false]);
    const live = render(parts, { live: true });
    expect(titles(live)).toEqual(["Worked", "Working…"]);
    expect(expanded(live)).toEqual([false, true]);
    expect(titles(render(parts, { live: true, waiting: true }))).toEqual(["Worked", "Needs you"]);
  });

  it("keeps a block folded when the words before its tools join it (#2063)", async () => {
    const commentary = (value: string): ConversationPart => ({ kind: "text", text: value, phase: "commentary" });
    const view = (parts: ConversationPart[], memory: ChatRowMemory) => createElement(ChatRowMemoryContext.Provider, { value: memory, children: createElement(SettingsProvider, { children: createElement(Turn, {
      paneId: "w1:p1", turn: { role: "assistant", ts: "2026-01-01T12:00:00Z", parts }, rowKey: "turn:1", live: true, waiting: false, showThinking: false,
    }) }) });
    const heads = (renderer: ReactTestRenderer) => renderer.root.findAll((node) => node.props.className === "work-block-head").map((node) => node.props["aria-expanded"] as boolean);
    const actEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    const globals = new Map(["window", "document", "getComputedStyle"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const listeners = { addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...listeners, matchMedia: () => ({ matches: false, ...listeners }) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { ...listeners, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      // a later Codex record marks the words commentary; an empty commentary record is filled in
      for (const [before, after] of [[text("Checking."), commentary("Checking.")], [commentary(""), commentary("Checking.")]]) {
        const memory: ChatRowMemory = { toggles: new Map(), outputs: new Map() };
        let renderer!: ReactTestRenderer;
        await act(async () => { renderer = create(view([before!, tool("ls")], memory)); });
        await act(async () => { renderer.root.find((node) => node.props.className === "work-block-head").props.onClick(); });
        expect(heads(renderer)).toEqual([false]);
        await act(async () => { renderer.update(view([after!, tool("ls")], memory)); });
        expect(heads(renderer)).toEqual([false]);
        await act(async () => { renderer.unmount(); });
        // the row scrolled away and back: its memory still names the block
        await act(async () => { renderer = create(view([after!, tool("ls")], memory)); });
        expect(heads(renderer)).toEqual([false]);
        await act(async () => { renderer.unmount(); });
      }
    } finally {
      if (actEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
      else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
      for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  it("keeps one block for tools followed by the answer", () => {
    const html = render([tool("ls"), tool("cat a"), text("Done.")], { live: false });
    expect(titles(html)).toEqual(["Worked for 1m"]);
    expect(html.indexOf("Worked for 1m")).toBeLessThan(html.indexOf("Done."));
  });
});

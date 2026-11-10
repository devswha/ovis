import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { RelayPairingRequest } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { RelayPairingPrompt, secondsLeft } from "./RelayPairingPrompt.tsx";

const AT = Date.parse("2026-11-10T00:00:00.000Z");
const request = (over: Partial<RelayPairingRequest> = {}): RelayPairingRequest => ({ id: "p1", label: "Hako's iPhone", digits: "725403", expires_at: new Date(AT + 90_000).toISOString(), ...over });

/** every string an element draws, in order */
function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}

describe("the PC's prompt for a device waiting for approval", () => {
  const keys = ["window", "document", "navigator", "getComputedStyle", "HTMLElement", "Node", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
  /** what decideRelayPairing posted: the path and the body */
  let decided: [string, unknown][];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  class HTMLElement {
    isConnected = true;
    focused = 0;
    constructor(readonly name: string, readonly inside: HTMLElement[] = []) {}
    focus(): void { this.focused += 1; page.activeElement = this; }
    contains(other: unknown): boolean { return other === this || this.inside.some((node) => node.contains(other)); }
  }
  /** the document: what has the focus now */
  let page: { activeElement: HTMLElement | null; body: HTMLElement };
  /** what had the focus when the prompt arrived */
  let opener: HTMLElement;
  /** the node behind each drawn element, by test id or tag */
  let nodes: Map<string, HTMLElement>;
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    decided = [];
    for (const key of keys) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    opener = new HTMLElement("opener");
    page = { activeElement: opener, body: new HTMLElement("body") };
    nodes = new Map();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "http://127.0.0.1:7421/", origin: "http://127.0.0.1:7421", pathname: "/" },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, querySelectorAll: () => [],
      get activeElement() { return page.activeElement; }, get body() { return page.body; },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: unknown, init?: RequestInit) => {
      decided.push([new URL(String(input), "http://127.0.0.1:7421").pathname, JSON.parse(String(init?.body))]);
      expect(init?.method).toBe("POST");
      return new Response(null, { status: 204 });
    } });
    jest.useFakeTimers();
    jest.setSystemTime(AT);
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    jest.useRealTimers();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const element = (pairings: RelayPairingRequest[]) => createElement(SettingsProvider, null, createElement(RelayPairingPrompt, { pairings }));
  async function show(pairings: RelayPairingRequest[]): Promise<ReactTestInstance> {
    const layer = new HTMLElement("layer");
    await act(async () => {
      renderer = create(element(pairings), { createNodeMock: (drawn) => {
        const props = drawn.props as { className?: string; id?: string };
        if (props.className === "relay-pairing-layer") return layer;
        if (drawn.type !== "div" || !props.className?.includes("relay-pairing-prompt")) return null;
        const node = new HTMLElement("prompt");
        layer.inside.push(node);
        nodes.set(String((drawn.props as { "aria-labelledby": string })["aria-labelledby"]), node);
        return node;
      } });
    });
    return renderer!.root;
  }
  const prompts = (root: ReactTestInstance) => root.findAll((node) => node.type === "div" && node.props["data-testid"] === "relay-pairing-prompt");
  const nodeOf = (prompt: ReactTestInstance) => nodes.get(String(prompt.props["aria-labelledby"]))!;
  const sentence = (prompt: ReactTestInstance) => text(prompt.find((node) => node.type === "span" && node.props.id === prompt.props["aria-labelledby"]));
  const left = (prompt: ReactTestInstance) => text(prompt.find((node) => node.props["data-testid"] === "relay-pairing-left")).trim();

  it("tells the owner to type the number on the other device when this PC waits to be added", async () => {
    const [prompt] = prompts(await show([request({ local_only: true })]));
    expect(sentence(prompt!)).toBe("Hako's iPhone wants to add this PC to your account. Type 725 403 on Hako's iPhone, then press Approve here. Approve only after Hako's iPhone accepted the number.");
    expect(text(prompt!.findByType("strong"))).toBe("725 403");
    expect(prompt!.props["data-local-only"]).toBe("true");
  });

  it("asks to compare the digits when the other device shows them", async () => {
    const [prompt] = prompts(await show([request()]));
    expect(sentence(prompt!)).toBe("Hako's iPhone wants to pair through the relay. Approve it only if its screen shows 725 403");
    expect(prompt!.props["data-local-only"]).toBeUndefined();
    // an older server sends false for nothing, but a false is the same sentence
    await act(async () => { renderer!.update(element([request({ local_only: false })])); });
    expect(sentence(prompts(renderer!.root)[0]!)).toContain("Approve it only if its screen shows");
  });

  it("counts the seconds left down from expires_at and stops at 0", async () => {
    const root = await show([request()]);
    expect(left(prompts(root)[0]!)).toBe("90 s left");
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(left(prompts(root)[0]!)).toBe("89 s left");
    await act(async () => { jest.advanceTimersByTime(88_000); });
    expect(left(prompts(root)[0]!)).toBe("1 s left");
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(left(prompts(root)[0]!)).toBe("0 s left");
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(left(prompts(root)[0]!)).toBe("0 s left");
  });

  it("shows no time for a request without one it can read", async () => {
    const root = await show([request({ expires_at: "" })]);
    expect(root.findAll((node) => node.props["data-testid"] === "relay-pairing-left")).toEqual([]);
    expect(secondsLeft("", AT)).toBeNull();
    expect(secondsLeft(new Date(AT + 1).toISOString(), AT)).toBe(1);
    expect(secondsLeft(new Date(AT - 5000).toISOString(), AT)).toBe(0);
  });

  it("is an alertdialog named by its sentence, in a layer labelled for devices", async () => {
    const root = await show([request()]);
    const [prompt] = prompts(root);
    expect(prompt!.props.role).toBe("alertdialog");
    expect(prompt!.props["aria-modal"]).toBe("false");
    expect(prompt!.props.tabIndex).toBe(-1);
    expect(sentence(prompt!)).toContain("Hako's iPhone");
    // the clock is not part of the name, and is not announced each second
    expect(prompt!.find((node) => node.props["data-testid"] === "relay-pairing-left").props["aria-live"]).toBe("off");
    expect(root.find((node) => node.props.className === "relay-pairing-layer").props["aria-label"]).toBe("Devices waiting for approval");
  });

  it("takes the focus on the prompt itself, never on Approve, and gives it back when the prompt goes", async () => {
    const root = await show([request()]);
    const node = nodeOf(prompts(root)[0]!);
    expect(page.activeElement).toBe(node);
    expect(node.name).toBe("prompt");
    expect(node.focused).toBe(1);
    // a second that passes, or a second device, does not take the focus again
    await act(async () => { jest.advanceTimersByTime(3000); });
    await act(async () => { renderer!.update(element([request(), request({ id: "p2", label: "desk2" })])); });
    expect(node.focused).toBe(1);
    expect(page.activeElement).toBe(node);
    // the first is decided while it has the focus: the one still waiting takes it
    page.activeElement = page.body;
    await act(async () => { renderer!.update(element([request({ id: "p2", label: "desk2" })])); });
    const second = nodeOf(prompts(root)[0]!);
    expect(second).not.toBe(node);
    expect(page.activeElement).toBe(second);
    page.activeElement = page.body;
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(page.activeElement).toBe(opener);
    expect(opener.focused).toBe(1);
  });

  it("leaves the focus where the person moved it meanwhile", async () => {
    const root = await show([request(), request({ id: "p2", label: "desk2" })]);
    const elsewhere = new HTMLElement("composer");
    await act(async () => { root.find((node) => node.props.className === "relay-pairing-layer").props.onBlur({ relatedTarget: elsewhere, currentTarget: { contains: () => false } }); });
    page.activeElement = elsewhere;
    await act(async () => { renderer!.update(element([request({ id: "p2", label: "desk2" })])); });
    expect(page.activeElement).toBe(elsewhere);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(page.activeElement).toBe(elsewhere);
    expect(opener.focused).toBe(0);
  });

  it("still approves and declines through decideRelayPairing", async () => {
    const root = await show([request(), request({ id: "p2", label: "desk2", local_only: true })]);
    const [first, second] = prompts(root);
    await act(async () => { first!.findAllByType("button")[0]!.props.onClick(); });
    await act(async () => { second!.findAllByType("button")[1]!.props.onClick(); });
    expect(decided).toEqual([["/api/relay/pairing", { id: "p1", decision: "approve" }], ["/api/relay/pairing", { id: "p2", decision: "decline" }]]);
  });
});

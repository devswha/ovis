import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { InboxRail, type InboxRailProps } from "./InboxRail.tsx";

describe("InboxRail", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    const on = { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...on, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { ...on, body: { nodeType: 1, children: [] }, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const draw = async (props: Partial<InboxRailProps> = {}): Promise<ReactTestInstance> => {
    const rail = createElement(InboxRail, { onExit: () => {}, ...props });
    await act(async () => { renderer = create(createElement(SettingsProvider, null, rail)); });
    return renderer!.root;
  };
  const buttons = (root: ReactTestInstance): ReactTestInstance[] => root.findAll((node) => node.type === "button");
  /** a button by the class the rail gives it alone */
  const button = (root: ReactTestInstance, name: string): ReactTestInstance | undefined => buttons(root).find((node) => String(node.props.className).split(" ").includes(name));

  it("is a navigation landmark named for the mode, apart from the list's own", async () => {
    const nav = (await draw()).findByType("nav");
    expect(nav.props["aria-label"]).toBe("Inbox mode");
  });

  it("begins with the way out: the app's mark, named and titled Back to Ovis, which a press takes", async () => {
    let left = 0;
    const root = await draw({ onExit: () => { left += 1; } });
    const exit = buttons(root)[0]!;
    expect(exit).toBe(button(root, "inbox-rail-exit")!);
    expect([exit.props["aria-label"], exit.props.title]).toEqual(["Back to Ovis", "Back to Ovis"]);
    // the mark is the app's own, drawn as a picture that says nothing: the button's name says it
    const mark = exit.findByType("img");
    expect([mark.props.src, mark.props.alt]).toEqual(["/icons/icon-192.png?v=sheep1", ""]);
    await act(async () => { exit.props.onClick(); });
    expect(left).toBe(1);
  });
});

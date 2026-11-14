import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { InboxRail, type InboxRailProps } from "./InboxRail.tsx";

describe("InboxRail", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  /** every press the rail handed on, in order */
  let pressed: string[];

  beforeEach(() => {
    pressed = [];
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

  const props = (change: Partial<InboxRailProps> = {}): InboxRailProps => ({
    onExit: () => pressed.push("exit"), onInbox: () => pressed.push("inbox"), onPalette: () => pressed.push("palette"),
    waiting: null, alerts: { on: true, title: "Alerts on in the app. Tap to turn them off", toggle: () => pressed.push("alerts") },
    onSettings: () => pressed.push("settings"),
    // the shell's own: a shortcut's keys after the label, where the shortcut has keys
    shortcutTitle: (label, id) => id === "palette" ? `${label} (Ctrl+Shift+K)` : label,
    ...change,
  });
  const view = (change: Partial<InboxRailProps>) => createElement(SettingsProvider, null, createElement(InboxRail, props(change)));
  const draw = async (change: Partial<InboxRailProps> = {}): Promise<ReactTestInstance> => {
    await act(async () => { renderer = create(view(change)); });
    return renderer!.root;
  };
  const redraw = (change: Partial<InboxRailProps>) => act(async () => { renderer!.update(view(change)); });
  const buttons = (root: ReactTestInstance): ReactTestInstance[] => root.findAll((node) => node.type === "button");
  /** which button a node is: the class the rail gives it alone */
  const kind = (node: ReactTestInstance): string => String(node.props.className).split(" ").find((name) => name.startsWith("inbox-rail-") && name !== "inbox-rail-item") ?? "";
  const button = (root: ReactTestInstance, name: string): ReactTestInstance => buttons(root).find((node) => kind(node) === `inbox-rail-${name}`)!;
  const named = (node: ReactTestInstance): [name: unknown, tooltip: unknown] => [node.props["aria-label"], node.props.title];
  /** the lucide glyph a button draws */
  const glyph = (node: ReactTestInstance): string => String(node.findByType("svg").props.className).split(" ").find((name) => name.startsWith("lucide-")) ?? "";
  const press = (node: ReactTestInstance) => act(async () => { node.props.onClick(); });

  it("is a navigation landmark named for the mode, apart from the list's own", async () => {
    const nav = (await draw()).findByType("nav");
    expect(nav.props["aria-label"]).toBe("Inbox mode");
  });

  it("holds the way out, the place and the palette at its top, then alerts and Settings in its lower group, each a plain button", async () => {
    const root = await draw();
    const groups = root.findAll((node) => node.type === "div" && String(node.props.className).split(" ").includes("inbox-rail-group"));
    expect(groups.map((group) => [String(group.props.className).split(" ").at(-1), buttons(group).map(kind)])).toEqual([
      ["is-top", ["inbox-rail-exit", "inbox-rail-place", "inbox-rail-palette"]],
      ["is-lower", ["inbox-rail-alerts", "inbox-rail-settings"]],
    ]);
    // a plain Tab stop each: none is taken out of the keyboard's order or disabled
    for (const node of buttons(root)) expect([node.props.type, node.props.tabIndex, node.props.disabled]).toEqual(["button", undefined, undefined]);
  });

  it("begins with the way out: the app's mark, named and titled Back to Ovis, which a press takes", async () => {
    const root = await draw();
    const exit = buttons(root)[0]!;
    expect(kind(exit)).toBe("inbox-rail-exit");
    expect(named(exit)).toEqual(["Back to Ovis", "Back to Ovis"]);
    // the mark is the app's own, drawn as a picture that says nothing: the button's name says it
    const mark = exit.findByType("img");
    expect([mark.props.src, mark.props.alt]).toEqual(["/icons/icon-192.png?v=sheep1", ""]);
    await press(exit);
    expect(pressed).toEqual(["exit"]);
  });

  it("marks the inbox as the current page, the one place the rail has, and a press asks the list for its top", async () => {
    const root = await draw();
    const place = button(root, "place");
    expect(named(place)).toEqual(["Agent inbox", "Agent inbox"]);
    expect(buttons(root).filter((node) => node.props["aria-current"] !== undefined).map((node) => [kind(node), node.props["aria-current"]])).toEqual([["inbox-rail-place", "page"]]);
    await press(place);
    expect(pressed).toEqual(["inbox"]);
  });

  it("opens the command palette under the palette's own name, with its shortcut in the tooltip where one is set", async () => {
    const root = await draw();
    const palette = button(root, "palette");
    expect(named(palette)).toEqual(["Search panes and actions", "Search panes and actions (Ctrl+Shift+K)"]);
    await press(palette);
    expect(pressed).toEqual(["palette"]);
    // a shortcut with no keys: the tooltip is the name alone
    await redraw({ shortcutTitle: (label) => label });
    expect(named(button(root, "palette"))).toEqual(["Search panes and actions", "Search panes and actions"]);
  });

  it("draws the waiting count only while an agent waits, first in the lower group, and a press opens the next one", async () => {
    const root = await draw();
    expect(buttons(root).map(kind)).not.toContain("inbox-rail-waiting");
    await redraw({ waiting: { count: 12, open: () => pressed.push("next") } });
    const lower = root.findAll((node) => node.type === "div" && String(node.props.className).split(" ").includes("is-lower"))[0]!;
    expect(buttons(lower).map(kind)).toEqual(["inbox-rail-waiting", "inbox-rail-alerts", "inbox-rail-settings"]);
    const waiting = button(root, "waiting");
    // the name says the number; the tooltip says what a press does
    expect(named(waiting)).toEqual(["12 waiting for you", "Open the next session waiting for you"]);
    // the count is the app's own waiting pill, drawn from its number and hidden from a screen reader
    const pill = waiting.findByProps({ "data-count": 12 });
    expect([pill.props.className, pill.props["aria-hidden"]]).toEqual(["header-more-dot is-waiting", "true"]);
    await press(waiting);
    expect(pressed).toEqual(["next"]);
    await redraw({ waiting: null });
    expect(buttons(root).map(kind)).not.toContain("inbox-rail-waiting");
  });

  it("switches this device's alerts: pressed and a bell while on, not pressed and a struck bell while off, the bell's own sentence as its tooltip", async () => {
    const root = await draw();
    const alerts = () => button(root, "alerts");
    expect([...named(alerts()), alerts().props["aria-pressed"], glyph(alerts())]).toEqual(["Alerts", "Alerts on in the app. Tap to turn them off", true, "lucide-bell"]);
    await press(alerts());
    expect(pressed).toEqual(["alerts"]);
    await redraw({ alerts: { on: false, title: "Alerts off on this device. Tap to turn them on", toggle: () => pressed.push("alerts") } });
    expect([...named(alerts()), alerts().props["aria-pressed"], glyph(alerts())]).toEqual(["Alerts", "Alerts off on this device. Tap to turn them on", false, "lucide-bell-off"]);
  });

  it("opens Settings, its shortcut in the tooltip where one is set", async () => {
    const root = await draw({ shortcutTitle: (label, id) => id === "settings" ? `${label} (Ctrl+Shift+,)` : label });
    const settings = button(root, "settings");
    expect(named(settings)).toEqual(["Settings", "Settings (Ctrl+Shift+,)"]);
    await press(settings);
    expect(pressed).toEqual(["settings"]);
  });
});

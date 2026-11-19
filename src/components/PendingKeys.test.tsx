import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { KeyFingerprintWait, PendingKeys, type PendingKey } from "./PendingKeys.tsx";

const pending = (id: string, label: string, fingerprint: string): PendingKey => ({ id, label, fingerprint, via: "relay", redeemed_at: "2026-11-20T04:00:00.000Z", slots: { used: 2, of: 5 } });

describe("keys waiting for this PC's screen", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");

  it("T71: shows each key's fingerprint and says the name is the device's own claim", async () => {
    await act(async () => { renderer = create(<SettingsProvider><PendingKeys pending={[pending("p1", "Pixel 9", "AB12-CD34")]} onDecline={() => {}} /></SettingsProvider>); });
    const shown = text(renderer!.root);
    expect(shown).toContain("AB12-CD34");
    expect(shown).toContain("Pixel 9");
    expect(shown.toLowerCase()).toContain("says");
  });

  it("T72: declines exactly the one key pressed, and approving is left to this PC's screen", async () => {
    const declined: string[] = [];
    await act(async () => { renderer = create(<SettingsProvider><PendingKeys pending={[pending("p1", "Pixel 9", "AB12-CD34"), pending("p2", "iPad", "EF56-GH78")]} onDecline={(id) => declined.push(id)} /></SettingsProvider>); });
    const buttons = renderer!.root.findAll((node) => node.type === "button");
    expect(buttons.map(text)).toEqual(["Decline", "Decline"]);
    await act(async () => { buttons[1]!.props.onClick(); });
    expect(declined).toEqual(["p2"]);
  });

  it("T71: the device shows the same fingerprint while it waits for the PC's screen", async () => {
    await act(async () => { renderer = create(<SettingsProvider><KeyFingerprintWait pc="Desk" fingerprint="AB12-CD34" /></SettingsProvider>); });
    expect(text(renderer!.root)).toContain("AB12-CD34");
  });

  it("P11: where the PC has no screen proof the device says to approve on the PC and asks for no comparison", async () => {
    await act(async () => { renderer = create(<SettingsProvider><KeyFingerprintWait pc="Desk" fingerprint={null} /></SettingsProvider>); });
    const shown = text(renderer!.root);
    expect(shown).toContain("Desk");
    expect(shown).not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}/);
    expect(renderer!.root.findAll((node) => node.props.className === "pending-key-fingerprint")).toEqual([]);
  });
});

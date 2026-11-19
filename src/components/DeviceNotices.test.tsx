import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { DeviceNotice } from "../../shared/account-devices-api.ts";
import { keyFingerprint } from "../lib/deviceNotices.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { DeviceNotices } from "./DevicePairedNotice.tsx";

const KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + "A".repeat(87);
const notice = (over: Partial<DeviceNotice>): DeviceNotice => ({
  seq: 1, id: "1".padStart(32, "0"), at: "2026-11-20T04:00:00.000Z", kind: "admit", how: "list", key: KEY, no: 4, row: "r1", label: "Galaxy S30",
  by: null, account: "acct", open: true, method: "github", two_step: "set", ...over,
});

describe("device notices", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
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
  const mount = async (notices: readonly DeviceNotice[], dismissed: DeviceNotice[] = []) => {
    await act(async () => {
      renderer = create(<SettingsProvider><DeviceNotices pc="Desk" notices={notices} onDismiss={(item) => dismissed.push(item)} /></SettingsProvider>);
    });
    return renderer!.root.findAll((node) => node.props["data-testid"] === "device-notice");
  };

  it("T34: an admission names the PC, the device, its key and how it signed in", async () => {
    const [card] = await mount([notice({})]);
    const shown = text(card!);
    expect(shown).toContain("joined Desk: Galaxy S30");
    expect(shown).toContain("GitHub");
    expect(shown).toContain(keyFingerprint(KEY));
  });

  it("T58: Apple's two-step sign-in is said to be set on the account, never that this sign-in used it", async () => {
    const [card] = await mount([notice({ kind: "method", method: "apple", two_step: "set", open: false })]);
    const shown = text(card!);
    expect(shown).toContain("Apple");
    expect(shown).toContain("set");
    expect(shown.toLowerCase()).not.toContain("used");
  });

  it("T57: an undecided admission stays without a dismiss after its row is gone; a told one can be dismissed", async () => {
    const dismissed: DeviceNotice[] = [];
    const told = notice({ seq: 2, id: "2".padStart(32, "0"), kind: "method", open: false });
    const cards = await mount([notice({ row: null }), told], dismissed);
    expect(cards.map((card) => card.findAll((node) => node.type === "button" && node.props["aria-label"] === "Dismiss").length)).toEqual([0, 1]);
    await act(async () => { cards[1]!.find((node) => node.type === "button").props.onClick(); });
    expect(dismissed).toEqual([told]);
  });

  it("G5: shows nothing for journal kinds this release does not tell here", async () => {
    expect(await mount([notice({ kind: "merge", open: false })])).toEqual([]);
  });
});

describe("keyFingerprint", () => {
  it("T34: four groups of four hex digits of the key's SHA-256, the same key the same every time", () => {
    expect(keyFingerprint(KEY)).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(keyFingerprint(KEY)).toBe(keyFingerprint(KEY));
    expect(keyFingerprint(KEY)).not.toBe(keyFingerprint(KEY.slice(0, -1) + "B"));
  });
});

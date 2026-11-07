import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { AccountState } from "./AccountSection.tsx";

// AccountSection reports its state again whenever its onAccount changes, as the real one does (its effect's deps)
const accountModule = await import("./AccountSection.tsx");
await mock.module("./AccountSection.tsx", () => ({
  ...accountModule,
  AccountSection: ({ onAccount }: { onAccount?: (state: AccountState) => void }) => {
    useEffect(() => { onAccount?.({ signedIn: true, account: "a", pcs: [], provider: "github", reachable: true }); }, [onAccount]);
    return null;
  },
}));
const { ConnectAccount } = await import("./ConnectPhoneDialog.tsx");
const { SettingsProvider } = await import("../lib/settings.ts");

describe("the sign-in above Add a connection's tabs", () => {
  let renderer: ReactTestRenderer | undefined;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "test", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://workstation.example.ts.net/" },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    saved.clear();
  });

  it("tells Settings once that a sign-in finished, however often the sheet renders again", async () => {
    let told = 0;
    const onSignedIn = () => { told += 1; };
    // the sheet renders again whenever Settings does: a parent with a new prop, the child itself unchanged
    const Sheet = ({ render }: { render: number }) => <div data-render={render}><ConnectAccount signedIn={false} provider={null} onAccount={() => {}} onSignedIn={onSignedIn} /></div>;
    const sheet = (n: number) => <SettingsProvider><Sheet render={n} /></SettingsProvider>;
    await act(async () => { renderer = create(sheet(0)); });
    for (let render = 1; render <= 3; render += 1) await act(async () => { renderer!.update(sheet(render)); });
    expect(told).toBe(1);
  });
});

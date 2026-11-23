import { afterEach, describe, expect, it } from "bun:test";

import { tellAppWhichPc } from "./nativeApp.ts";

describe("telling the phone app which PC this page is", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
  afterEach(() => { if (before) Object.defineProperty(globalThis, "Capacitor", before); else Reflect.deleteProperty(globalThis, "Capacitor"); });
  const app = (methods: string[]) => {
    const told: unknown[] = [];
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
      isNativePlatform: () => true,
      PluginHeaders: [{ name: "HerdrShell", methods: methods.map((name) => ({ name })) }],
      nativePromise: async (plugin: string, method: string, options: unknown) => { told.push([plugin, method, options]); return {}; },
    } });
    return told;
  };

  it("gives its relay ID and its name, the name without .local", () => {
    const told = app(["identify"]);
    tellAppWhichPc({ serverId: "a".repeat(32), name: "hasang-uui-MacBookPro.local" });
    tellAppWhichPc({ name: "nas" });
    expect(told).toEqual([["HerdrShell", "identify", { server_id: "a".repeat(32), name: "hasang-uui-MacBookPro" }], ["HerdrShell", "identify", { name: "nas" }]]);
  });

  it("tells nothing with nothing to tell, to an app without identify, or outside the app", () => {
    const told = app(["identify"]);
    tellAppWhichPc({});
    expect(told).toEqual([]);
    expect(app(["getState"])).toEqual([]);
    tellAppWhichPc({ serverId: "a".repeat(32) });
    Reflect.deleteProperty(globalThis, "Capacitor");
    tellAppWhichPc({ serverId: "a".repeat(32) });
  });
});

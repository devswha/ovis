import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { migrateKeyBarItems } from "../../lib/keyBar.ts";
import { DEFAULT_SETTINGS, loadSettings, PHONE_TABS_STORAGE_KEY, sanitizeSettings, saveSettings } from "../../lib/settings.ts";

/** Defaults change only for new devices; existing fork installations keep their choices. */
describe("fork settings compatibility", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  let records: Map<string, string>;
  beforeEach(() => {
    records = new Map();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => records.set(key, value),
      removeItem: (key: string) => records.delete(key),
    } } });
  });
  afterEach(() => {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });

  it("uses upstream behavior on a new device", () => {
    expect(DEFAULT_SETTINGS.phoneTabs).toBe("row");
    expect(loadSettings().keyBarItems).not.toContainEqual({ type: "modifier", modifier: "super" });
    expect(loadSettings()).toMatchObject({ phoneTabs: "row",
      squareCorners: false, moreViewToggle: false, agentFriends: false,
      piModelPicker: false, chatMotion: false, piLiveVoice: false,
      computerView: false, pullRequests: false, readAloud: false });
  });

  it("preserves implicit fork defaults without changing storage while loading", () => {
    const raw = JSON.stringify({ contextCircle: true, speechVoice: "af_heart", openLiveWork: true });
    records.set("ovis:settings", raw);
    expect(loadSettings()).toMatchObject({ phoneTabs: "header",
      squareCorners: true, moreViewToggle: true, agentFriends: true,
      piModelPicker: true, chatMotion: true, piLiveVoice: true,
      computerView: true, pullRequests: true, readAloud: true });
    expect(loadSettings().keyBarItems).toContainEqual({ type: "modifier", modifier: "super" });
    expect(records.get("ovis:settings")).toBe(raw);
    expect(records.size).toBe(1);
  });

  it.each([{ extras: ["home-end"] }, { extras: [] }] as const)("preserves an extras-only fork key bar: %j", ({ extras }) => {
    records.set("ovis:settings", JSON.stringify({ contextCircle: true, keyBarExtras: extras }));
    expect(loadSettings().keyBarItems).toEqual(migrateKeyBarItems(extras));
  });

  it("carries a saved Composer extras choice over to Pi model picker", () => {
    records.set("ovis:settings", JSON.stringify({ language: "en", composerExtras: false }));
    expect(loadSettings().piModelPicker).toBe(false);
    records.set("ovis:settings", JSON.stringify({ language: "en", composerExtras: true }));
    expect(loadSettings().piModelPicker).toBe(true);
    records.set("ovis:settings", JSON.stringify({ language: "en", composerExtras: true, piModelPicker: false }));
    expect(loadSettings().piModelPicker).toBe(false);
  });

  it("keeps explicit choices through saving, reload and reset", () => {
    records.set("ovis:settings", JSON.stringify({ contextCircle: false, phoneTabs: "header", squareCorners: false }));
    records.set(PHONE_TABS_STORAGE_KEY, JSON.stringify("row"));
    const settings = loadSettings();
    expect(settings).toMatchObject({ phoneTabs: "row", squareCorners: false, moreViewToggle: true });
    expect(saveSettings(settings)).toBe(true);
    expect(loadSettings()).toEqual(settings);
    expect(saveSettings(DEFAULT_SETTINGS)).toBe(true);
    expect(loadSettings()).toMatchObject({ phoneTabs: "row", squareCorners: false, moreViewToggle: false });
  });

  it("does not apply the migration to an upstream record or accept malformed switches", () => {
    records.set("ovis:settings", JSON.stringify({ theme: "dark", phoneTabs: "row" }));
    expect(loadSettings()).toMatchObject({ phoneTabs: "row", squareCorners: false });
    expect(sanitizeSettings({ squareCorners: "true", piLiveVoice: 1 })).toMatchObject({ squareCorners: false, piLiveVoice: false });
  });
});

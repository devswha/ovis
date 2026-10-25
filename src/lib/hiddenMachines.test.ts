import { describe, expect, it } from "bun:test";

import { afterEach, beforeEach } from "bun:test";

import { canHideMachine, isMachineShown, HIDDEN_MACHINES_KEY, HIDDEN_MACHINES_MAX, parseHiddenMachines, readHiddenMachines, selectionAfterHiding, setHiddenMachines, shownMachines, withMachineHidden } from "./hiddenMachines.ts";
import { DEFAULT_SETTINGS, saveSettings } from "./settings.ts";

const roster = [{ id: "local" }, { id: "work" }, { id: "home" }];

describe("PCs shown on this device", () => {
  it("shows every PC until one is hidden, and keeps the roster's order", () => {
    expect(shownMachines(roster, []).map((pc) => pc.id)).toEqual(["local", "work", "home"]);
    expect(shownMachines(roster, ["work"]).map((pc) => pc.id)).toEqual(["local", "home"]);
    expect(shownMachines(roster, ["local", "gone"]).map((pc) => pc.id)).toEqual(["work", "home"]);
  });

  it("shows them all again when the list would leave none", () => {
    expect(shownMachines(roster, ["local", "work", "home"]).map((pc) => pc.id)).toEqual(["local", "work", "home"]);
    expect(shownMachines([], ["local"])).toEqual([]);
  });

  it("never lets the last PC shown be hidden", () => {
    expect(canHideMachine(roster, [], "work")).toBe(true);
    expect(canHideMachine(roster, ["work"], "home")).toBe(true);
    expect(canHideMachine(roster, ["work", "home"], "local")).toBe(false);
    expect(canHideMachine([{ id: "local" }], [], "local")).toBe(false);
    expect(canHideMachine(roster, ["work"], "work")).toBe(false);
  });

  it("adds and removes one PC, and drops ids of PCs no longer in the roster", () => {
    expect(withMachineHidden(roster, [], "work", true)).toEqual(["work"]);
    expect(withMachineHidden(roster, ["work"], "work", true)).toEqual(["work"]);
    expect(withMachineHidden(roster, ["work", "removed"], "home", true)).toEqual(["work", "home"]);
    expect(withMachineHidden(roster, ["work", "home"], "work", false)).toEqual(["home"]);
  });

  it("draws the switches as the sidebar does, and changes a list that hid every PC from what is drawn", () => {
    // Home, the one PC shown, was removed: Host and Work, both hidden, are drawn again
    const left = [{ id: "local" }, { id: "work" }];
    expect(isMachineShown(left, ["local", "work"], "local")).toBe(true);
    expect(isMachineShown(left, ["local", "work"], "work")).toBe(true);
    expect(isMachineShown(roster, ["work"], "work")).toBe(false);
    expect(withMachineHidden(left, ["local", "work"], "work", true)).toEqual(["work"]);
    expect(withMachineHidden(left, ["local", "work"], "local", false)).toEqual([]);
  });

  it("moves a selection off a PC just hidden, to the Host when it is shown", () => {
    expect(selectionAfterHiding(roster, ["work"], "work")).toBe("local");
    expect(selectionAfterHiding(roster, ["local"], "local")).toBe("work");
    expect(selectionAfterHiding(roster, ["work"], "home")).toBeNull();
  });
});

describe("the stored list", () => {
  it("keeps PC ids only, each once, bounded, and reads anything else as none hidden", () => {
    expect(parseHiddenMachines(JSON.stringify(["work", "work", "", 3, null, "home"]))).toEqual(["work", "home"]);
    expect(parseHiddenMachines(JSON.stringify(["x".repeat(201)]))).toEqual([]);
    expect(parseHiddenMachines(JSON.stringify(Array.from({ length: 100 }, (_, index) => `pc-${index}`)))).toHaveLength(HIDDEN_MACHINES_MAX);
    expect(parseHiddenMachines('"work"')).toEqual([]);
    expect(parseHiddenMachines("{broken")).toEqual([]);
    expect(parseHiddenMachines(null)).toEqual([]);
  });

  describe("in this browser", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    let records: Map<string, string>;
    beforeEach(() => {
      records = new Map();
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => void records.set(key, value), removeItem: (key: string) => void records.delete(key) },
        addEventListener: () => undefined, removeEventListener: () => undefined,
      } });
    });
    afterEach(() => {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    });

    it("lives in its own key, so a whole-record save of ovis:settings cannot erase it", () => {
      setHiddenMachines(["fixture-hidden-pc"]);
      expect(records.get(HIDDEN_MACHINES_KEY)).toBe('["fixture-hidden-pc"]');
      saveSettings(DEFAULT_SETTINGS);
      expect(records.get("ovis:settings")).not.toContain("fixture-hidden-pc");
      expect(readHiddenMachines()).toEqual(["fixture-hidden-pc"]);
      setHiddenMachines([]);
      expect(readHiddenMachines()).toEqual([]);
    });
  });
});

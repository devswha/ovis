import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { keepMinutes } from "./computerSettings.ts";

describe("how long the Computer view stays connected out of sight", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let records: Map<string, string>;
  beforeEach(() => {
    records = new Map();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => records.get(key) ?? null } });
  });
  afterEach(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("keeps the choice an older Computer view saved for the PC, with the rest of its saved settings ignored", () => {
    records.set("ovis:computer:pc%201", JSON.stringify({ keep: "10", quality: "low", zoom: "75" }));
    records.set("ovis:computer:other", JSON.stringify({ keep: "0" }));
    expect(keepMinutes("pc 1")).toBe(10);
    expect(keepMinutes("other")).toBe(0);
  });

  it("is 2 minutes when nothing, something corrupt or an unknown value was saved", () => {
    expect(keepMinutes("none")).toBe(2);
    records.set("ovis:computer:bad", "{not json");
    records.set("ovis:computer:odd", JSON.stringify({ keep: "7" }));
    records.set("ovis:computer:number", JSON.stringify({ keep: 5 }));
    records.set("ovis:computer:null", "null");
    records.set("ovis:computer:empty", JSON.stringify({ keep: "" }));
    records.set("ovis:computer:blank", JSON.stringify({ keep: " 5" }));
    for (const id of ["bad", "odd", "number", "null", "empty", "blank"]) expect(keepMinutes(id)).toBe(2);
  });
});

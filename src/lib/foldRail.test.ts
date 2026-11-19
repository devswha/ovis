import { describe, expect, it } from "bun:test";

import { foldDisplayOf, foldRailOf } from "./foldRail.ts";

describe("which display of the foldable iPhone the window is", () => {
  it("knows the open display in either orientation", () => {
    expect(foldDisplayOf(669, 951, 3, null)).toBe("inner");
    expect(foldDisplayOf(951, 669, 3, null)).toBe("inner");
  });

  it("knows the cover display", () => {
    expect(foldDisplayOf(466, 678, 3, null)).toBe("cover");
  });

  it("knows no other screen", () => {
    expect(foldDisplayOf(393, 852, 3, null)).toBeNull();
    expect(foldDisplayOf(820, 1180, 2, null)).toBeNull();
    expect(foldDisplayOf(1920, 1080, 1, null)).toBeNull();
  });

  it("keeps a display seen whole while the keyboard shortens the window", () => {
    expect(foldDisplayOf(669, 560, 3, "inner")).toBe("inner");
    expect(foldDisplayOf(466, 400, 3, "cover")).toBe("cover");
    expect(foldDisplayOf(669, 560, 3, null)).toBeNull();
    expect(foldDisplayOf(466, 400, 3, "inner")).toBeNull();
  });
});

describe("where the status bar's band is", () => {
  const none = { top: 0, right: 0, bottom: 0, left: 0 };

  it("is the top band in the open display's portrait", () => {
    expect(foldRailOf("inner", { ...none, top: 82, bottom: 34 })).toEqual({ side: "top", band: 82, cover: false });
  });

  it("is the side column in landscape, on whichever side the island is", () => {
    expect(foldRailOf("inner", { ...none, right: 84, bottom: 34 })).toEqual({ side: "right", band: 84, cover: false });
    expect(foldRailOf("inner", { ...none, left: 84, bottom: 34 })).toEqual({ side: "left", band: 84, cover: false });
  });

  it("puts the cover display's whole header in its column", () => {
    expect(foldRailOf("cover", { ...none, right: 84, bottom: 34 })).toEqual({ side: "right", band: 84, cover: true });
  });

  it("waits for a band wide enough to hold a button", () => {
    expect(foldRailOf("inner", none)).toBeNull();
    expect(foldRailOf("inner", { ...none, right: 20 })).toBeNull();
    expect(foldRailOf(null, { ...none, right: 84 })).toBeNull();
  });
});

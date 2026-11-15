import { describe, expect, test } from "bun:test";
import { paletteUse } from "./CommandPalette.tsx";

describe("palette rows in the usage counts", () => {
  test("the inbox row counts on the way in only, as every other way in; other rows count as their action", () => {
    expect(paletteUse("inbox-mode", false)).toBe("inbox");
    expect(paletteUse("inbox-mode", true)).toBeUndefined();
    expect([paletteUse("split-right", false), paletteUse("split-down-open", true), paletteUse("settings", true)]).toEqual(["split", "split", "settings"]);
    expect(paletteUse("find", false)).toBeUndefined();
  });
});

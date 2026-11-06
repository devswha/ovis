import { describe, expect, it } from "bun:test";
import { typeAheadKey } from "./typeAhead.ts";

const key = (name: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  typeAheadKey({ key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("typeAheadKey", () => {
  it("sends the keys a shell line needs as a terminal does", () => {
    expect(key("Enter")).toEqual({ input: "\r" });
    expect(key("Enter", { shiftKey: true })).toEqual({ input: "\x1b\r" });
    expect(key("Tab")).toEqual({ input: "\t" });
    expect(key("Backspace")).toEqual({ input: "\x7f" });
    expect(key("Escape")).toEqual({ input: "\x1b" });
    expect(key("ArrowLeft")).toEqual({ input: "\x1b[D", arrow: "ArrowLeft" });
    expect(key("c", { ctrlKey: true })).toEqual({ input: "\x03" });
    expect(key("U", { ctrlKey: true })).toEqual({ input: "\x15" });
  });

  it("leaves text, the browser's paste and its shortcuts to the browser", () => {
    expect(key("a")).toBeNull();
    expect(key("v", { ctrlKey: true })).toBeNull();
    expect(key("t", { metaKey: true })).toBeNull();
    expect(key("ArrowLeft", { altKey: true })).toBeNull();
    expect(key("Tab", { shiftKey: true })).toBeNull();
    expect(key("K", { ctrlKey: true, shiftKey: true })).toBeNull();
  });
});

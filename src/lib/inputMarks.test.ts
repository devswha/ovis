import { describe, expect, it } from "bun:test";
import { fromKeyStroke, inputMarks, type KeyStroke } from "./inputMarks.ts";

const stroke = (key: string, fields: Partial<KeyStroke> = {}): KeyStroke =>
  ({ key, keyCode: 0, isComposing: false, ctrlKey: false, altKey: false, metaKey: false, ...fields });

describe("fromKeyStroke", () => {
  it("takes only what the key itself types: its character, or a named key's or a chord's control sequence", () => {
    expect(fromKeyStroke(stroke("a"), "a")).toBe(true);
    expect(fromKeyStroke(stroke("Enter"), "\r")).toBe(true);
    expect(fromKeyStroke(stroke("ArrowLeft"), "\x1b[D")).toBe(true);
    expect(fromKeyStroke(stroke("c", { ctrlKey: true }), "\x03")).toBe(true);
    // text the field lets out inside another key's stroke, a 229 or composing key, a paste: not the key's own
    expect(fromKeyStroke(stroke("Enter"), "dictation")).toBe(false);
    expect(fromKeyStroke(stroke("a"), "\u00e9x")).toBe(false);
    expect(fromKeyStroke(stroke("Unidentified", { keyCode: 229 }), "\u00e9")).toBe(false);
    expect(fromKeyStroke(stroke("a", { isComposing: true }), "a")).toBe(false);
    expect(fromKeyStroke(stroke("v", { ctrlKey: true }), "\x1b[200~a\x1b[201~")).toBe(false);
    expect(fromKeyStroke(null, "a")).toBe(false);
  });
});

describe("inputMarks", () => {
  it("marks a key stroke's own input now, and other text when the field was last seen empty", () => {
    let tick = 0;
    const field = { value: "" };
    const marks = inputMarks(() => field.value === "", () => ++tick);
    const opened = tick;
    field.value = "dictation";
    marks.keyDown(stroke("Enter"));
    expect(marks.take("dictation", false)).toBe(opened);
    field.value = "";
    expect(marks.take("\r", false)).toBeGreaterThan(opened);
    marks.keyEnd();
    // a paste is never a key stroke's own
    marks.keyDown(stroke("v", { ctrlKey: true }));
    const before = tick;
    expect(marks.take("\x03", true)).toBeLessThanOrEqual(before);
  });

  it("dates text an empty field begins to take to that moment, so a link that came up before it does not hold it", () => {
    let tick = 0;
    const field = { value: "" };
    const marks = inputMarks(() => field.value === "", () => ++tick);
    const linkUp = ++tick;
    marks.observe();
    field.value = "한";
    expect(marks.take("한", false)).toBeGreaterThan(linkUp);
  });
});

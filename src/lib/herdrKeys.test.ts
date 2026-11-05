import { describe, expect, it } from "bun:test";
import { HERDR_DEFAULT_PREFIX, HERDR_PREFIX_DEFAULTS, type HerdrKeys } from "../../shared/herdr-keys.ts";
import { chordMatches, compileHerdrKeys, herdrKeyStep, parseHerdrBinding, type HerdrKeyMap } from "./herdrKeys.ts";
import type { ShortcutEventLike } from "./shortcuts.ts";

function key(key: string, code: string, modifiers: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return { key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers };
}
const ctrlB = key("b", "KeyB", { ctrlKey: true });
const defaults: HerdrKeys = { prefix: HERDR_DEFAULT_PREFIX, bindings: { ...HERDR_PREFIX_DEFAULTS } };
const map = compileHerdrKeys(defaults) as HerdrKeyMap;

describe("herdr's binding syntax", () => {
  it("reads the prefix, modifiers, named keys and the 1..9 range as herdr's config writes them", () => {
    expect(parseHerdrBinding("ctrl+b")).toEqual({ prefixed: false, chord: { ctrl: true, alt: false, shift: false, meta: false, key: "b" }, indexed: false });
    expect(parseHerdrBinding("prefix+shift+n")?.chord).toMatchObject({ shift: true, key: "n" });
    expect(parseHerdrBinding("prefix+minus")?.chord.key).toBe("-");
    expect(parseHerdrBinding("prefix+?")?.chord.key).toBe("?");
    expect(parseHerdrBinding("cmd+shift+tab")?.chord).toMatchObject({ meta: true, shift: true, key: "Tab" });
    expect(parseHerdrBinding("f12")?.chord.key).toBe("F12");
    expect(parseHerdrBinding("prefix+1..9")).toMatchObject({ prefixed: true, indexed: true });
  });

  it("reads nothing it cannot read as herdr does: unknown names, repeated modifiers, an uppercase letter, empty parts", () => {
    for (const text of ["", "prefix+", "ctrl+ctrl+b", "hyper+b", "prefix+N", "prefix+pagedown", "ctrl++"]) expect(parseHerdrBinding(text)).toBeNull();
  });
});

describe("matching a keydown", () => {
  it("reads a letter by its key's position on a non-Latin layout, and Shift exactly", () => {
    const chord = parseHerdrBinding("prefix+shift+n")!.chord;
    expect(chordMatches(chord, key("N", "KeyN", { shiftKey: true }))).toBe(true);
    expect(chordMatches(chord, key("ㅜ", "KeyN", { shiftKey: true }))).toBe(true);
    expect(chordMatches(chord, key("n", "KeyN"))).toBe(false);
    expect(chordMatches(parseHerdrBinding("ctrl+b")!.chord, key("b", "KeyB", { ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("reads punctuation by the character typed, whatever Shift it took", () => {
    expect(chordMatches(parseHerdrBinding("prefix+?")!.chord, key("?", "Slash", { shiftKey: true }))).toBe(true);
    expect(chordMatches(parseHerdrBinding("prefix+minus")!.chord, key("-", "Minus"))).toBe(true);
  });
});

describe("the prefix's steps", () => {
  it("arms on the prefix, and runs the bound key's action once armed", () => {
    expect(herdrKeyStep(map, false, ctrlB)).toEqual({ kind: "arm" });
    expect(herdrKeyStep(map, true, key("c", "KeyC"))).toEqual({ kind: "run", action: "new_tab", index: null });
    expect(herdrKeyStep(map, true, key("-", "Minus"))).toEqual({ kind: "run", action: "split_horizontal", index: null });
    expect(herdrKeyStep(map, true, key("3", "Digit3"))).toEqual({ kind: "run", action: "switch_tab", index: 3 });
    expect(herdrKeyStep(map, true, key("N", "KeyN", { shiftKey: true }))).toEqual({ kind: "run", action: "new_workspace", index: null });
  });

  it("leaves every other key to the pane: unarmed keys, an unbound key or the prefix again once armed, IME composition", () => {
    expect(herdrKeyStep(map, false, key("c", "KeyC"))).toEqual({ kind: "pass" });
    expect(herdrKeyStep(map, true, key("y", "KeyY"))).toEqual({ kind: "pass" });
    expect(herdrKeyStep(map, true, ctrlB)).toEqual({ kind: "pass" });
    expect(herdrKeyStep(map, true, { ...key("Process", "KeyC"), keyCode: 229 })).toEqual({ kind: "pass" });
    expect(herdrKeyStep(map, false, { ...ctrlB, isComposing: true })).toEqual({ kind: "pass" });
  });

  it("waits through a modifier pressed on its way to the key, and leaves on Escape", () => {
    expect(herdrKeyStep(map, true, key("Shift", "ShiftLeft", { shiftKey: true }))).toEqual({ kind: "ignore" });
    expect(herdrKeyStep(map, true, key("Escape", "Escape"))).toEqual({ kind: "escape" });
  });

  it("follows the config: another prefix, a rebound or unbound action", () => {
    const own = compileHerdrKeys({ prefix: "ctrl+a", bindings: { ...HERDR_PREFIX_DEFAULTS, new_tab: "prefix+t", zoom: "" } })!;
    expect(herdrKeyStep(own, false, ctrlB)).toEqual({ kind: "pass" });
    expect(herdrKeyStep(own, false, key("a", "KeyA", { ctrlKey: true }))).toEqual({ kind: "arm" });
    expect(herdrKeyStep(own, true, key("t", "KeyT"))).toEqual({ kind: "run", action: "new_tab", index: null });
    expect(herdrKeyStep(own, true, key("z", "KeyZ"))).toEqual({ kind: "pass" });
  });

  it("takes no prefix it cannot read, nor one with no prefix binding behind it", () => {
    expect(compileHerdrKeys({ ...defaults, prefix: "" })).toBeNull();
    expect(compileHerdrKeys({ ...defaults, prefix: "prefix+b" })).toBeNull();
    const direct = Object.fromEntries(Object.keys(HERDR_PREFIX_DEFAULTS).map((action) => [action, "ctrl+alt+n"])) as HerdrKeys["bindings"];
    expect(compileHerdrKeys({ prefix: "ctrl+b", bindings: direct })).toBeNull();
  });
});

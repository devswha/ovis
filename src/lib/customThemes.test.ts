import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  bootRows, chosenTheme, customRow, customRowId, drawnTheme, MAX_CUSTOM_THEMES, MAX_THEME_FILE_BYTES, MAX_THEME_NAME, NO_CUSTOM_THEMES,
  readThemeFile, sanitizeCustomThemes, withoutTheme, withTheme, type CustomTheme, type CustomThemes,
} from "./customThemes.ts";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.ts";
import { BASE16_KEYS } from "./themeDerive.ts";
import { THEME_VARS } from "./themeBoot.ts";
import { rowFor } from "./themes.ts";

const GUIDE = readFileSync(new URL("../../docs/themes.md", import.meta.url), "utf8");
/** The example file docs/themes.md shows: what the page promises is what the reader takes. */
const EXAMPLE = /```json\n([\s\S]*?)```/.exec(GUIDE)![1]!;

const theme = (text: string, name?: string): CustomTheme => {
  const result = readThemeFile(text, name);
  if ("error" in result) throw new Error(`refused: ${result.error}`);
  return result.theme;
};

const SCHEME = `system: "base16"
name: "Harbor Night"
author: "someone (https://example.com)"
variant: "dark"
# a comment line
palette:
  base00: "#1B2B34"  # Default Background
  base01: "#343D46"
  base02: "#4F5B66"
  base03: "#65737E"
  base04: "#A7ADBA"
  base05: "#C0C5CE"
  base06: "#CDD3DE"
  base07: "#D8DEE9"
  base08: "#EC5f67"
  base09: "#F99157"
  base0A: "#FAC863"
  base0B: "#99C794"
  base0C: "#5FB3B3"
  base0D: "#6699CC"
  base0E: "#C594C5"
  base0F: "#AB7967"
`;

describe("readThemeFile", () => {
  test("reads the example of docs/themes.md: a name and both sides, sixteen colours each", () => {
    const read = theme(EXAMPLE);
    expect(read.name).toBe("Lamplight");
    for (const side of ["dark", "light"] as const) {
      expect(Object.keys(read[side]!)).toEqual([...BASE16_KEYS]);
      expect(Object.values(read[side]!).every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
    }
    expect(read.dark!.base00).toBe("#181613");
    expect(read.light!.base05).toBe("#2a251f");
    expect(read.id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("reads a Base16 scheme as published: YAML with a palette, comments and upper-case hex", () => {
    const read = theme(SCHEME, "file-name");
    expect(read).toMatchObject({ name: "Harbor Night", dark: { base00: "#1b2b34", base08: "#ec5f67", base0F: "#ab7967" } });
    expect(read.light).toBeUndefined();
  });

  test("reads the older flat scheme, a JSON scheme and a side told only by its colours", () => {
    const flat = theme(`scheme: "Paper"\nauthor: "x"\nbase00: "f8f8f8"\nbase05: "383838"\nbase0D: '7cafc2'\n`);
    expect(flat.name).toBe("Paper");
    // a ground lighter than the text is a light theme
    expect(flat.light).toMatchObject({ base00: "#f8f8f8", base05: "#383838", base0D: "#7cafc2" });
    expect(flat.dark).toBeUndefined();
    const json = theme(JSON.stringify({ name: "J", variant: "light", palette: { base00: "#101010", base05: "#e0e0e0" } }));
    // the scheme's own word wins over the look of its colours
    expect(json.light?.base00).toBe("#101010");
    expect(theme(JSON.stringify({ BASE00: "#101010", Base05: "E0E0E0" }), "from-file").dark).toMatchObject({ base00: "#101010", base05: "#e0e0e0" });
    expect(theme(JSON.stringify({ base00: "#101010", base05: "#e0e0e0" }), "from-file").name).toBe("from-file");
  });

  test("fills what a file leaves out: greys step from the ground to the text, a missing hue is the text", () => {
    const read = theme(JSON.stringify({ name: "Two", dark: { base00: "#000000", base05: "#ffffff", extra: "#123456", base0B: "not a colour" } }));
    expect(read.dark).toMatchObject({ base00: "#000000", base05: "#ffffff", base06: "#ffffff", base08: "#ffffff", base0B: "#ffffff", base0D: "#ffffff" });
    const grey = (key: "base01" | "base02" | "base03" | "base04"): number => parseInt(read.dark![key].slice(1, 3), 16);
    expect(grey("base01")).toBeGreaterThan(0);
    expect(grey("base02")).toBeGreaterThan(grey("base01"));
    expect(grey("base03")).toBeGreaterThan(grey("base02"));
    expect(grey("base04")).toBeGreaterThan(grey("base03"));
    expect(Object.keys(read.dark!)).toEqual([...BASE16_KEYS]);
  });

  test("refuses what is no theme, and says which way", () => {
    expect(readThemeFile("x".repeat(MAX_THEME_FILE_BYTES + 1))).toEqual({ error: "too-large" });
    for (const text of ["", "hello", "42", "null", "[]", "{}", '{"name":"x"}', "name: only\n", "<html>"]) expect(readThemeFile(text), text).toEqual({ error: "not-a-theme" });
    // colours, but no ground or no text to draw on
    expect(readThemeFile('{"base08":"#ff0000"}')).toEqual({ error: "no-colors" });
    expect(readThemeFile('{"dark":{"base00":"#000000"}}')).toEqual({ error: "no-colors" });
    expect(readThemeFile('{"dark":{},"light":"x"}')).toEqual({ error: "no-colors" });
  });

  test("keeps only colours and a short one-line name, whatever else the file carries", () => {
    const read = theme(JSON.stringify({
      name: `  Evil\n\u0007name\u2028 ${"x".repeat(80)}`, script: "alert(1)", css: "body{display:none}",
      dark: { base00: "#000000", base05: "#ffffff", base08: "url(https://example.com/x)", base09: "red; background: url(x)", base0A: "#12345", base0B: "#1234567" },
    }));
    expect(read.name.length).toBeLessThanOrEqual(MAX_THEME_NAME);
    expect(read.name).not.toMatch(/[\n\u0007\u2028]/);
    expect(read.name.startsWith("Evil name")).toBe(true);
    // a mark that would draw the rest of the line backwards is dropped, in a file and in a stored list
    expect(theme(JSON.stringify({ name: "ab\u202ecd\u2066ef\u200f", base00: "#000000", base05: "#ffffff" })).name).toBe("abcdef");
    expect(sanitizeCustomThemes({ themes: [{ ...read, name: "x\u202ey" }], dark: null, light: null }).themes[0]!.name).toBe("xy");
    expect(Object.keys(read)).toEqual(["id", "name", "dark"]);
    expect(Object.values(read.dark!).every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
  });

  test("the same file is the same theme, and a changed colour or name another", () => {
    expect(theme(EXAMPLE).id).toBe(theme(`${EXAMPLE}\n`).id);
    expect(theme(EXAMPLE.replace("#181613", "#181614")).id).not.toBe(theme(EXAMPLE).id);
    expect(theme(EXAMPLE.replace("Lamplight", "Lamplight 2")).id).not.toBe(theme(EXAMPLE).id);
  });
});

describe("the kept list", () => {
  const first = theme(EXAMPLE);
  const second = theme(SCHEME);

  test("adds, chooses and removes", () => {
    const one = withTheme(NO_CUSTOM_THEMES, first, "dark")!;
    expect(one).toEqual({ themes: [first], dark: first.id, light: null });
    // the same theme again is held once
    expect(withTheme(one, first, "light")).toEqual({ themes: [first], dark: first.id, light: first.id });
    const two = withTheme(one, second, "light")!;
    expect(chosenTheme(two, "dark")).toBe(first);
    expect(chosenTheme(two, "light")).toBe(second);
    expect(withoutTheme(two, first.id)).toEqual({ themes: [second], dark: null, light: second.id });
    expect(withoutTheme(withoutTheme(two, first.id), second.id)).toBe(NO_CUSTOM_THEMES);
    expect(NO_CUSTOM_THEMES).toEqual({ themes: [], dark: null, light: null });
  });

  test("holds at most MAX_CUSTOM_THEMES", () => {
    let list: CustomThemes = NO_CUSTOM_THEMES;
    for (let at = 0; at < MAX_CUSTOM_THEMES; at++) list = withTheme(list, theme(EXAMPLE.replace("Lamplight", `Theme ${at}`)), "dark")!;
    expect(list.themes).toHaveLength(MAX_CUSTOM_THEMES);
    expect(withTheme(list, theme(EXAMPLE.replace("Lamplight", "One more")), "dark")).toBeNull();
    // one already held can still be chosen
    expect(withTheme(list, list.themes[0]!, "light")?.light).toBe(list.themes[0]!.id);
  });

  test("a stored list keeps only what a file could have made", () => {
    const stored = { themes: [first, second], dark: first.id, light: second.id };
    expect(sanitizeCustomThemes(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    // byte for byte: the shared document's copy is told from one this build cannot read by that (lib/preferencesSync.ts)
    for (const list of [stored, withTheme(NO_CUSTOM_THEMES, first, "light")!, withoutTheme(stored, first.id), NO_CUSTOM_THEMES]) {
      expect(JSON.stringify(sanitizeCustomThemes(JSON.parse(JSON.stringify(list))))).toBe(JSON.stringify(list));
      expect(JSON.stringify(sanitizeSettings({ customThemes: list }).customThemes)).toBe(JSON.stringify(list));
    }
    // a block stored in another order is the same theme, in the app's own order
    const shuffled = { themes: [{ ...second, dark: Object.fromEntries(Object.entries(second.dark!).reverse()) }], dark: null, light: null };
    expect(JSON.stringify(sanitizeCustomThemes(shuffled))).toBe(JSON.stringify({ themes: [second], dark: null, light: null }));
    for (const raw of [undefined, null, 7, "x", [], {}, { themes: "x" }, { themes: [] }]) expect(sanitizeCustomThemes(raw), JSON.stringify(raw)).toBe(NO_CUSTOM_THEMES);
    const damaged = sanitizeCustomThemes({
      themes: [
        first, first, { ...second, id: "not-an-id" }, { ...second, name: "\n" }, { id: "0123abcd", name: "No sides" },
        { id: "89abcdef", name: "Half", dark: { ...second.dark, base00: "url(x)" } }, { id: "00000001", name: "Kept <b>", dark: second.dark, light: { base00: "#ffffff" }, onload: "x" }, 7, null,
      ],
      dark: "ffffffff", light: "00000001", extra: true,
    });
    expect(damaged).toEqual({ themes: [first, { id: "00000001", name: "Kept <b>", dark: second.dark! }], dark: null, light: "00000001" });
    const many = { themes: Array.from({ length: MAX_CUSTOM_THEMES + 5 }, (_, at) => ({ ...second, id: at.toString(16).padStart(8, "0") })), dark: null, light: null };
    expect(sanitizeCustomThemes(many).themes).toHaveLength(MAX_CUSTOM_THEMES);
  });

  test("settings keep the list, and a record without one has none", () => {
    const custom = withTheme(NO_CUSTOM_THEMES, first, "dark")!;
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, customThemes: custom }).customThemes).toEqual(custom);
    expect(sanitizeSettings({}).customThemes).toBe(NO_CUSTOM_THEMES);
    expect(DEFAULT_SETTINGS.customThemes).toBe(NO_CUSTOM_THEMES);
  });
});

describe("the row an imported theme draws", () => {
  const both = theme(EXAMPLE);
  const dark = theme(SCHEME);

  test("carries every colour the document, the terminal and the theme card need", () => {
    for (const side of ["dark", "light"] as const) {
      const row = customRow(both, side);
      expect(row).toMatchObject({ id: customRowId(both.id), mode: side, bg: both[side]!.base00, bgPanel: both[side]!.base00 });
      expect(Object.keys(row.vars!).every((name) => THEME_VARS.includes(name))).toBe(true);
      expect(row.terminal).toMatchObject({ background: both[side]!.base00, foreground: both[side]!.base05, cursor: both[side]!.base05 });
      // xterm's own ANSI colours on a dark ground; a light row names all sixteen
      expect(Object.keys(row.terminal)).toHaveLength(side === "dark" ? 4 : 20);
      expect(Object.values(row.preview).every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
    }
    // derived once
    expect(customRow(both, "dark")).toBe(customRow(both, "dark"));
  });

  test("a theme with one side draws that side wherever it is chosen", () => {
    expect(customRow(dark, "light").mode).toBe("dark");
    expect(customRow(dark, "light")).toBe(customRow(dark, "dark"));
  });

  test("a side draws its imported theme, else its built-in one", () => {
    const settings = { darkTheme: "nord", lightTheme: "one-light", customThemes: withTheme(NO_CUSTOM_THEMES, both, "dark")! } as const;
    expect(drawnTheme(settings, "dark")).toBe(customRow(both, "dark"));
    expect(drawnTheme(settings, "light")).toBe(rowFor("one-light", "light"));
    // a choice whose theme is gone falls back to the built-in theme under it
    expect(drawnTheme({ ...settings, customThemes: { themes: [], dark: both.id, light: null } }, "dark")).toBe(rowFor("nord", "dark"));
    expect(bootRows(settings.customThemes)).toEqual({ dark: customRow(both, "dark") });
    expect(bootRows(NO_CUSTOM_THEMES)).toEqual({});
  });
});

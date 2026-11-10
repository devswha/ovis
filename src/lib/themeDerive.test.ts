import { describe, expect, test } from "bun:test";
import { contrast } from "./colorMath.ts";
import { parseThemeValue } from "./themeCss.ts";
import { CONTRAST_PAIRS, LIGHT_ANSI_PAIRS } from "./themeContrast.ts";
import { BASE16_KEYS, deriveTheme, fit, type Base16 } from "./themeDerive.ts";
import { LIGHT_ANSI_ROLES, ROLES } from "./themeRoles.ts";
import type { Mode } from "./themes.ts";

const MODES: readonly Mode[] = ["dark", "light"];

/** The pairs of themeContrast.ts a derived theme is under, the way themes.contrast.test.ts reads a built-in one. */
function below(roles: Record<string, string>, mode: Mode): string[] {
  return [...CONTRAST_PAIRS, ...(mode === "light" ? LIGHT_ANSI_PAIRS : [])].flatMap(({ fg, bg, floor }) => {
    const ratio = contrast(roles[fg]!, roles[bg]!);
    return ratio < floor ? [`${fg} on ${bg}: ${ratio.toFixed(2)}:1 < ${floor}:1 (${roles[fg]} / ${roles[bg]})`] : [];
  });
}

/** A seeded generator, so a failing palette can be found again. */
function palettes(count: number, seed: number): Base16[] {
  let state = seed;
  const next = (): number => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const color = (): string => `#${[0, 0, 0].map(() => Math.floor(next() * 256).toString(16).padStart(2, "0")).join("")}`;
  return Array.from({ length: count }, () => Object.fromEntries(BASE16_KEYS.map((key) => [key, color()])) as unknown as Base16);
}

const seeds = (colors: Partial<Base16>, rest = "#808080"): Base16 => Object.fromEntries(BASE16_KEYS.map((key) => [key, colors[key] ?? rest])) as unknown as Base16;

// a readable dark scheme and a readable light one, in the app's own amber colours
const DARK = seeds({
  base00: "#181613", base01: "#211e1a", base02: "#2a2621", base03: "#3e3830", base04: "#9b9183", base05: "#d8d0c3", base06: "#f2ebdf", base07: "#fff8ec",
  base08: "#ff7b70", base09: "#f0a830", base0A: "#e8c55c", base0B: "#93c36b", base0C: "#6cc5b0", base0D: "#6cb8d6", base0E: "#c39bd3", base0F: "#b07a4a",
});
const LIGHT = seeds({
  base00: "#faf8f3", base01: "#f2eee6", base02: "#e6dfd2", base03: "#b5ab9b", base04: "#685e52", base05: "#2a251f", base06: "#16120d", base07: "#000000",
  base08: "#a82323", base09: "#8c5000", base0A: "#7a5a00", base0B: "#2f6317", base0C: "#0f6b6f", base0D: "#155a72", base0E: "#8a3f7a", base0F: "#6b4a2a",
});

describe("deriveTheme", () => {
  test("any sixteen colours come out meeting every floor the built-in themes are held to", () => {
    const failures: string[] = [];
    for (const [index, palette] of palettes(200, 12345).entries()) {
      for (const mode of MODES) {
        const under = below(deriveTheme(palette, mode), mode);
        if (under.length > 0) failures.push(`palette ${index} ${mode}: ${under.join("; ")} ${JSON.stringify(palette)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("the hardest grounds still read: one colour for all sixteen, a mid grey, black and white", () => {
    for (const all of ["#808080", "#777777", "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#767676", "#959595"]) {
      for (const mode of MODES) expect(below(deriveTheme(seeds({}, all), mode), mode), `${all} ${mode}`).toEqual([]);
    }
    // a light surface under light text, and the other way round
    for (const mode of MODES) {
      expect(below(deriveTheme(seeds({ base00: "#000000", base01: "#ffffff", base02: "#ffffff", base05: "#757575" }), mode), mode)).toEqual([]);
      expect(below(deriveTheme(seeds({ base00: "#ffffff", base01: "#000000", base02: "#000000", base05: "#757575" }), mode), mode)).toEqual([]);
    }
  });

  test("a scheme that already reads is drawn in its own colours", () => {
    const dark = deriveTheme(DARK, "dark");
    expect(dark).toMatchObject({
      bg: DARK.base00, "bg-panel": DARK.base00, "bg-elevated": DARK.base01, "bg-input": DARK.base01, "bg-hover": DARK.base02,
      border: DARK.base02, "border-strong": DARK.base03, text: DARK.base05, "text-strong": DARK.base05, "text-dim": DARK.base04,
      accent: DARK.base0D, primary: DARK.base0D, notice: DARK.base0A,
      "status-working": DARK.base0D, "status-blocked": DARK.base08, "status-done": DARK.base0B,
      "syntax-keyword": DARK.base0E, "syntax-string": DARK.base0B, "syntax-number": DARK.base09, "syntax-type": DARK.base0A, "syntax-meta": DARK.base0C, "syntax-function": DARK.base0D,
      "term-bg": DARK.base00, "term-fg": DARK.base05, "term-cursor": DARK.base05, "term-selection": DARK.base02,
    });
    const light = deriveTheme(LIGHT, "light");
    expect(light).toMatchObject({ bg: LIGHT.base00, text: LIGHT.base05, "text-dim": LIGHT.base04, "bg-elevated": LIGHT.base01, "status-blocked": LIGHT.base08, "syntax-keyword": LIGHT.base0E });
    expect(below(dark, "dark")).toEqual([]);
    expect(below(light, "light")).toEqual([]);
  });

  test("names every role with a value the theme language reads, and a light theme's ANSI colours", () => {
    for (const mode of MODES) {
      const roles = deriveTheme(mode === "dark" ? DARK : LIGHT, mode) as Record<string, string>;
      const expected = [...Object.keys(ROLES), "notice-tint", ...(mode === "light" ? Object.values(LIGHT_ANSI_ROLES) : [])];
      expect(Object.keys(roles).sort()).toEqual([...expected].sort());
      for (const [role, value] of Object.entries(roles)) {
        const kind = (ROLES as Record<string, string>)[role] ?? "color";
        const parsed = parseThemeValue(`derived/${mode}`, role, value);
        expect(parsed.kind === kind || parsed.kind === "alias", `${role}: ${value}`).toBe(true);
      }
    }
  });

  test("a surface the text cannot be read on gives way, and the text keeps its colour", () => {
    // Base16 Solarized Dark: base02 is a mid tone the text does not read on
    const roles = deriveTheme(seeds({ base00: "#002b36", base01: "#073642", base02: "#586e75", base05: "#93a1a1" }), "dark");
    expect(roles.text).toBe("#93a1a1");
    expect(roles["bg-hover"]).not.toBe("#586e75");
    expect(contrast(roles.text, roles["bg-hover"])).toBeGreaterThanOrEqual(4.5);
    // the border is no surface: it keeps the scheme's colour
    expect(roles.border).toBe("#586e75");
  });

  test("the text takes a small step to keep the scheme's surfaces, as the built-in themes were repaired", () => {
    // Base16 Solarized Light: the text is just under 4.5:1 on the raised surface
    const roles = deriveTheme(seeds({ base00: "#fdf6e3", base01: "#eee8d5", base02: "#93a1a1", base05: "#586e75" }), "light");
    expect(roles["bg-elevated"]).toBe("#eee8d5");
    expect(roles.text).not.toBe("#586e75");
    expect(contrast(roles.text, "#eee8d5")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(roles.text, "#586e75")).toBeLessThan(1.15);
    // the mid tone it could only be read on as near-black gives way instead
    expect(roles["bg-hover"]).not.toBe("#93a1a1");
  });

  test("a colour under its floor keeps its hue and moves the least it can", () => {
    const moved = fit("#bf616a", [{ color: "#2e3440", floor: 4.5 }]);
    expect(contrast(moved, "#2e3440")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(moved, "#2e3440")).toBeLessThan(4.9);
    // still a red: its red channel leads as before
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(moved.slice(at, at + 2), 16));
    expect(r!).toBeGreaterThan(g!);
    expect(r!).toBeGreaterThan(b!);
    // a colour that reads is returned as it is
    expect(fit("#eceff4", [{ color: "#2e3440", floor: 4.5 }])).toBe("#eceff4");
  });

  test("is the same for the same seeds", () => {
    expect(deriveTheme(DARK, "dark")).toEqual(deriveTheme({ ...DARK }, "dark"));
  });
});

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { hex, over, rgb } from "./colorMath.ts";
import { contrastRatio } from "./terminalFold.ts";
import { parseThemeBlocks, resolveEntry } from "./themeCss.ts";
import { CONTRAST_PAIRS, LIGHT_ANSI_PAIRS, TEXT_FLOOR } from "./themeContrast.ts";
import { SUPPORTED_ENTRIES } from "./themes.ts";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const blocks = parseThemeBlocks(css);

function mixRule(role: string): { weight: number; base: string } {
  const match = new RegExp(String.raw`--${role}:\s*color-mix\(in srgb,\s*var\(--accent\)\s*(\d+(?:\.\d+)?)%,\s*var\((--[\w-]+)\)\)`).exec(css);
  if (!match?.[1] || !match[2]) throw new Error(`Missing color-mix formula for --${role} in styles.css`);
  return { weight: Number(match[1]) / 100, base: match[2] };
}

describe("theme contrast", () => {
  it("checks every supported theme entry", () => {
    expect(SUPPORTED_ENTRIES.length).toBeGreaterThan(0);
  });

  for (const entry of SUPPORTED_ENTRIES) {
    it(`${entry.id}/${entry.mode} meets the WCAG AA floors`, () => {
      const colors = resolveEntry(blocks, entry.id, entry.mode).resolved;
      const below = [...CONTRAST_PAIRS, ...(entry.mode === "light" ? LIGHT_ANSI_PAIRS : [])].flatMap(({ fg, bg, floor }) => {
        const ratio = contrastRatio(colors[`--${fg}`] ?? "", colors[`--${bg}`] ?? "");
        if (ratio === null) return [`${fg} on ${bg}: ${colors[`--${fg}`]} / ${colors[`--${bg}`]} is not #rrggbb`];
        return ratio < floor ? [`${fg} on ${bg}: ${ratio.toFixed(2)}:1 < ${floor}:1 (${colors[`--${fg}`]} / ${colors[`--${bg}`]})`] : [];
      });
      expect(below).toEqual([]);
    });

    it(`${entry.id}/${entry.mode} keeps the user chat bubble readable and separated from the canvas`, () => {
      const colors = resolveEntry(blocks, entry.id, entry.mode).resolved;
      const bubbleBgRule = mixRule("bubble-bg");
      const bubbleEdgeRule = mixRule("bubble-edge");
      const accent = colors["--accent"] ?? "";
      const bg = colors["--bg"] ?? "";
      const bubbleBg = hex(over(rgb(accent), rgb(colors[bubbleBgRule.base] ?? ""), bubbleBgRule.weight));
      const bubbleEdge = hex(over(rgb(accent), rgb(colors[bubbleEdgeRule.base] ?? ""), bubbleEdgeRule.weight));

      for (const role of ["--text-strong", "--text", "--text-dim"] as const) {
        const fg = colors[role] ?? "";
        const ratio = contrastRatio(fg, bubbleBg);
        expect(ratio, `${role} (${fg}) on --bubble-bg (${bubbleBg})`).not.toBeNull();
        expect(ratio!, `${role} (${fg}) on --bubble-bg (${bubbleBg})`).toBeGreaterThanOrEqual(TEXT_FLOOR);
      }

      const bgDiff = contrastRatio(bubbleBg, bg);
      expect(bgDiff, `--bubble-bg (${bubbleBg}) vs --bg (${bg})`).not.toBeNull();
      expect(bgDiff!, `--bubble-bg (${bubbleBg}) vs --bg (${bg})`).toBeGreaterThanOrEqual(1.08);

      const edgeDiff = contrastRatio(bubbleEdge, bg);
      expect(edgeDiff, `--bubble-edge (${bubbleEdge}) vs --bg (${bg})`).not.toBeNull();
      expect(edgeDiff!, `--bubble-edge (${bubbleEdge}) vs --bg (${bg})`).toBeGreaterThanOrEqual(1.5);
    });

    it(`${entry.id}/${entry.mode} keeps every chat Markdown style preset readable (WCAG AA)`, () => {
      const colors = resolveEntry(blocks, entry.id, entry.mode).resolved;
      const mix = (fg: string, bg: string, weight: number) => hex(over(rgb(fg), rgb(bg), weight));
      const bg = colors["--bg"]!;
      const elev = colors["--bg-elevated"]!;
      const strong = colors["--text-strong"]!;
      const dim = colors["--text-dim"]!;
      const accent = colors["--accent"]!;
      const fn = colors["--syntax-function"]!;
      const ty = colors["--syntax-type"]!;
      const kw = colors["--syntax-keyword"]!;
      const meta = colors["--syntax-meta"]!;
      const variable = colors["--syntax-variable"]!;
      const checks: readonly [string, string, string][] = [
        ["editorial code", mix(fn, strong, 0.26), mix(accent, bg, 0.07)],
        ["editorial blockquote", dim, mix(accent, bg, 0.04)],
        ["editorial table header", strong, mix(elev, bg, 0.75)],
        ["tinted heading", mix(fn, strong, 0.42), bg],
        ["tinted subheading", mix(ty, strong, 0.38), bg],
        ["tinted code", mix(kw, strong, 0.38), mix(kw, bg, 0.06)],
        ["tinted blockquote", dim, mix(ty, bg, 0.04)],
        ["tinted table header", mix(ty, strong, 0.38), mix(elev, bg, 0.75)],
        ["colorful heading", mix(fn, strong, 0.7), bg],
        ["colorful subheading", mix(ty, strong, 0.7), bg],
        ["colorful detail", mix(meta, strong, 0.7), bg],
        ["colorful strong", mix(variable, strong, 0.7), bg],
        ["colorful emphasis", mix(meta, strong, 0.7), bg],
        ["colorful code", mix(kw, strong, 0.7), elev],
        ["colorful table header", mix(ty, strong, 0.7), elev],
      ];
      const below = checks.flatMap(([name, fg, surface]) => {
        const ratio = contrastRatio(fg, surface);
        return ratio === null || ratio < TEXT_FLOOR ? [`${name}: ${ratio?.toFixed(2) ?? "invalid"}:1 (${fg} on ${surface})`] : [];
      });
      expect(below).toEqual([]);
    });
  }
});

/**
 * Settings → Appearance → Typography: the interface font and size, as the values lib/settings.ts
 * writes on `<html>` (`--font-ui`, `--ui-scale` and the chat's `--chat-scale`). A chosen family goes
 * in front of the built-in stack, never in place of it, as the terminal's and the chat's do
 * (lib/fontFamily.ts): a font this device does not have falls back as if none had been chosen.
 * The terminal and code keep their own stacks.
 */

import { sanitizeFontFamily } from "./fontFamily.ts";

/**
 * The built-in interface stack: `--font-ui` in src/styles.css, verbatim (typography.test.ts holds
 * the two equal). A copy, because a chosen font is written as `--font-ui` itself, and a token
 * cannot fall back to its own stylesheet value.
 */
export const UI_FONT_STACK = '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", "Malgun Gothic", sans-serif';

export const UI_FONT_PRESETS = ["default", "system", "noto"] as const;
export type UiFontPreset = (typeof UI_FONT_PRESETS)[number];

/**
 * What each preset stores as `uiFontFamily`, already in the form sanitizeFontFamily keeps.
 * `system`: the device's own interface font (San Francisco with Hiragino on a Mac, Segoe UI with
 * Yu Gothic UI on Windows), whose kana and kanji come from one family, where Pretendard has the
 * kana but only a few hundred kanji. `noto`: Noto Sans with its CJK families, for a device that
 * has them installed.
 */
export const UI_FONT_PRESET_FAMILY: Record<UiFontPreset, string> = {
  default: "",
  system: "system-ui",
  noto: '"Noto Sans", "Noto Sans JP", "Noto Sans KR", "Noto Sans SC", "Noto Sans TC", "Noto Sans CJK JP"',
};

export function uiFontPreset(family: string): UiFontPreset | "custom" {
  const chosen = sanitizeFontFamily(family);
  return UI_FONT_PRESETS.find((preset) => UI_FONT_PRESET_FAMILY[preset] === chosen) ?? "custom";
}

/** The `--font-ui` to write: the chosen list in front of the built-in stack, or null to keep the stylesheet's. */
export function uiFontStack(family: string): string | null {
  const chosen = sanitizeFontFamily(family);
  return chosen === "" ? null : `${chosen}, ${UI_FONT_STACK}`;
}

/** The interface's body size (`--fs-md`) in px: the chat's range, less the sizes a 32px control cannot hold. */
export const UI_FONT_MIN = 11;
export const UI_FONT_MAX = 20;

/** A stored interface size: a whole px within the limits, or null (follow the density) for anything else. */
export function sanitizeUiFontSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(UI_FONT_MAX, Math.max(UI_FONT_MIN, Math.round(value)));
}

/**
 * The multiplier that draws `basePx` text at `sizePx`: `--ui-scale` is the interface's body size
 * over the density's own, and `--chat-scale` the chat's over the interface's, so a chosen chat
 * size is drawn as itself whatever the interface size and an unchosen one follows it. 1 when
 * either side is not a positive size.
 */
export function fontScale(sizePx: number, basePx: number): number {
  if (!(sizePx > 0) || !(basePx > 0)) return 1;
  return sizePx / basePx;
}

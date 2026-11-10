/**
 * Themes a user imports (Settings → Appearance): a file of colours and nothing else. A theme is a
 * name and the sixteen Base16 seeds of a dark side, a light side or both; the app derives every
 * colour it draws from them (themeDerive.ts). No code or CSS is read from a file, and what is
 * kept is only what this module parsed: colours as `#rrggbb` and a short name.
 *
 * Two shapes are read: the app's own JSON (`{ "name", "dark": { base00 … base0F }, "light": { … } }`)
 * and a Base16 scheme as its projects publish it (YAML or JSON, one side), so the schemes that
 * exist can be imported as they are. docs/themes.md describes both.
 */
import { luminance, rgb } from "./colorMath.ts";
import { LIGHT_ANSI_ROLES } from "./themeRoles.ts";
import { BASE16_KEYS, deriveTheme, type Base16, type Base16Key } from "./themeDerive.ts";
import { themeFor } from "./themeFor.ts";
import type { DrawnTheme, Mode, TerminalColors, ThemeId } from "./themes.ts";

export const MAX_CUSTOM_THEMES = 12;
export const MAX_THEME_NAME = 40;
/** A theme file is a few hundred bytes; one far past that is not one. */
export const MAX_THEME_FILE_BYTES = 64 * 1024;

export interface CustomTheme {
  /** the colours and name, hashed: importing the same file again finds the same theme */
  id: string;
  name: string;
  dark?: Base16;
  light?: Base16;
}

/** The imported themes, and the one drawn on each side in place of that side's built-in theme. */
export interface CustomThemes {
  themes: CustomTheme[];
  dark: string | null;
  light: string | null;
}

export const NO_CUSTOM_THEMES: CustomThemes = { themes: [], dark: null, light: null };

const HEX = /^#?([0-9a-f]{6})$/i;
const ID = /^[0-9a-f]{8}$/;
const SIDES = ["dark", "light"] as const;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A name as it is kept: one line, no control characters, at most MAX_THEME_NAME characters. */
function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim()].slice(0, MAX_THEME_NAME).join("").trim();
}

const color = (value: unknown): string | null => {
  const match = typeof value === "string" ? HEX.exec(value.trim()) : null;
  return match?.[1] ? `#${match[1].toLowerCase()}` : null;
};

/** `base00` … `base0F` of an object, whatever the case of its keys; the colours that are not `rrggbb` are left out. */
function seedsOf(block: unknown): Partial<Record<Base16Key, string>> {
  const found: Partial<Record<Base16Key, string>> = {};
  if (!isObject(block)) return found;
  for (const [key, value] of Object.entries(block)) {
    const name = BASE16_KEYS.find((known) => known.toLowerCase() === key.toLowerCase());
    const hex = color(value);
    if (name && hex) found[name] = hex;
  }
  return found;
}

/** `from` a share of the way to `to`, channel by channel. */
function step(from: string, to: string, share: number): string {
  const [a, b] = [rgb(from), rgb(to)];
  return `#${a.map((channel, at) => Math.round(channel + (b[at]! - channel) * share).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * All sixteen seeds from the ones a file gave. A background and a text colour are the least a
 * side needs; a surface or grey left out is a step between those two, and a hue left out is the
 * text colour, so a file of two colours is a plain theme rather than a refused one.
 */
function completeSeeds(found: Partial<Record<Base16Key, string>>): Base16 | null {
  const { base00, base05 } = found;
  if (!base00 || !base05) return null;
  const greys: Partial<Record<Base16Key, number>> = { base01: 0.06, base02: 0.14, base03: 0.4, base04: 0.75, base06: 1, base07: 1 };
  return Object.fromEntries(BASE16_KEYS.map((key) => [key, found[key] ?? (key in greys ? step(base00, base05, greys[key]!) : base05)])) as unknown as Base16;
}

const kindOf = (seeds: Base16): Mode => luminance(rgb(seeds.base00)) <= luminance(rgb(seeds.base05)) ? "dark" : "light";

/** FNV-1a over the text, as eight hex digits. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) value = Math.imul(value ^ text.charCodeAt(at), 0x01000193);
  return (value >>> 0).toString(16).padStart(8, "0");
}

const canonical = (seeds: Base16 | undefined): string => seeds === undefined ? "" : BASE16_KEYS.map((key) => seeds[key]).join("");

function themeOf(name: string, dark: Base16 | undefined, light: Base16 | undefined): CustomTheme {
  return { id: hash(`${name}\n${canonical(dark)}\n${canonical(light)}`), name, ...(dark ? { dark } : {}), ...(light ? { light } : {}) };
}

/**
 * A Base16 scheme's YAML, read line by line: its sixteen `baseXX: "rrggbb"` lines wherever they
 * are indented, its `name:` (or the older `scheme:`) and its `variant:`. No YAML beyond that is
 * understood, and none is needed for a scheme file.
 */
function readSchemeLines(text: string): Record<string, unknown> {
  const palette: Record<string, string> = {};
  const scheme: Record<string, unknown> = { palette };
  for (const line of text.split(/\r?\n/)) {
    const seed = /^\s*(base0[0-9a-f])\s*:\s*["']?#?([0-9a-f]{6})["']?\s*(?:#.*)?$/i.exec(line);
    if (seed?.[1] && seed[2]) { palette[seed[1]] = seed[2]; continue; }
    const field = /^(name|scheme|variant)\s*:\s*(.*?)\s*$/.exec(line);
    if (!field?.[1] || field[2] === undefined || field[1] in scheme) continue;
    const quoted = /^(["'])(.*)\1/.exec(field[2]);
    scheme[field[1]] = quoted ? quoted[2] : field[2].replace(/\s+#.*$/, "");
  }
  return scheme;
}

export type ThemeFileError = "too-large" | "not-a-theme" | "no-colors";
export type ThemeFileResult = { theme: CustomTheme } | { error: ThemeFileError };

/**
 * The theme a file holds. `fallbackName` names a theme whose file gives none (the file's own
 * name, without its ending).
 */
export function readThemeFile(text: string, fallbackName = ""): ThemeFileResult {
  if (text.length > MAX_THEME_FILE_BYTES) return { error: "too-large" };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = readSchemeLines(text); }
  if (!isObject(parsed)) return { error: "not-a-theme" };
  const name = cleanName(parsed["name"]) || cleanName(parsed["scheme"]) || cleanName(fallbackName) || "Theme";
  // the app's own shape: a block for either side
  if (isObject(parsed["dark"]) || isObject(parsed["light"])) {
    const dark = completeSeeds(seedsOf(parsed["dark"])) ?? undefined;
    const light = completeSeeds(seedsOf(parsed["light"])) ?? undefined;
    return dark || light ? { theme: themeOf(name, dark, light) } : { error: "no-colors" };
  }
  // a Base16 scheme: one side, its colours under `palette` or beside its name
  const found = seedsOf(isObject(parsed["palette"]) ? parsed["palette"] : parsed);
  if (Object.keys(found).length === 0) return { error: "not-a-theme" };
  const seeds = completeSeeds(found);
  if (!seeds) return { error: "no-colors" };
  const variant = parsed["variant"] === "dark" || parsed["variant"] === "light" ? parsed["variant"] : kindOf(seeds);
  return { theme: variant === "dark" ? themeOf(name, seeds, undefined) : themeOf(name, undefined, seeds) };
}

/** A stored block: all sixteen, in their own order whatever order it was stored in. */
function storedSeeds(block: unknown): Base16 | undefined {
  const found = seedsOf(block);
  return BASE16_KEYS.every((key) => found[key] !== undefined) ? Object.fromEntries(BASE16_KEYS.map((key) => [key, found[key]])) as unknown as Base16 : undefined;
}

/** The imported themes of a stored record or a shared document: only what readThemeFile could have made is kept. */
export function sanitizeCustomThemes(raw: unknown): CustomThemes {
  if (!isObject(raw) || !Array.isArray(raw["themes"])) return NO_CUSTOM_THEMES;
  const themes: CustomTheme[] = [];
  for (const entry of raw["themes"]) {
    if (themes.length >= MAX_CUSTOM_THEMES) break;
    if (!isObject(entry) || typeof entry["id"] !== "string" || !ID.test(entry["id"]) || themes.some((theme) => theme.id === entry["id"])) continue;
    const name = cleanName(entry["name"]);
    const dark = storedSeeds(entry["dark"]);
    const light = storedSeeds(entry["light"]);
    if (name === "" || (!dark && !light)) continue;
    themes.push({ id: entry["id"], name, ...(dark ? { dark } : {}), ...(light ? { light } : {}) });
  }
  const chosen = (side: Mode): string | null => typeof raw[side] === "string" && themes.some((theme) => theme.id === raw[side]) ? raw[side] : null;
  return themes.length === 0 ? NO_CUSTOM_THEMES : { themes, dark: chosen("dark"), light: chosen("light") };
}

/** The list with `theme` in it (in place when it is already there), chosen for `side`; null when the list is full. */
export function withTheme(current: CustomThemes, theme: CustomTheme, side: Mode): CustomThemes | null {
  const held = current.themes.some((entry) => entry.id === theme.id);
  if (!held && current.themes.length >= MAX_CUSTOM_THEMES) return null;
  return { ...current, themes: held ? current.themes : [...current.themes, theme], [side]: theme.id };
}

/** The list without the theme, and no side left drawing it. */
export function withoutTheme(current: CustomThemes, id: string): CustomThemes {
  const themes = current.themes.filter((entry) => entry.id !== id);
  return themes.length === 0 ? NO_CUSTOM_THEMES : { themes, dark: current.dark === id ? null : current.dark, light: current.light === id ? null : current.light };
}

/** How a row drawn from an imported theme is named: no built-in theme's id holds a colon. */
export const customRowId = (id: string): string => `custom:${id}`;

const rows = new Map<string, DrawnTheme>();

/**
 * The row an imported theme draws on `side`: that side's block, or its only block as it is (a dark
 * theme chosen for light mode draws dark, as a built-in one does). Derived once per theme and side.
 */
export function customRow(theme: CustomTheme, side: Mode): DrawnTheme {
  const mode: Mode = theme[side] ? side : side === "dark" ? "light" : "dark";
  const key = `${theme.id}/${mode}`;
  const held = rows.get(key);
  if (held) return held;
  const vars = deriveTheme(theme[mode]!, mode);
  const terminal: TerminalColors = {
    background: vars["term-bg"], foreground: vars["term-fg"], cursor: vars["term-cursor"], selectionBackground: vars["term-selection"],
    ...(mode === "light" ? Object.fromEntries(Object.entries(LIGHT_ANSI_ROLES).map(([name, role]) => [name, vars[role]])) : {}),
  };
  const row: DrawnTheme = {
    id: customRowId(theme.id), mode, vars, terminal, bgPanel: vars["bg-panel"], bg: vars.bg,
    preview: { elevated: vars["bg-elevated"], border: vars.border, text: vars.text, textDim: vars["text-dim"], accent: vars.accent, primary: vars.primary },
  };
  // a theme list is short and a removed theme's rows are small: the oldest leave only past a few lists' worth
  if (rows.size >= MAX_CUSTOM_THEMES * 4) rows.delete(rows.keys().next().value!);
  rows.set(key, row);
  return row;
}

/** The theme chosen for `side`, when one is and it is still in the list. */
export function chosenTheme(custom: CustomThemes, side: Mode): CustomTheme | undefined {
  const id = custom[side];
  return id === null ? undefined : custom.themes.find((theme) => theme.id === id);
}

/** The row drawn for `resolved`: the imported theme chosen for that side, else the side's built-in theme. */
export function drawnTheme(settings: { darkTheme: ThemeId; lightTheme: ThemeId; customThemes: CustomThemes }, resolved: Mode): DrawnTheme {
  const theme = chosenTheme(settings.customThemes, resolved);
  return theme ? customRow(theme, resolved) : themeFor(settings, resolved);
}

/** The rows the boot script may draw before the app has loaded (themeBoot.ts): one per side that draws an imported theme. */
export function bootRows(custom: CustomThemes): Partial<Record<Mode, DrawnTheme>> {
  return Object.fromEntries(SIDES.flatMap((side) => {
    const theme = chosenTheme(custom, side);
    return theme ? [[side, customRow(theme, side)]] : [];
  }));
}

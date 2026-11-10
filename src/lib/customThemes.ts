/**
 * Themes a user imports (Settings → Appearance): a file of colours and nothing else. A theme is a
 * name and the sixteen Base16 seeds of a dark side, a light side or both; the app derives every
 * colour it draws from them (themeDerive.ts). No code or CSS is read from a file, and what is
 * kept is only what this module parsed: colours as `#rrggbb` and a short name.
 *
 * Two shapes are read: the app's own JSON (`{ "name", "dark": { base00 … base0F }, "light": { … } }`)
 * and a Base16 scheme as its projects publish it (YAML or JSON, one side), so the schemes that
 * exist can be imported as they are. docs/themes.md describes both. Which side a block is, is told
 * by its colours and never by what the file calls it.
 */
import { rgb } from "./colorMath.ts";
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

/**
 * A name as it is kept: one line, at most MAX_THEME_NAME characters, without control characters or
 * the marks that reorder the text around it (a name from someone else's file is drawn in Settings).
 * A name that would draw nothing is no name.
 */
function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  const plain = value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  const name = [...plain.replace(/\s+/g, " ").trim()].slice(0, MAX_THEME_NAME).join("").trim();
  return /[^\p{Cf}\p{Z}]/u.test(name) ? name : "";
}

const color = (value: unknown): string | null => {
  const match = typeof value === "string" ? HEX.exec(value.trim()) : null;
  return match?.[1] ? `#${match[1].toLowerCase()}` : null;
};

/**
 * `base00` … `base0F` of an object, whatever the case of its keys. `bad` names the first of them
 * whose value is no `rrggbb` colour: a typing slip in a file is said, not drawn as another colour.
 */
function seedsOf(block: unknown): { found: Partial<Record<Base16Key, string>>; bad: Base16Key | null } {
  const found: Partial<Record<Base16Key, string>> = {};
  let bad: Base16Key | null = null;
  if (!isObject(block)) return { found, bad };
  for (const [key, value] of Object.entries(block)) {
    const name = BASE16_KEYS.find((known) => known.toLowerCase() === key.toLowerCase());
    if (!name) continue;
    const hex = color(value);
    if (hex) found[name] = hex;
    else bad ??= name;
  }
  return { found, bad };
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

const derivations = new Map<string, ReturnType<typeof deriveTheme>>();

/** What the seeds draw (themeDerive.ts), worked out once: a derivation takes a few milliseconds and its seeds do not change. */
function derived(seeds: Base16): ReturnType<typeof deriveTheme> {
  const key = canonical(seeds);
  let held = derivations.get(key);
  if (!held) {
    // a theme list is short: the oldest leave only past a few lists' worth
    if (derivations.size >= MAX_CUSTOM_THEMES * 8) derivations.delete(derivations.keys().next().value!);
    derivations.set(key, held = deriveTheme(seeds));
  }
  return held;
}

/**
 * The theme of the blocks a file gave, each under the side its colours are: light text on a darker
 * ground is the dark side, whatever the file called it. Two blocks of one kind keep the one the
 * file filed under that side.
 */
function themeFrom(name: string, given: Partial<Record<Mode, Base16>>): CustomTheme {
  const blocks = SIDES.flatMap((side) => given[side] ? [{ side, seeds: given[side], mode: derived(given[side]).mode }] : []);
  const placed: Partial<Record<Mode, Base16>> = {};
  for (const block of [...blocks.filter((entry) => entry.side === entry.mode), ...blocks.filter((entry) => entry.side !== entry.mode)]) placed[block.mode] ??= block.seeds;
  return themeOf(name, placed.dark, placed.light);
}

/** A line longer than this is no line of a scheme file. */
const MAX_SCHEME_LINE = 200;

/** A YAML value as a scheme file writes one: quoted either way, or bare up to a comment. */
function scalar(text: string): string {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") {
    const comment = text.search(/\s#/);
    return comment === -1 ? text : text.slice(0, comment);
  }
  let value = "";
  for (let at = 1; at < text.length; at++) {
    const char = text[at]!;
    if (quote === "'" && char === "'" && text[at + 1] === "'") { value += "'"; at++; continue; }
    if (char === quote) break;
    if (quote === '"' && char === "\\" && at + 1 < text.length) {
      const code = text[at + 1] === "u" ? /^[0-9a-f]{4}$/i.exec(text.slice(at + 2, at + 6))?.[0] : undefined;
      value += code ? String.fromCharCode(parseInt(code, 16)) : text[at + 1];
      at += code ? 5 : 1;
      continue;
    }
    value += char;
  }
  return value;
}

/**
 * A Base16 scheme's YAML, read line by line: its sixteen `baseXX: "rrggbb"` lines wherever they
 * are indented, and its `name:` (or the older `scheme:`). No YAML beyond that is understood, and
 * none is needed for a scheme file. Every step is linear in the line, and a long line is skipped.
 */
function readSchemeLines(text: string): Record<string, unknown> {
  const palette: Record<string, string> = {};
  const scheme: Record<string, unknown> = { palette };
  for (const raw of text.split("\n")) {
    if (raw.length > MAX_SCHEME_LINE) continue;
    const line = raw.trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trimEnd();
    const value = scalar(line.slice(colon + 1).trimStart());
    if (/^base0[0-9a-f]$/i.test(key)) palette[key] = value;
    // a field of the scheme itself, not of something nested in it
    else if ((key === "name" || key === "scheme") && raw.startsWith(key) && !(key in scheme)) scheme[key] = value;
  }
  return scheme;
}

export type ThemeFileError = "too-large" | "not-a-theme" | "no-colors" | "bad-color";
/** `key`: the colour a "bad-color" file wrote wrongly. */
export type ThemeFileResult = { theme: CustomTheme } | { error: ThemeFileError; key?: Base16Key };

/**
 * The theme a file holds. `fallbackName` names a theme whose file gives none (the file's own
 * name, without its ending). A file is taken whole or refused: a colour it wrote wrongly, or a
 * side without a ground and a text colour, is said rather than left out.
 */
export function readThemeFile(file: string, fallbackName = ""): ThemeFileResult {
  if (file.length > MAX_THEME_FILE_BYTES) return { error: "too-large" };
  const text = file.startsWith("\ufeff") ? file.slice(1) : file;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = readSchemeLines(text); }
  if (!isObject(parsed)) return { error: "not-a-theme" };
  const name = cleanName(parsed["name"]) || cleanName(parsed["scheme"]) || cleanName(fallbackName) || "Theme";
  // the app's own shape: a block for either side
  if (isObject(parsed["dark"]) || isObject(parsed["light"])) {
    const given: Partial<Record<Mode, Base16>> = {};
    for (const side of SIDES) {
      if (parsed[side] === undefined || parsed[side] === null) continue;
      const { found, bad } = seedsOf(parsed[side]);
      if (bad) return { error: "bad-color", key: bad };
      const seeds = completeSeeds(found);
      if (!seeds) return { error: "no-colors" };
      given[side] = seeds;
    }
    return { theme: themeFrom(name, given) };
  }
  // a Base16 scheme: one side, its colours under `palette` or beside its name
  const { found, bad } = seedsOf(isObject(parsed["palette"]) ? parsed["palette"] : parsed);
  if (bad) return { error: "bad-color", key: bad };
  if (Object.keys(found).length === 0) return { error: "not-a-theme" };
  const seeds = completeSeeds(found);
  return seeds ? { theme: themeFrom(name, { dark: seeds }) } : { error: "no-colors" };
}

/** A stored block: all sixteen, in their own order whatever order it was stored in. */
function storedSeeds(block: unknown): Base16 | undefined {
  const { found } = seedsOf(block);
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

const sameTheme = (a: CustomTheme, b: CustomTheme): boolean => a.name === b.name && canonical(a.dark) === canonical(b.dark) && canonical(a.light) === canonical(b.light);

/**
 * The list with `theme` in it, chosen for `side`; null when the list is full. A theme already
 * there stays where it is, and another one filed under the same id gives its place to this one.
 */
export function withTheme(current: CustomThemes, theme: CustomTheme, side: Mode): CustomThemes | null {
  const at = current.themes.findIndex((entry) => entry.id === theme.id);
  if (at === -1 && current.themes.length >= MAX_CUSTOM_THEMES) return null;
  const themes = at === -1 ? [...current.themes, theme] : sameTheme(current.themes[at]!, theme) ? current.themes : current.themes.map((entry, index) => index === at ? theme : entry);
  return { ...current, themes, [side]: theme.id };
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
 * theme chosen for light mode draws dark, as a built-in one does). The row's mode is what its
 * colours are. One row per theme and block, so what draws it keeps its identity between renders.
 */
export function customRow(theme: CustomTheme, side: Mode): DrawnTheme {
  const seeds = (theme[side] ?? theme[side === "dark" ? "light" : "dark"])!;
  const key = `${theme.id}/${canonical(seeds)}`;
  const held = rows.get(key);
  if (held) return held;
  const { mode, vars } = derived(seeds);
  const terminal: TerminalColors = {
    background: vars["term-bg"], foreground: vars["term-fg"], cursor: vars["term-cursor"], selectionBackground: vars["term-selection"],
    ...(mode === "light" ? Object.fromEntries(Object.entries(LIGHT_ANSI_ROLES).map(([name, role]) => [name, vars[role]])) : {}),
  };
  const row: DrawnTheme = {
    id: customRowId(theme.id), mode, vars, terminal, bgPanel: vars["bg-panel"], bg: vars.bg,
    preview: { elevated: vars["bg-elevated"], border: vars.border, text: vars.text, textDim: vars["text-dim"], accent: vars.accent, primary: vars.primary },
  };
  if (rows.size >= MAX_CUSTOM_THEMES * 8) rows.delete(rows.keys().next().value!);
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

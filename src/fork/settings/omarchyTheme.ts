/**
 * The page drawn in the Omarchy theme of the device it runs on (Settings → Appearance → Follow
 * Omarchy). That device's theme-set hook sends its colors.toml to the server, which tells it to
 * this browser on the PC event stream (shared/omarchy-theme.ts); a browser on any other device
 * (a phone) is told none and keeps the chosen theme. The theme is drawn over the default theme's
 * row of its mode: its colors set the surfaces, text, accent, syntax and terminal tokens inline on
 * the document, and a status color that would not stand off its background keeps the row's own.
 * No React here: the page's boot script (lib/themeBoot.ts) draws the last one told before the
 * first paint.
 */
import { omarchyTheme, type OmarchyTheme } from "../../../shared/omarchy-theme.ts";
import { DEFAULT_THEME, type DrawnTheme, type TerminalColors } from "../../lib/themes.ts";

const rgb = (color: string): number[] => [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
const hex = (channels: number[]): string => `#${channels.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
/** `from` moved `amount` of the way to `to` */
const mix = (from: string, to: string, amount: number): string => {
  const target = rgb(to);
  return hex(rgb(from).map((value, at) => value + (target[at]! - value) * amount));
};
const tint = (color: string, alpha: number): string => `rgba(${rgb(color).join(", ")}, ${alpha})`;
const luminance = (color: string): number => {
  const [r, g, b] = rgb(color).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
};

/** The row the page draws for an Omarchy theme. */
export function drawnOmarchyTheme(theme: OmarchyTheme): DrawnTheme {
  const c = theme.colors;
  const panel = c.background;
  const legible = (...colors: string[]): string | undefined => colors.find((color) => contrast(color, panel) >= 3);
  const tokens: Record<string, string> = {
    "--bg": c.dark_background,
    "--bg-panel": panel,
    "--bg-elevated": mix(panel, c.foreground, 0.06),
    "--bg-hover": mix(panel, c.foreground, 0.1),
    "--bg-input": mix(panel, c.dark_background, 0.5),
    "--border": mix(panel, c.foreground, 0.14),
    "--border-strong": mix(panel, c.foreground, 0.24),
    "--bubble-border": mix(panel, c.foreground, 0.14),
    "--text": c.foreground,
    "--text-dim": mix(c.foreground, panel, 0.35),
    "--text-strong": c.bright_foreground === c.foreground ? mix(c.foreground, theme.mode === "dark" ? "#ffffff" : "#000000", 0.3) : c.bright_foreground,
    "--line-number": mix(c.foreground, panel, 0.55),
    "--accent": c.accent,
    "--accent-tint": tint(c.accent, 0.13),
    "--primary": c.accent,
    "--primary-hover": mix(c.accent, theme.mode === "dark" ? "#ffffff" : "#000000", 0.15),
    "--primary-text": contrast(c.accent, panel) >= contrast(c.accent, c.foreground) ? panel : c.foreground,
    "--primary-tint": tint(c.accent, 0.16),
    "--status-idle": mix(c.foreground, panel, 0.35),
    "--term-bg": panel,
    "--term-fg": c.foreground,
    "--term-cursor": c.bright_foreground,
    "--term-selection": c.selection,
    "--syntax-function": c.blue,
    "--syntax-keyword": c.magenta,
    "--syntax-string": c.green,
    "--syntax-number": c.yellow,
    "--syntax-type": c.cyan,
    "--syntax-variable": c.foreground,
    "--syntax-meta": c.muted,
  };
  const statuses = { working: legible(c.blue, c.cyan, c.bright_blue), blocked: legible(c.red, c.bright_red), done: legible(c.green, c.bright_green) };
  for (const [state, color] of Object.entries(statuses)) {
    if (color === undefined) continue;
    tokens[`--status-${state}`] = color;
    tokens[`--status-${state}-tint`] = tint(color, 0.14);
  }
  if (statuses.blocked !== undefined) tokens["--danger-tint"] = tint(statuses.blocked, 0.12);
  const notice = legible(c.yellow, c.bright_yellow);
  if (notice !== undefined) tokens["--notice"] = notice;
  // as Omarchy's own alacritty.toml.tpl maps them, so a terminal here matches the desktop's
  const terminal: TerminalColors = {
    background: panel, foreground: c.foreground, cursor: c.bright_foreground, selectionBackground: c.selection,
    black: panel, red: c.red, green: c.green, yellow: c.yellow, blue: c.blue, magenta: c.magenta, cyan: c.cyan, white: c.foreground,
    brightBlack: c.muted, brightRed: c.bright_red, brightGreen: c.bright_green, brightYellow: c.bright_yellow,
    brightBlue: c.bright_blue, brightMagenta: c.bright_magenta, brightCyan: c.bright_cyan, brightWhite: c.bright_foreground,
  };
  return { id: DEFAULT_THEME, mode: theme.mode, bgPanel: panel, bg: c.dark_background, terminal, tokens,
    preview: { elevated: tokens["--bg-elevated"]!, border: tokens["--border"]!, text: c.foreground, textDim: tokens["--text-dim"]!, accent: c.accent, primary: c.accent } };
}

/** The last theme this device was told, kept for the boot script's first frame. */
export const OMARCHY_THEME_STORAGE_KEY = "ovis:omarchy-theme";

export function cachedOmarchyTheme(storage: () => Pick<Storage, "getItem">): OmarchyTheme | null {
  try {
    const raw = storage().getItem(OMARCHY_THEME_STORAGE_KEY);
    const stored: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof stored !== "object" || stored === null) return null;
    const { colors, mode, name } = stored as Record<string, unknown>;
    return typeof colors === "object" && colors !== null ? omarchyTheme({ ...colors, mode }, name) : null;
  } catch {
    return null;
  }
}

let current: OmarchyTheme | null = typeof window === "undefined" ? null : cachedOmarchyTheme(() => window.localStorage);
const listeners = new Set<() => void>();

/** The theme the server says this device is in, or null: none sent from this device. */
export function currentOmarchyTheme(): OmarchyTheme | null { return current; }

export function subscribeOmarchyTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The PC event stream's `omarchy-theme` event. */
export function receiveOmarchyTheme(theme: OmarchyTheme | null): void {
  if (JSON.stringify(theme) === JSON.stringify(current)) return;
  current = theme;
  try {
    if (theme === null) window.localStorage.removeItem(OMARCHY_THEME_STORAGE_KEY);
    else window.localStorage.setItem(OMARCHY_THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch { /* private mode: the theme lasts for the session */ }
  for (const listener of [...listeners]) listener();
}

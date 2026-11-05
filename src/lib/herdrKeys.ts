/**
 * herdr's prefix keys in the app (Settings → Shortcuts → Use herdr's prefix keys, off by default):
 * herdr's prefix (Ctrl+B unless its config.toml says otherwise), then a key herdr binds to one of
 * the actions in shared/herdr-keys.ts runs the app's own action for it. Read from GET /api/herdr-ui
 * (lib/herdrUi.ts). Text fields, dialogs, menus and IME composition keep every key; an app shortcut
 * stays the app's; a key after the prefix that runs nothing goes to the pane as typed.
 */
import { useEffect, useState } from "react";
import { HERDR_PREFIX_ACTIONS, type HerdrKeys, type HerdrPrefixAction } from "../../shared/herdr-keys.ts";
import type { AppActions } from "./actions.ts";
import { ApiError } from "./api.ts";
import { useT } from "./i18n.ts";
import { herdrKeys, loadHerdrUi } from "./herdrUi.ts";
import { useSettings } from "./settings.ts";
import { isAppShortcut, isRecordingShortcut, shortcutEventKey, type ShortcutEventLike } from "./shortcuts.ts";

export interface HerdrChord {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  /** a lowercase letter, a digit, a punctuation character, or a KeyboardEvent.key name (Tab, Escape, ArrowLeft, F1) */
  readonly key: string;
}

interface HerdrBinding {
  readonly prefixed: boolean;
  readonly chord: HerdrChord;
  /** herdr's `1..9`: the digit pressed is the index */
  readonly indexed: boolean;
}

/** herdr's named keys (its config template: "minus, comma, ampersand, plus, and backtick", esc, enter, tab, arrows) */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  minus: "-", comma: ",", ampersand: "&", plus: "+", backtick: "`",
  enter: "Enter", tab: "Tab", esc: "Escape", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown",
};
const MODIFIERS: Readonly<Record<string, keyof Omit<HerdrChord, "key">>> = { ctrl: "ctrl", alt: "alt", shift: "shift", cmd: "meta", super: "meta" };

/**
 * One herdr binding (`prefix+shift+n`, `ctrl+b`, `prefix+1..9`), or null for anything this app does
 * not read the way herdr does: an unknown name, a repeated modifier, an uppercase letter.
 */
export function parseHerdrBinding(text: string): HerdrBinding | null {
  const parts = text.trim().split("+");
  if (parts.some((part) => part === "")) return null;
  const prefixed = parts[0] === "prefix";
  if (prefixed) parts.shift();
  const last = parts.pop();
  if (last === undefined) return null;
  const chord = { ctrl: false, alt: false, shift: false, meta: false };
  for (const part of parts) {
    const modifier = MODIFIERS[part];
    if (modifier === undefined || chord[modifier]) return null;
    chord[modifier] = true;
  }
  if (last === "1..9") return { prefixed, chord: { ...chord, key: "1" }, indexed: true };
  const key = Object.hasOwn(NAMED_KEYS, last) ? NAMED_KEYS[last]!
    : /^f(?:[1-9]|1[0-2])$/.test(last) ? last.toUpperCase()
    : [...last].length === 1 && /^[\p{P}\p{S}a-z0-9]$/u.test(last) ? last
    : null;
  return key === null ? null : { prefixed, chord: { ...chord, key }, indexed: false };
}

/**
 * Whether a keydown is the chord. Letters and digits are read by position where the layout types
 * something else (shortcutEventKey: a Korean or Cyrillic letter, a digit with Shift); punctuation by
 * the character typed, so `?` is Shift+/ on a US keyboard and whatever types it elsewhere.
 */
export function chordMatches(chord: HerdrChord, event: ShortcutEventLike): boolean {
  if (event.ctrlKey !== chord.ctrl || event.altKey !== chord.alt || event.metaKey !== chord.meta) return false;
  if (/^[a-z0-9]$/.test(chord.key)) return event.shiftKey === chord.shift && shortcutEventKey(event) === chord.key;
  if ([...chord.key].length === 1) return event.key === chord.key && (!chord.shift || event.shiftKey);
  return event.key === chord.key && event.shiftKey === chord.shift;
}

export interface HerdrKeyMap {
  readonly prefix: HerdrChord;
  readonly bindings: readonly { readonly action: HerdrPrefixAction; readonly chord: HerdrChord; readonly indexed: boolean }[];
}

/**
 * The prefix and the prefix bindings the app can run, or null when there is nothing to take the
 * prefix for: no prefix this app reads as herdr does, or no binding behind it. A direct (non-prefix)
 * binding stays herdr's.
 */
export function compileHerdrKeys(keys: HerdrKeys): HerdrKeyMap | null {
  const prefix = parseHerdrBinding(keys.prefix);
  if (prefix === null || prefix.prefixed || prefix.indexed) return null;
  const bindings = HERDR_PREFIX_ACTIONS.flatMap((action) => {
    const binding = parseHerdrBinding(keys.bindings[action]);
    return binding?.prefixed ? [{ action, chord: binding.chord, indexed: binding.indexed }] : [];
  });
  return bindings.length === 0 ? null : { prefix: prefix.chord, bindings };
}

export type HerdrKeyStep =
  | { readonly kind: "ignore" }
  | { readonly kind: "pass" }
  | { readonly kind: "arm" }
  | { readonly kind: "escape" }
  | { readonly kind: "run"; readonly action: HerdrPrefixAction; readonly index: number | null };

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn", "OS"]);

/**
 * What one keydown does, `armed` after the prefix: a modifier alone changes nothing (Shift on its way
 * to Shift+N); the prefix arms; armed, a bound key runs its action and Escape leaves; any other key
 * (the prefix again too) leaves and goes on to the pane as typed. IME composition always goes on.
 */
export function herdrKeyStep(map: HerdrKeyMap, armed: boolean, event: ShortcutEventLike): HerdrKeyStep {
  if (MODIFIER_KEYS.has(event.key)) return { kind: "ignore" };
  if (event.isComposing || event.keyCode === 229) return { kind: "pass" };
  if (!armed) return chordMatches(map.prefix, event) ? { kind: "arm" } : { kind: "pass" };
  for (const binding of map.bindings) {
    if (binding.indexed) {
      for (let index = 1; index <= 9; index++) {
        if (chordMatches({ ...binding.chord, key: String(index) }, event)) return { kind: "run", action: binding.action, index };
      }
    } else if (chordMatches(binding.chord, event)) return { kind: "run", action: binding.action, index: null };
  }
  return event.key === "Escape" ? { kind: "escape" } : { kind: "pass" };
}

/** `tabRefused`: herdr's refusal of a new tab, said over the pane as the tab strip's button says it */
export function runHerdrAction(actions: AppActions, action: HerdrPrefixAction, index: number | null, tabRefused: (reason: unknown) => void): void {
  switch (action) {
    case "help":
    case "workspace_picker":
    case "goto":
      actions.openPalette();
      return;
    case "settings":
      actions.openSettings();
      return;
    case "new_workspace":
      actions.openNewSession();
      return;
    case "previous_workspace":
      actions.selectAdjacentWorkspace(-1);
      return;
    case "next_workspace":
      actions.selectAdjacentWorkspace(1);
      return;
    case "new_tab":
      actions.openTerminalTab().catch(tabRefused);
      return;
    case "rename_tab":
      actions.renameTab();
      return;
    case "previous_tab":
      actions.selectAdjacentTab(-1);
      return;
    case "next_tab":
      actions.selectAdjacentTab(1);
      return;
    case "switch_tab":
      if (index !== null) actions.selectTabNumber(index);
      return;
    case "split_vertical":
      actions.splitPane?.("right");
      return;
    case "split_horizontal":
      actions.splitPane?.("down");
      return;
    case "zoom":
      actions.toggleZoom?.();
      return;
    case "toggle_sidebar":
      actions.toggleSidebar();
      return;
  }
}

/** A key typed into a field, a dialog or a menu is that control's, never herdr's. */
function keepsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.classList.contains("xterm-helper-textarea")) return false;
  return target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), dialog, [role='dialog'], [role='menu'], [role='listbox']") !== null;
}

/**
 * Listens while the setting is on; true while the prefix waits for its key (the header says so).
 * Each key is read against the keys this PC's herdr config answered last (a terminal mount reads them
 * again), and none until it has. Leaving the window or a click disarms it. `notice`: the line over
 * the pane (lib/useLayoutNotice.ts) that says herdr refused a new tab.
 */
export function useHerdrPrefixKeys(actions: AppActions, enabled: boolean, notice: (text: string) => void): boolean {
  const { settings } = useSettings();
  const t = useT();
  const on = enabled && settings.herdrPrefixKeys;
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (!on) return;
    void loadHerdrUi();
    let waiting = false;
    const disarm = (): void => { waiting = false; setArmed(false); };
    const onKeyDown = (event: KeyboardEvent): void => {
      const keys = herdrKeys();
      const map = keys === null ? null : compileHerdrKeys(keys);
      if (map === null || isRecordingShortcut() || (!waiting && (keepsKeys(event.target) || isAppShortcut(event, settings.shortcutOverrides)))) return;
      const step = herdrKeyStep(map, waiting, event);
      if (step.kind === "ignore") return;
      if (step.kind === "pass") { if (waiting) disarm(); return; }
      // the prefix and its key are the app's: neither reaches the pane nor the browser
      event.preventDefault();
      event.stopPropagation();
      if (step.kind === "arm") { waiting = true; setArmed(true); return; }
      disarm();
      if (step.kind === "run") runHerdrAction(actions, step.action, step.index, (reason) => notice(t("New terminal failed: {reason}", { reason: reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason) })));
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", disarm);
    window.addEventListener("pointerdown", disarm, true);
    document.addEventListener("visibilitychange", disarm);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", disarm);
      window.removeEventListener("pointerdown", disarm, true);
      document.removeEventListener("visibilitychange", disarm);
    };
  }, [on, actions, notice, t, settings.shortcutOverrides]);
  return armed;
}

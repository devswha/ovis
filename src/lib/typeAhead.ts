/**
 * Keys typed right after New terminal, before the new tab exists. A field out of sight takes the
 * keyboard at the choice, so nothing reaches the old tab and a Space or Enter cannot press the +
 * again; what it holds goes to the new tab's terminal (useTerminalMount adopts it ahead of anything
 * typed there), which sends it, in order, once its attach takes input, as it does for a pane taken
 * back from idleness. What may not go by itself is held for review instead (`held`): a paste (it
 * skipped the terminal's bracketed paste), and keys the user walked away from (the focus went
 * elsewhere before the tab came). On a touch screen the field opens no keyboard (inputmode none).
 */
import { paneStorageId } from "../../shared/machines.ts";
import { t } from "./i18n.ts";

/** One key or text typed ahead: `input` as the terminal would send it, `arrow` for an arrow key (sent in the program's own cursor mode) */
export interface TypeAheadItem {
  input: string;
  arrow?: string;
}

export interface TypeAheadCatch {
  /** the tab the keys are for: its terminal takes them (takeTypeAhead) */
  handTo: (machineId: string, paneId: string) => void;
  /** no tab came of it: what was typed goes nowhere, and the focus back where it was */
  drop: () => void;
}

export interface TypeAhead {
  items: TypeAheadItem[];
  /** when the catch began (performance.now()), for the resume wait */
  since: number;
  /** when the catch began (Date.now()), to compare with the PC connection's own clock */
  at: number;
  /** held for review, never sent by itself: keys typed before the user went elsewhere, or around a paste */
  held: boolean;
  /** a paste was refused: it never reached the terminal's bracketed paste, so it is not kept at all (the user is told) */
  pasteRefused: boolean;
  /** the field still had the keyboard: the terminal takes it over */
  focused: boolean;
}

/** a composition still open at the hand-over: its text, and what follows it in the field, come later */
export interface TypeAheadLater {
  more: (items: TypeAheadItem[], held: boolean) => void;
  /** the field is gone: the keyboard is the terminal's now, if `focused` */
  done: (focused: boolean) => void;
}

interface Pending {
  field: HTMLTextAreaElement;
  items: TypeAheadItem[];
  since: number;
  at: number;
  held: boolean;
  pasteRefused: boolean;
  composing: boolean;
  later: TypeAheadLater | null;
  pane: string | null;
  paneId: string | null;
  end: () => boolean;
}

let pending: Pending | null = null;

const KEY_INPUT: Record<string, string> = { Enter: "\r", Tab: "\t", Backspace: "\x7f", Escape: "\x1b" };
const ARROW_INPUT: Record<string, string> = { ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D" };

/** The input a key typed in the field stands for; null for one the field leaves to the browser (text, its own shortcuts). */
export function typeAheadKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): TypeAheadItem | null {
  if (event.metaKey || event.altKey) return null;
  if (event.ctrlKey) {
    // a control character, as a terminal sends it; Ctrl+V stays the browser's paste
    if (event.shiftKey || !/^[a-z]$/i.test(event.key) || event.key.toLowerCase() === "v") return null;
    return { input: String.fromCharCode(event.key.toLowerCase().charCodeAt(0) & 0x1f) };
  }
  const arrow = ARROW_INPUT[event.key];
  if (arrow !== undefined) return event.shiftKey ? null : { input: arrow, arrow: event.key };
  const input = KEY_INPUT[event.key];
  if (event.shiftKey && event.key === "Enter") return { input: "\x1b\r" };
  return input === undefined || event.shiftKey ? null : { input };
}

export function catchTypeAhead(): TypeAheadCatch | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  pending?.end();
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.className = "type-ahead";
  field.setAttribute("aria-label", t("New terminal"));
  field.setAttribute("autocapitalize", "off");
  field.setAttribute("autocomplete", "off");
  // a touch screen's keyboard does not come up for it: only a keyboard already there types into it
  if (window.matchMedia?.("(pointer: coarse)").matches === true) field.inputMode = "none";
  field.spellcheck = false;
  field.tabIndex = -1;
  Object.assign(field.style, { position: "fixed", left: "0", top: "0", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
  const caught: Pending = { field, items: [], since: performance.now(), at: Date.now(), held: false, pasteRefused: false, composing: false, later: null, pane: null, paneId: null, end: () => false };
  const commit = (): void => {
    if (field.value === "") return;
    caught.items.push({ input: field.value });
    field.value = "";
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) return;
    const item = typeAheadKey(event);
    if (item === null) return;
    event.preventDefault();
    commit();
    caught.items.push(item);
  };
  const onInput = (event: Event): void => { if (!(event as InputEvent).isComposing) commit(); };
  // a paste is the terminal's to bracket once the program says it takes one: refused here, the keys around it held
  const onPaste = (event: ClipboardEvent): void => {
    event.preventDefault();
    caught.held = true;
    caught.pasteRefused = true;
  };
  const onCompositionStart = (): void => { caught.composing = true; };
  const onCompositionEnd = (): void => {
    caught.composing = false;
    commit();
    const later = caught.later;
    if (later === null) return;
    // the composition the hand-over waited for: its text goes after what was handed, then the terminal has the keyboard
    later.more(caught.items.splice(0), caught.held);
    later.done(end());
  };
  let open = true;
  const end = (): boolean => {
    if (!open) return false;
    open = false;
    field.removeEventListener("blur", onBlur);
    const focused = document.activeElement === field;
    // a blur commits a composition still open: its text comes before the field goes
    if (focused) field.blur();
    commit();
    field.removeEventListener("keydown", onKeyDown);
    field.removeEventListener("input", onInput);
    field.removeEventListener("paste", onPaste);
    field.removeEventListener("compositionstart", onCompositionStart);
    field.removeEventListener("compositionend", onCompositionEnd);
    field.remove();
    if (caught.later !== null && caught.items.length > 0) caught.later.more(caught.items.splice(0), caught.held);
    return focused;
  };
  caught.end = end;
  // the user went elsewhere (not the window losing focus, which gives it back, nor the new tab's own terminal
  // taking the keyboard, whose next key takes what was typed here first): what was typed is held, never sent
  const onBlur = (event: FocusEvent): void => {
    if (!document.hasFocus()) return;
    const to = event.relatedTarget instanceof Element ? event.relatedTarget.closest("[data-layout-pane]")?.getAttribute("data-layout-pane") : null;
    if (to == null || to !== caught.paneId) caught.held = true;
    const later = caught.later;
    const focused = end();
    later?.done(focused);
  };
  field.addEventListener("keydown", onKeyDown);
  field.addEventListener("input", onInput);
  field.addEventListener("paste", onPaste);
  field.addEventListener("compositionstart", onCompositionStart);
  field.addEventListener("compositionend", onCompositionEnd);
  field.addEventListener("blur", onBlur);
  document.body.appendChild(field);
  field.focus({ preventScroll: true });
  pending = caught;
  return {
    handTo: (machineId, paneId) => {
      if (pending !== caught) return;
      caught.pane = paneStorageId(machineId, paneId);
      caught.paneId = paneId;
    },
    drop: () => {
      if (pending !== caught) return;
      pending = null;
      if (end() && previous?.isConnected) previous.focus({ preventScroll: true });
    },
  };
}

/** Whether the keys typed for a new tab are being caught now: what closes behind the choice (a menu), and a pick's own focus, leave the focus be; only the hand-over moves it. */
export function typeAheadFocused(): boolean {
  return pending !== null && document.activeElement === pending.field;
}

/**
 * What was typed ahead for this pane (a pane storage id), taken once; null when nothing waits for it.
 * A composition still open keeps the field until it ends: its text comes through `later`.
 */
export function takeTypeAhead(pane: string, later: TypeAheadLater): TypeAhead | null {
  const caught = pending;
  if (caught === null || caught.pane !== pane) return null;
  pending = null;
  const items = caught.items.splice(0);
  if (caught.composing && document.activeElement === caught.field) {
    caught.later = later;
    return { items, since: caught.since, at: caught.at, held: caught.held, pasteRefused: caught.pasteRefused, focused: false };
  }
  const focused = caught.end();
  return { items: [...items, ...caught.items.splice(0)], since: caught.since, at: caught.at, held: caught.held, pasteRefused: caught.pasteRefused, focused };
}

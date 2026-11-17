import { paneStorageId } from "../../shared/machines.ts";
import { t } from "./i18n.ts";

export interface TypeAheadItem {
  input: string;
  arrow?: string;
}

export interface TypeAheadCatch {
  handTo: (machineId: string, paneId: string, shown?: boolean) => void;
  drop: () => void;
}

export interface TypeAhead {
  items: TypeAheadItem[];
  since: number;
  at: number;
  held: boolean;
  pasteRefused: boolean;
  focused: boolean;
}

export interface TypeAheadLater {
  more: (items: TypeAheadItem[], held: boolean) => void;
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

const pending: Pending[] = [];
let lingering: HTMLTextAreaElement | null = null;

const ARROW_INPUT: Record<string, string> = { ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D" };
const PLAIN_INPUT: Record<string, string> = { Enter: "\r", Tab: "\t", Escape: "\x1b", Delete: "\x1b[3~", Home: "\x1b[H", End: "\x1b[F" };
const EDITING = new Set(["Enter", "Tab", "Backspace", "Escape", "Delete", "Home", "End", ...Object.keys(ARROW_INPUT)]);

export function typeAheadKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): TypeAheadItem | "hold" | null {
  const { key, ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift } = event;
  if (key === "Backspace") {
    if (meta) return ctrl || alt ? "hold" : { input: "\x15" };
    return { input: `${alt ? "\x1b" : ""}${ctrl ? "\b" : "\x7f"}` };
  }
  if (ctrl && !meta && !alt && !shift && /^[a-z]$/i.test(key)) {
    return key.toLowerCase() === "v" ? null : { input: String.fromCharCode(key.toLowerCase().charCodeAt(0) & 0x1f) };
  }
  if (!EDITING.has(key)) return alt && !ctrl && !meta && key.length === 1 ? "hold" : null;
  const modified = ctrl || meta || alt;
  if (!modified && !shift) {
    const arrow = ARROW_INPUT[key];
    return arrow !== undefined ? { input: arrow, arrow: key } : { input: PLAIN_INPUT[key]! };
  }
  if (!modified && key === "Enter") return { input: "\x1b\r" };
  if (!modified && key === "Tab") return { input: "\x1b[Z" };
  if (meta && !ctrl && !alt && !shift && (key === "ArrowLeft" || key === "ArrowRight")) return { input: key === "ArrowLeft" ? "\x01" : "\x05" };
  return "hold";
}

export function catchTypeAhead(): TypeAheadCatch | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  for (const before of pending) if (before.end()) before.held = true;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.className = "type-ahead";
  field.setAttribute("aria-label", t("New terminal"));
  field.setAttribute("autocapitalize", "off");
  field.setAttribute("autocomplete", "off");
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
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const item = typeAheadKey(event);
    if (item === null) return;
    event.preventDefault();
    if (item === "hold") { caught.held = true; return; }
    commit();
    caught.items.push(item);
  };
  const onInput = (event: Event): void => { if (!(event as InputEvent).isComposing) commit(); };
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
    later.more(caught.items.splice(0), caught.held);
    later.done(end());
  };
  let open = true;
  const end = (): boolean => {
    if (!open) return false;
    open = false;
    if (lingering === field) lingering = null;
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
  pending.push(caught);
  const listed = (): boolean => pending.includes(caught);
  return {
    handTo: (machineId, paneId, shown = true) => {
      if (!listed()) return;
      caught.pane = paneStorageId(machineId, paneId);
      caught.paneId = paneId;
      if (!shown) {
        caught.held = true;
        caught.end();
      }
    },
    drop: () => {
      if (!listed()) return;
      pending.splice(pending.indexOf(caught), 1);
      if (end() && previous?.isConnected) previous.focus({ preventScroll: true });
    },
  };
}

export function typeAheadFocused(): boolean {
  const active = document.activeElement;
  return active !== null && (active === lingering || pending.some((caught) => caught.field === active));
}

export function takeTypeAhead(pane: string, later: TypeAheadLater): TypeAhead | null {
  const caught = pending.find((candidate) => candidate.pane === pane);
  if (caught === undefined) return null;
  pending.splice(pending.indexOf(caught), 1);
  const items = caught.items.splice(0);
  if (caught.composing && document.activeElement === caught.field) {
    caught.later = later;
    lingering = caught.field;
    return { items, since: caught.since, at: caught.at, held: caught.held, pasteRefused: caught.pasteRefused, focused: false };
  }
  const focused = caught.end();
  return { items: [...items, ...caught.items.splice(0)], since: caught.since, at: caught.at, held: caught.held, pasteRefused: caught.pasteRefused, focused };
}

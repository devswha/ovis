/**
 * Keys typed right after New terminal, before the new tab exists. A field out of sight takes the
 * keyboard at the choice, so nothing reaches the old tab and a Space or Enter cannot press the +
 * again; what it holds goes to the new tab's terminal (useTerminalMount adopts it ahead of anything
 * typed there), which sends it, in order, once its attach takes input, as it does for a pane taken
 * back from idleness. A touch screen opens no keyboard on its own: there nothing is caught.
 */
import { t } from "./i18n.ts";

export interface TypeAheadCatch {
  /** the tab the keys are for: its terminal takes them (takeTypeAhead) */
  handTo: (pane: string) => void;
  /** no tab came of it: what was typed goes nowhere, and the focus back where it was */
  drop: () => void;
}

export interface TypeAhead {
  /** the text and keys typed, in order: text as typed (a composition once committed), Enter as "\r", Tab as "\t", Backspace as "\x7f" */
  items: string[];
  since: number;
  /** the field still had the keyboard: the terminal takes it over */
  focused: boolean;
}

interface Pending {
  field: HTMLTextAreaElement;
  items: string[];
  since: number;
  pane: string | null;
  end: () => boolean;
}

let pending: Pending | null = null;

const KEY_BYTES: Record<string, string> = { Enter: "\r", Tab: "\t", Backspace: "\x7f" };

export function catchTypeAhead(): TypeAheadCatch | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function" || window.matchMedia?.("(pointer: coarse)").matches === true) return null;
  pending?.end();
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.className = "type-ahead";
  field.setAttribute("aria-label", t("New terminal"));
  field.setAttribute("autocapitalize", "off");
  field.setAttribute("autocomplete", "off");
  field.spellcheck = false;
  field.tabIndex = -1;
  Object.assign(field.style, { position: "fixed", left: "0", top: "0", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
  const items: string[] = [];
  const commit = (): void => {
    if (field.value === "") return;
    items.push(field.value);
    field.value = "";
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
    const bytes = KEY_BYTES[event.key];
    if (bytes === undefined) return;
    event.preventDefault();
    // a modified Enter is the terminal's to read (a newline, "send now"): it is not guessed here
    if (event.key === "Enter" && event.shiftKey) return;
    commit();
    items.push(bytes);
  };
  const onInput = (event: Event): void => { if (!(event as InputEvent).isComposing) commit(); };
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
    field.removeEventListener("compositionend", commit);
    field.remove();
    return focused;
  };
  // the user went elsewhere: what was typed stays for the tab, which no longer takes the keyboard
  const onBlur = (): void => { end(); };
  field.addEventListener("keydown", onKeyDown);
  field.addEventListener("input", onInput);
  field.addEventListener("compositionend", commit);
  field.addEventListener("blur", onBlur);
  document.body.appendChild(field);
  field.focus({ preventScroll: true });
  const caught: Pending = { field, items, since: performance.now(), pane: null, end };
  pending = caught;
  return {
    handTo: (pane) => { if (pending === caught) caught.pane = pane; },
    drop: () => {
      if (pending !== caught) return;
      pending = null;
      if (end() && previous?.isConnected) previous.focus({ preventScroll: true });
    },
  };
}

/** Whether the keys typed for a new tab are being caught now: what closes behind the choice (a menu) leaves the focus be. */
export function typeAheadFocused(): boolean {
  return pending !== null && document.activeElement === pending.field;
}

/** What was typed ahead for this pane (a pane storage id), taken once; null when nothing waits for it. */
export function takeTypeAhead(pane: string): TypeAhead | null {
  const caught = pending;
  if (caught === null || caught.pane !== pane) return null;
  pending = null;
  const focused = caught.end();
  return { items: caught.items, since: caught.since, focused };
}

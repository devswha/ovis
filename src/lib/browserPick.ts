/**
 * Formats an element picked from the desktop app's built-in browser into a chat composer draft
 * block and delivers its cropped PNG screenshot to the active pane's composer without sending.
 */
import { blockIntoComposer } from "./chatQuote.ts";
import type { PickedBrowserElement } from "./desktopBrowser.ts";

const singleLine = (text: string, max: number): string =>
  text.replace(/[\r\n\u0085\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const named = (text: string): string =>
  JSON.stringify(singleLine(text, 120));

/** Compact, single-element selector summary (e.g. `button#submit.btn.primary`). */
export function elementSelector(picked: Pick<PickedBrowserElement, "tag" | "id" | "classes">): string {
  const tag = singleLine(picked.tag, 40) || "element";
  const id = singleLine(picked.id, 80);
  const classes = picked.classes
    .map((item) => singleLine(item, 40))
    .filter((item) => item !== "" && !/\s/.test(item))
    .slice(0, 5);
  return `${tag}${id ? `#${id}` : ""}${classes.map((item) => `.${item}`).join("")}`;
}

/**
 * Formats the picked element's safe metadata for the composer draft. Never holds form input values;
 * uses only the allowed address (without query), selector, role/name, dimensions and safe visible text.
 */
export function pickedElementBlock(picked: PickedBrowserElement): string {
  const address = singleLine(picked.address, 240);
  const selector = elementSelector(picked);
  const details: string[] = [];
  const role = singleLine(picked.role, 40);
  const name = singleLine(picked.name, 80);
  if (role) details.push(`role=${named(role)}`);
  if (name) details.push(`name=${named(name)}`);
  if (picked.rect.width > 0 && picked.rect.height > 0) {
    details.push(`${Math.round(picked.rect.width)}×${Math.round(picked.rect.height)}`);
  }
  const lines = [
    `Picked element on ${address}`,
    `<${selector}>${details.length > 0 ? ` (${details.join(", ")})` : ""}`,
  ];
  const text = singleLine(picked.text, 120);
  if (text && text !== name) lines.push(`> ${text}`);
  return lines.join("\n");
}

/** Decodes a `data:image/png;base64,...` URL into a `File` for the composer's upload queue. */
export function dataUrlToPngFile(dataUrl: string, filename = "picked-element.png"): File | null {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) return null;
  const encoded = dataUrl.slice(prefix.length);
  if (encoded === "") return null;
  try {
    const raw = atob(encoded);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new File([bytes], filename, { type: "image/png" });
  } catch {
    return null;
  }
}

type FileListener = (files: readonly File[]) => void;
const fileListeners = new Map<string, Set<FileListener>>();
const pendingFiles = new Map<string, File[]>();

/** Subscribes `Composer` to files pushed from another surface (e.g. a picked browser element screenshot). */
export function onComposerFiles(paneKey: string, listener: FileListener): () => void {
  let set = fileListeners.get(paneKey);
  if (set === undefined) fileListeners.set(paneKey, set = new Set());
  set.add(listener);
  const queued = pendingFiles.get(paneKey);
  if (queued && queued.length > 0) {
    pendingFiles.delete(paneKey);
    listener(queued);
  }
  return () => {
    set.delete(listener);
    if (set.size === 0) fileListeners.delete(paneKey);
  };
}

export function clearPendingComposerFiles(paneKey?: string): void {
  if (paneKey === undefined) pendingFiles.clear();
  else pendingFiles.delete(paneKey);
}

/**
 * Appends the picked element's description into `paneKey`'s composer draft and attaches its
 * cropped PNG screenshot to the composer's upload queue. Returns false if the draft has no room.
 */
export function attachPickedElement(paneKey: string, picked: PickedBrowserElement): boolean {
  const block = pickedElementBlock(picked);
  if (!blockIntoComposer(paneKey, block)) return false;
  if (picked.imageDataUrl !== null) {
    const file = dataUrlToPngFile(picked.imageDataUrl);
    if (file !== null) {
      const listeners = fileListeners.get(paneKey);
      if (listeners && listeners.size > 0) {
        for (const listener of listeners) listener([file]);
      } else {
        const list = pendingFiles.get(paneKey) ?? [];
        list.push(file);
        pendingFiles.set(paneKey, list);
      }
    }
  }
  return true;
}

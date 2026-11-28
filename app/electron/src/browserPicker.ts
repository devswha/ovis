/**
 * One-shot element picker for a built-in browser tab (browserTabs.ts): injects a small
 * highlight overlay into an isolated world (PICK_WORLD) only while the user is picking, never
 * via a preload and never exposing a bridge to the page. Clicking an element removes the overlay,
 * reads safe metadata (never reading input, textarea, select or password values), and lets the
 * main process take a cropped screenshot of the element. Pressing Escape, navigating, hiding,
 * closing or cancelling removes the overlay and resolves to null.
 */
import type { WebContents } from "electron";

/** isolated world used only by the picker (page scripts cannot observe or tamper with it) */
const PICK_WORLD = 1_018;
const CAPTURE_MS = 2_000;
const CROP_PAD_CSS = 12;
const MAX_CAPTURE_WIDTH = 1_200;

export interface PickedElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PickedElementMeta {
  tag: string;
  role: string;
  id: string;
  classes: string[];
  name: string;
  text: string;
  rect: PickedElementRect;
}

export interface PickedBrowserElement extends PickedElementMeta {
  /** the tab's allowed address without its query */
  address: string;
  title: string;
  /** cropped PNG data URL taken after the highlight overlay was removed, or null if capture failed */
  imageDataUrl: string | null;
}

interface RawPickResult {
  tag?: unknown;
  role?: unknown;
  id?: unknown;
  classes?: unknown;
  name?: unknown;
  text?: unknown;
  rect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
}

const CLEANUP_KEY = "__ovisBrowserPickCancel";

/**
 * Self-contained picker script executed inside PICK_WORLD. Uses inline element styles (no <style>
 * tag) so strict page style-src CSP rules do not break the highlight overlay.
 */
export const PICKER_SCRIPT = `(() => {
  const prev = globalThis[${JSON.stringify(CLEANUP_KEY)}];
  if (typeof prev === "function") prev();

  return new Promise((resolve) => {
    const doc = document;
    const root = doc.documentElement;
    if (!root) { resolve(null); return; }

    const box = doc.createElement("div");
    box.setAttribute("data-ovis-picker", "box");
    box.style.position = "fixed";
    box.style.pointerEvents = "none";
    box.style.zIndex = "2147483647";
    box.style.boxSizing = "border-box";
    box.style.border = "2px solid #2563eb";
    box.style.background = "rgba(37, 99, 235, 0.14)";
    box.style.borderRadius = "3px";
    box.style.margin = "0";
    box.style.padding = "0";
    box.style.display = "none";

    const pill = doc.createElement("div");
    pill.setAttribute("data-ovis-picker", "pill");
    pill.style.position = "fixed";
    pill.style.pointerEvents = "none";
    pill.style.zIndex = "2147483647";
    pill.style.background = "#1d4ed8";
    pill.style.color = "#ffffff";
    pill.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    pill.style.fontSize = "11px";
    pill.style.fontWeight = "600";
    pill.style.lineHeight = "1.2";
    pill.style.padding = "2px 6px";
    pill.style.borderRadius = "4px";
    pill.style.whiteSpace = "nowrap";
    pill.style.maxWidth = "260px";
    pill.style.overflow = "hidden";
    pill.style.textOverflow = "ellipsis";
    pill.style.display = "none";

    root.appendChild(box);
    root.appendChild(pill);

    const prevCursor = root.style.cursor;
    root.style.cursor = "crosshair";

    let done = false;
    let hovered = null;

    const SKIP_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

    function safeText(node, limit) {
      if (!node) return "";
      if (node.nodeType === 3) return node.nodeValue || "";
      if (node.nodeType !== 1) return "";
      const el = node;
      if (SKIP_TAGS.has(el.tagName)) return "";
      if (el.isContentEditable || el.getAttribute("aria-hidden") === "true") return "";
      if (el.hasAttribute("data-ovis-picker")) return "";
      let out = "";
      for (const child of el.childNodes) {
        out += safeText(child, limit - out.length) + " ";
        if (out.length >= limit * 2) break;
      }
      return out;
    }

    function collapse(str, max) {
      return String(str || "").replace(/[\\s\\u0085\\u2028\\u2029]+/g, " ").trim().slice(0, max);
    }

    function labelTextFor(el) {
      if (!el || typeof el.getAttribute !== "function") return "";
      const aria = collapse(el.getAttribute("aria-label"), 80);
      if (aria) return aria;
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const parts = labelledBy.trim().split(/\\s+/).map((id) => {
          const ref = doc.getElementById(id);
          return ref ? collapse(safeText(ref, 80), 80) : "";
        }).filter(Boolean);
        if (parts.length > 0) return collapse(parts.join(" "), 80);
      }
      if ("labels" in el && el.labels && el.labels.length > 0) {
        const parts = Array.from(el.labels).map((label) => collapse(safeText(label, 80), 80)).filter(Boolean);
        if (parts.length > 0) return collapse(parts.join(" "), 80);
      }
      const isPassword = el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password";
      if (!isPassword) {
        const alt = collapse(el.getAttribute("alt"), 80);
        if (alt) return alt;
        const title = collapse(el.getAttribute("title"), 80);
        if (title) return title;
      }
      return "";
    }

    function targetAt(x, y) {
      let el = doc.elementFromPoint(x, y);
      while (el && el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
      if (!el || el.hasAttribute("data-ovis-picker")) return null;
      return el;
    }

    function highlight(el) {
      hovered = el;
      if (!el) {
        box.style.display = "none";
        pill.style.display = "none";
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) {
        box.style.display = "none";
        pill.style.display = "none";
        return;
      }
      box.style.display = "block";
      box.style.left = r.left + "px";
      box.style.top = r.top + "px";
      box.style.width = r.width + "px";
      box.style.height = r.height + "px";

      const tag = (el.tagName || "").toLowerCase();
      const id = el.id ? "#" + el.id.slice(0, 30) : "";
      pill.textContent = tag + id + " · " + Math.round(r.width) + "×" + Math.round(r.height);
      pill.style.display = "block";
      const top = r.top >= 24 ? r.top - 22 : Math.min(window.innerHeight - 22, r.bottom + 4);
      const left = Math.max(4, Math.min(window.innerWidth - 160, r.left));
      pill.style.top = Math.max(4, top) + "px";
      pill.style.left = left + "px";
    }

    function cleanup() {
      if (done) return;
      done = true;
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("pointerdown", suppress, true);
      window.removeEventListener("mousedown", suppress, true);
      window.removeEventListener("pointerup", suppress, true);
      window.removeEventListener("mouseup", suppress, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
      root.style.cursor = prevCursor;
      box.remove();
      pill.remove();
      if (globalThis[${JSON.stringify(CLEANUP_KEY)}] === cancel) {
        delete globalThis[${JSON.stringify(CLEANUP_KEY)}];
      }
    }

    function cancel() {
      if (done) return;
      cleanup();
      resolve(null);
    }

    function onMove(event) {
      highlight(targetAt(event.clientX, event.clientY));
    }

    function suppress(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
    }

    function onClick(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      const el = targetAt(event.clientX, event.clientY) || hovered;
      cleanup();
      if (!el) { resolve(null); return; }

      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.round(r.left));
      const y = Math.max(0, Math.round(r.top));
      const right = Math.min(window.innerWidth, Math.round(r.right));
      const bottom = Math.min(window.innerHeight, Math.round(r.bottom));
      const classes = typeof el.className === "string"
        ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 5).map((c) => c.slice(0, 40))
        : [];
      const inEditable = Boolean(el.closest && el.closest("input, textarea, select, [contenteditable]"));
      const text = inEditable ? "" : collapse(safeText(el, 120), 120);
      const payload = {
        tag: (el.tagName || "").toLowerCase().slice(0, 40),
        role: collapse(el.getAttribute("role"), 40),
        id: collapse(el.id, 80),
        classes,
        name: labelTextFor(el),
        text,
        rect: { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) },
      };
      // Wait a paint frame after overlay removal so the cropped capture contains the clean page.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(payload)));
    }

    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        cancel();
      }
    }

    globalThis[${JSON.stringify(CLEANUP_KEY)}] = cancel;
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("pointerdown", suppress, true);
    window.addEventListener("mousedown", suppress, true);
    window.addEventListener("pointerup", suppress, true);
    window.addEventListener("mouseup", suppress, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
  });
})()`;

const CANCEL_SCRIPT = `(() => { const fn = globalThis[${JSON.stringify(CLEANUP_KEY)}]; if (typeof fn === "function") fn(); })()`;

export function parsePickedMeta(raw: unknown): PickedElementMeta | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as RawPickResult;
  if (typeof data.tag !== "string" || data.tag === "") return null;
  const rect = data.rect;
  if (!rect || typeof rect.x !== "number" || typeof rect.y !== "number" || typeof rect.width !== "number" || typeof rect.height !== "number") return null;
  const nums = [rect.x, rect.y, rect.width, rect.height];
  if (!nums.every((n) => Number.isFinite(n) && n >= 0)) return null;
  const classes = Array.isArray(data.classes)
    ? data.classes.filter((c): c is string => typeof c === "string" && c.trim() !== "").slice(0, 5).map((c) => c.slice(0, 40))
    : [];
  return {
    tag: data.tag.slice(0, 40),
    role: typeof data.role === "string" ? data.role.slice(0, 40) : "",
    id: typeof data.id === "string" ? data.id.slice(0, 80) : "",
    classes,
    name: typeof data.name === "string" ? data.name.slice(0, 80) : "",
    text: typeof data.text === "string" ? data.text.slice(0, 120) : "",
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
  };
}

export function cropRectForElement(
  rect: PickedElementRect,
  view: { width: number; height: number },
  zoom: number,
): PickedElementRect | null {
  const vw = Math.floor(view.width);
  const vh = Math.floor(view.height);
  if (vw <= 0 || vh <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const pad = Math.round(CROP_PAD_CSS * scale);
  const x = Math.max(0, Math.floor(rect.x * scale) - pad);
  const y = Math.max(0, Math.floor(rect.y * scale) - pad);
  const right = Math.min(vw, Math.ceil((rect.x + rect.width) * scale) + pad);
  const bottom = Math.min(vh, Math.ceil((rect.y + rect.height) * scale) + pad);
  const width = right - x;
  const height = bottom - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

async function captureCropped(contents: WebContents, rect: PickedElementRect, view: { width: number; height: number }): Promise<string | null> {
  const crop = cropRectForElement(rect, view, contents.getZoomFactor());
  if (crop === null) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((done) => { timer = setTimeout(() => done(null), CAPTURE_MS); });
  try {
    const image = await Promise.race([contents.capturePage(crop).catch(() => null), late]);
    if (image === null || image.isEmpty()) return null;
    const size = image.getSize();
    const out = size.width > MAX_CAPTURE_WIDTH ? image.resize({ width: MAX_CAPTURE_WIDTH }) : image;
    return out.toDataURL();
  } finally {
    clearTimeout(timer);
  }
}

export interface ActivePick {
  cancel: () => void;
}

/**
 * Starts a one-shot element pick on `contents`. Returns the picked element (with cropped PNG) or
 * null when cancelled, navigated away, or the tab closes.
 */
export function startElementPick(
  contents: WebContents,
  info: { address: string; title: string; bounds: () => { width: number; height: number } },
): { promise: Promise<PickedBrowserElement | null>; cancel: () => void } {
  let cancelled = false;
  let settle: ((value: PickedBrowserElement | null) => void) | null = null;

  const stop = () => {
    contents.off("did-start-navigation", onNavigate);
    contents.off("destroyed", cancel);
    contents.off("render-process-gone", cancel);
  };

  const finish = (value: PickedBrowserElement | null) => {
    stop();
    const done = settle;
    settle = null;
    done?.(value);
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (!contents.isDestroyed()) {
      void contents.executeJavaScriptInIsolatedWorld(PICK_WORLD, [{ code: CANCEL_SCRIPT }]).catch(() => {});
    }
    finish(null);
  };

  const onNavigate = (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame) cancel();
  };

  contents.on("did-start-navigation", onNavigate);
  contents.on("destroyed", cancel);
  contents.on("render-process-gone", cancel);

  const promise = new Promise<PickedBrowserElement | null>((resolve) => {
    settle = resolve;
    if (contents.isDestroyed()) {
      finish(null);
      return;
    }
    void contents.executeJavaScriptInIsolatedWorld(PICK_WORLD, [{ code: PICKER_SCRIPT }]).then(async (raw) => {
      if (cancelled || contents.isDestroyed()) {
        finish(null);
        return;
      }
      const meta = parsePickedMeta(raw);
      if (meta === null) {
        finish(null);
        return;
      }
      const imageDataUrl = await captureCropped(contents, meta.rect, info.bounds());
      if (cancelled || contents.isDestroyed()) {
        finish(null);
        return;
      }
      finish({ ...meta, address: info.address, title: info.title, imageDataUrl });
    }, () => finish(null));
  });

  return { promise, cancel };
}

// allow: SIZE_OK - the overlay's drawing and cleanup share its terminal and renderer state.
import type { IDisposable, Terminal } from "@xterm/xterm";
import { terminalDrawsPictures } from "../terminalImages.ts";
import { followLateFaces, glyphFit, iconScale, oversizedIcon } from "../terminalGlyphs.ts";
import { readableColor } from "../terminalFold.ts";
import { isBoxGlyph } from "../terminalBoxGlyphs.ts";
import { requestShownFrame } from "../shownFrame.ts";
import { VIEW_MOVED_EVENT } from "./viewMoved.ts";
import { GhosttyVt, STYLE_BOLD, STYLE_FAINT, STYLE_INVERSE, STYLE_INVISIBLE, STYLE_ITALIC, STYLE_STRIKE, STYLE_UNDERLINE_MASK, type GhosttyColors, type GhosttyImage, type GhosttyRun } from "./vt.ts";

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));

export interface GhosttyOverlay { dispose(): void }

export function newLines(before: readonly string[], after: readonly string[]): string[] {
  const rows = after.length;
  let best = 0;
  let bestMatches = -1;
  for (let shift = 0; shift < rows; shift++) {
    let matches = 0;
    for (let y = 0; y + shift < rows; y++) if (after[y] && before[y + shift] === after[y]) matches++;
    if (matches > bestMatches) { best = shift; bestMatches = matches; }
  }
  return after.filter((line, y) => line && (y >= rows - best || before[y + best] !== line));
}

const PRIVATE_USE = /[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/u;
const POWERLINE = /^[\ue0b0-\ue0d7]$/u;
/** Powerline glyphs xterm draws in their own colour whatever the contrast (its isPowerlineGlyph) */
const POWERLINE_GLYPH = /^[\ue0a4-\ue0d6]$/u;
const MEASURED_MAX = 4096;

const latin1 = new TextDecoder("latin1");
export function hasXtermPicture(data: string | Uint8Array): boolean {
  const text = typeof data === "string" ? data : latin1.decode(data);
  return text.includes("\x1b]1337;File=") || text.includes("\x1b]1337;MultipartFile=") || /\x1bP[0-9;]*q/.test(text);
}

export function xtermPictureScanner(): (data: string | Uint8Array) => boolean {
  let tail = "";
  return (data) => {
    const text = tail + (typeof data === "string" ? data : latin1.decode(data));
    tail = text.slice(-64);
    return hasXtermPicture(text);
  };
}

const VIEW_REPAINT_MS = 1000;
const VIEW_GESTURES = ["wheel", "touchmove", VIEW_MOVED_EVENT];

const ANNOUNCED_LINES = 20;

interface XtermRowRenderer { renderRows(start: number, end: number): void }

type BufferPoint = readonly [x: number, y: number];
interface XtermRenderService {
  _renderer?: { value?: XtermRowRenderer };
  _selectionState?: { start?: BufferPoint; end?: BufferPoint; columnSelectMode?: boolean };
  handleSelectionChanged?: (start?: BufferPoint, end?: BufferPoint, columnSelectMode?: boolean) => void;
}

function xtermRenderService(term: Terminal): XtermRenderService | null {
  return (term as unknown as { _core?: { _renderService?: XtermRenderService } })._core?._renderService ?? null;
}

/** xterm's DOM renderer, which writes its rows; xterm.js has no public way to stop it drawing */
function xtermRowRenderer(term: Terminal): XtermRowRenderer | null {
  const renderer = xtermRenderService(term)?._renderer?.value;
  return renderer && typeof renderer.renderRows === "function" ? renderer : null;
}

interface Selection { readonly start: BufferPoint; readonly end: BufferPoint; readonly column: boolean }

function selectedColumns(selection: Selection | null, line: number, cols: number): readonly [number, number] | null {
  if (!selection) return null;
  const { start, end, column } = selection;
  if (line < Math.min(start[1], end[1]) || line > Math.max(start[1], end[1])) return null;
  const [from, to] = column
    ? [Math.min(start[0], end[0]), Math.max(start[0], end[0])]
    : [line === start[1] ? start[0] : 0, line === end[1] ? end[0] : cols];
  return to > from ? [from, to] : null;
}

/**
 * xterm's cell in device pixels, which follows the font alone, or null before it measured one. While its renderer is
 * paused (out of view) xterm tells a resize at once but resizes its screen later, from an idle task, so the screen
 * measured then is the old grid's. Under the chat lens the pane sits in a `content-visibility: hidden` subtree, where
 * the browser skips ResizeObserver, so nothing measured the screen again: the old screen over the new columns stuck (#3366).
 */
function xtermDeviceCell(term: Terminal): { width: number; height: number } | null {
  const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { device?: { cell?: { width: number; height: number } } } } } })._core;
  const cell = core?._renderService?.dimensions?.device?.cell;
  return cell && cell.width > 0 && cell.height > 0 ? cell : null;
}

const XTERM_ANSI = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];

function themeColors(term: Terminal): GhosttyColors {
  const theme = term.options.theme ?? {};
  const ansi = [theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white,
    theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow, theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite]
    .map((color, index) => color || XTERM_ANSI[index]!);
  return { foreground: theme.foreground ?? "#d4d4d4", background: theme.background ?? "#1e1e1e", cursor: theme.cursor ?? theme.foreground ?? "#d4d4d4", ansi };
}

export async function attachGhosttyOverlay(term: Terminal, host: HTMLElement, takeBacklog: () => (string | Uint8Array)[] | null): Promise<GhosttyOverlay | null> {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) throw new Error("ghostty overlay: the terminal is not open");
  const vt = await GhosttyVt.create(term.cols, term.rows);
  const backlog = takeBacklog();
  const pictureIn = xtermPictureScanner();
  if (!backlog || (terminalDrawsPictures(term) && backlog.some(pictureIn))) {
    vt.dispose();
    return null;
  }
  let disposed = false;
  const layer = document.createElement("div");
  layer.className = "ghostty-layer";
  const below = document.createElement("div");
  below.className = "ghostty-images";
  const text = document.createElement("div");
  text.className = "ghostty-text";
  const above = document.createElement("div");
  above.className = "ghostty-images is-above";
  const cursor = document.createElement("div");
  cursor.className = "ghostty-cursor";
  for (const decoration of [below, above, cursor]) decoration.setAttribute("aria-hidden", "true");
  const announcer = document.createElement("div");
  announcer.className = "visually-hidden";
  announcer.setAttribute("aria-live", "polite");
  layer.append(below, text, above, cursor, announcer);
  screen.append(layer);

  let rowEls: HTMLDivElement[] = [];
  let rowText: string[] = [];
  let primed = false;
  let written = false;
  // on herdr's own server xterm keeps no history: a wheel or a swipe scrolls herdr's screen, which comes back as
  // written bytes (TerminalViewportTools.tsx). Frames until a moment after the gesture tell nothing
  let viewMovedUntil = 0;
  const viewMoved = (): void => { if (!term.options.scrollback) viewMovedUntil = performance.now() + VIEW_REPAINT_MS; };
  let bottomText: string[] = [];
  // what each row shows: libghostty hands over only the rows that changed, so fresh row elements are refilled from it
  let rowHtml: string[] = [];
  const rowRuns: GhosttyRun[][] = [];
  let cellW = 0;
  let cellH = 0;
  let cancelFrame: (() => void) | null = null;
  const decoded = new Map<string, HTMLCanvasElement>();

  const metrics = (): void => {
    // the screen xterm draws for the grid it has now, rounded as its DomRenderer rounds it
    const device = xtermDeviceCell(term);
    const box = device
      ? { width: Math.round(device.width * term.cols / (window.devicePixelRatio || 1)), height: Math.round(device.height * term.rows / (window.devicePixelRatio || 1)) }
      : screen.getBoundingClientRect();
    cellW = box.width / term.cols;
    cellH = box.height / term.rows;
    const font = term.options.fontFamily ?? "monospace";
    const size = term.options.fontSize ?? 13;
    Object.assign(layer.style, { fontFamily: font, fontSize: `${size}px`, width: `${box.width}px`, height: `${box.height}px` });
    layer.style.setProperty("--ghostty-cw", `${cellW}px`);
    layer.style.setProperty("--ghostty-ch", `${cellH}px`);
    const probe = document.createElement("span");
    probe.textContent = "W".repeat(50);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;letter-spacing:0";
    text.append(probe);
    const advance = probe.getBoundingClientRect().width / 50;
    probe.remove();
    layer.style.letterSpacing = `${cellW - advance}px`;
  };

  const announce = (lines: string[]): void => {
    if (lines.length === 0) return;
    announcer.textContent = lines.slice(-ANNOUNCED_LINES).join("\n");
  };

  const rebuildRows = (): void => {
    text.textContent = "";
    rowEls = [];
    for (let y = 0; y < term.rows; y++) {
      const row = document.createElement("div");
      row.className = "ghostty-row";
      row.innerHTML = rowHtml[y] ?? "";
      text.append(row);
      rowEls.push(row);
    }
  };

  const redrawRows = (): void => {
    const selection = currentSelection();
    rowRuns.forEach((runs, y) => paintRow(y, runs, selection));
  };

  const renderService = xtermRenderService(term);
  const currentSelection = (): Selection | null => {
    const state = renderService?._selectionState;
    return state?.start && state.end ? { start: state.start, end: state.end, column: state.columnSelectMode === true } : null;
  };
  const rowSelected: string[] = [];
  const paintRow = (y: number, runs: GhosttyRun[], selection: Selection | null): boolean => {
    const row = rowEls[y];
    if (!row) return false;
    const selected = selectedColumns(selection, term.buffer.active.viewportY + y, term.cols);
    rowSelected[y] = String(selected);
    let html = "";
    for (const run of runs) html += runHtml(run, selected);
    if (rowHtml[y] === html) return false;
    row.innerHTML = html;
    rowHtml[y] = html;
    return true;
  };

  let grid = "";
  const fit = (): void => {
    metrics();
    const now = `${term.cols}x${term.rows}@${cellW}x${cellH}`;
    if (now === grid) return;
    grid = now;
    vt.resize(term.cols, term.rows, cellW, cellH);
    rowRuns.length = Math.min(rowRuns.length, term.rows);
    rebuildRows();
    redrawRows();
    schedule();
  };

  const colors = (): void => {
    const palette = themeColors(term);
    vt.setColors(palette);
    layer.style.color = palette.foreground;
    cursor.style.background = palette.cursor;
  };

  let measure: CanvasRenderingContext2D | null | undefined;
  const widths = new Map<string, number>();
  const asked = new Set<string>();
  const glyphWidth = (text: string, flags: number): number => {
    const key = `${flags & (STYLE_BOLD | STYLE_ITALIC)}${text}`;
    let width = widths.get(key);
    if (width === undefined) {
      measure ??= document.createElement("canvas").getContext("2d");
      if (!measure) return 0;
      const { fontFamily, fontSize, fontWeight, fontWeightBold } = term.options;
      measure.font = `${flags & STYLE_ITALIC ? "italic " : ""}${flags & STYLE_BOLD ? fontWeightBold ?? "bold" : fontWeight ?? "normal"} ${fontSize ?? 13}px ${fontFamily ?? "monospace"}`;
      width = measure.measureText(text).width;
      if (widths.size >= MEASURED_MAX) widths.clear();
      widths.set(key, width);
    }
    return width;
  };
  const fittedCell = ({ text, wide }: GhosttyRun["cells"][number], flags: number, glyph: string): string | null => {
    if (!wide && !PRIVATE_USE.test(text)) return null;
    if (!asked.has(text)) {
      if (asked.size >= MEASURED_MAX) asked.clear();
      asked.add(text);
      lateFaces.ask(term.options.fontFamily ?? "", text);
    }
    const width = glyphWidth(text, flags);
    const size = term.options.fontSize ?? 13;
    const own = (...css: string[]): string => [...css, glyph].filter(Boolean).join(";");
    // xterm's `span:not(.xterm-bold)` rule sets every span's weight under its screen: a bold cell's box says it is bold
    const bold = flags & STYLE_BOLD ? " xterm-bold" : "";
    if (!wide) {
      if (!oversizedIcon(text, width, cellW)) return null;
      if (POWERLINE.test(text)) return `<span class="ghostty-icon${bold}"><span class="ghostty-fit${bold}" style="${own(`transform:scaleX(${cellW / width})`, "transform-origin:0 0")}">${escapeHtml(text)}</span></span>`;
      return `<span class="ghostty-icon${bold}" style="${own(`font-size:${size * iconScale([width], cellW)}px`)}">${escapeHtml(text)}</span>`;
    }
    const fit = glyphFit(2 * cellW - width, width, cellW);
    if (!fit) return `<span class="ghostty-wide${bold}"${glyph ? ` style="${glyph}"` : ""}>${escapeHtml(text)}</span>`;
    const scale = fit.scale !== 1 ? `font-size:${size * fit.scale}px` : "";
    const stretch = fit.stretch !== 1 ? `transform:scaleX(${fit.stretch})` : "";
    return `<span class="ghostty-wide${bold}"><span class="ghostty-fit${bold}" style="${own(scale, stretch)}">${escapeHtml(text)}</span></span>`;
  };
  const lateFaces = followLateFaces(document.fonts as Iterable<FontFace> | undefined, (callback) => requestAnimationFrame(callback), () => {
    widths.clear();
    redrawRows();
  });

  const runHtml = (run: GhosttyRun, selected: readonly [number, number] | null): string => {
    if (!selected) return pieceHtml(run, false);
    const pieces: { run: GhosttyRun; inside: boolean }[] = [];
    let x = run.x;
    for (const cell of run.cells) {
      // a wide cell is selected by its first column alone, as xterm's row factory tells it and its copy takes it: a column
      // whose edge falls inside the glyph leaves the glyph out when that edge is right of the first column
      const inside = x >= selected[0] && x < selected[1];
      const last = pieces.at(-1);
      if (last?.inside === inside) last.run.cells.push(cell);
      else pieces.push({ run: { ...run, x, cells: [cell] }, inside });
      x += cell.wide ? 2 : 1;
    }
    return pieces.map((piece) => pieceHtml(piece.run, piece.inside)).join("");
  };

  const pieceHtml = (run: GhosttyRun, selected: boolean): string => {
    let fg = run.fg, bg = run.bg;
    const theme = themeColors(term);
    if (run.flags & STYLE_INVERSE) [fg, bg] = [bg ?? theme.background, fg ?? theme.foreground];
    const under = selected ? term.options.theme?.selectionBackground ?? theme.background : bg ?? theme.background;
    const drawn = fg;
    if (fg !== null || bg !== null || selected) {
      const text = fg ?? theme.foreground;
      const readable = readableColor(text, under, term.options.minimumContrastRatio ?? 1);
      if (fg !== null || readable !== text) fg = readable;
    }
    // a box, block or Powerline glyph is part of a drawing, its colour against the next one's: xterm keeps it as written
    // (treatGlyphAsBackgroundColor), and so does this layer
    const keepsColour = (text: string): boolean => fg !== drawn && (isBoxGlyph(text) || POWERLINE_GLYPH.test(text));
    const box = [`left:calc(var(--ghostty-cw)*${run.x})`];
    if (bg && !selected) box.push(`background:${bg}`);
    if (run.flags & STYLE_BOLD) box.push("font-weight:bold");
    const colours = (colour: string | null): string[] => {
      const css: string[] = [];
      if (colour) css.push(`color:${colour}`);
      if (run.flags & STYLE_FAINT) css.push(`color:color-mix(in srgb, ${colour ?? "currentColor"} 50%, transparent)`);
      if (run.flags & STYLE_INVISIBLE) css.push("color:transparent");
      return css;
    };
    const rest: string[] = [];
    if (run.flags & STYLE_ITALIC) rest.push("font-style:italic");
    // an underline or strikethrough takes the colour of the element that draws it: it goes with the colour
    const lines = [run.flags & STYLE_UNDERLINE_MASK ? "underline" : "", run.flags & STYLE_STRIKE ? "line-through" : ""].filter(Boolean);
    if (lines.length) rest.push(`text-decoration:${lines.join(" ")}`);
    const glyph = [...colours(fg), ...rest];
    const kept = colours(drawn ?? theme.foreground);
    let boxed = run.cells.map((cell) => fittedCell(cell, run.flags, keepsColour(cell.text) ? kept.join(";") : ""));
    const leaves = glyph.length > 0 && boxed.every((html) => html !== null);
    if (leaves) boxed = run.cells.map((cell) => fittedCell(cell, run.flags, [...(keepsColour(cell.text) ? kept : colours(fg)), ...rest].join(";")));
    let body = "";
    let plain = "";
    run.cells.forEach((cell, index) => {
      const fitted = boxed[index] ?? (keepsColour(cell.text) ? `<span style="${kept.join(";")}">${escapeHtml(cell.text)}</span>` : null);
      if (fitted) {
        if (plain) { body += escapeHtml(plain); plain = ""; }
        body += fitted;
      } else plain += cell.text;
    });
    if (plain) body += escapeHtml(plain);
    return `<span style="${(leaves ? box : [...box, ...glyph]).join(";")}">${body}</span>`;
  };

  const picture = (image: GhosttyImage): HTMLCanvasElement | null => {
    const key = `${image.id}:${image.generation}`;
    let source = decoded.get(key);
    if (!source) {
      const pixels = vt.imagePixels(image.id);
      if (!pixels) return null;
      for (const old of decoded.keys()) if (old.startsWith(`${image.id}:`)) decoded.delete(old);
      source = document.createElement("canvas");
      source.width = pixels.width;
      source.height = pixels.height;
      source.getContext("2d")?.putImageData(pixels, 0, 0);
      decoded.set(key, source);
    }
    return source;
  };

  const drawImages = (images: GhosttyImage[]): void => {
    below.textContent = "";
    above.textContent = "";
    const live = new Set(images.map((image) => `${image.id}:${image.generation}`));
    for (const key of decoded.keys()) if (!live.has(key)) decoded.delete(key);
    for (const image of [...images].sort((a, b) => a.z - b.z)) {
      const source = picture(image);
      if (!source || image.width === 0 || image.height === 0) continue;
      const scale = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.className = "ghostty-image";
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      Object.assign(canvas.style, {
        left: `${image.col * cellW + image.offsetX}px`, top: `${image.row * cellH + image.offsetY}px`,
        width: `${image.width}px`, height: `${image.height}px`,
      });
      const { x, y, width, height } = image.source;
      canvas.getContext("2d")?.drawImage(source, x, y, width || source.width, height || source.height, 0, 0, canvas.width, canvas.height);
      (image.layer === 2 ? above : below).append(canvas);
    }
  };

  let options: unknown[] = [];
  const optionsChanged = (): boolean => {
    const now = [term.options.fontFamily, term.options.fontSize, term.options.theme, term.options.scrollback];
    if (now.every((value, index) => value === options[index])) return false;
    options = now;
    return true;
  };

  const draw = (): void => {
    if (disposed) return;
    try {
      drawFrame();
    } catch (error) {
      console.warn("libghostty stopped drawing this terminal; xterm draws it", error);
      overlay.dispose();
    }
  };

  const drawFrame = (): void => {
    if (optionsChanged()) {
      widths.clear();
      asked.clear();
      grid = "";
      colors();
      vt.setScrollback(term.options.scrollback ?? 0);
      fit();
    }
    const buffer = term.buffer.active;
    vt.scrollFromBottom(buffer.baseY - buffer.viewportY);
    const selection = currentSelection();
    const changed = vt.frame((y, runs) => {
      if (!rowEls[y]) return;
      rowRuns[y] = runs;
      if (!paintRow(y, runs, selection)) return;
      rowText[y] = runs.map((run) => run.cells.map((cell) => cell.text).join("")).join("").trimEnd();
    });
    rowRuns.forEach((runs, y) => {
      if (rowSelected[y] !== String(selectedColumns(selection, buffer.viewportY + y, term.cols))) paintRow(y, runs, selection);
    });
    if (buffer.viewportY === buffer.baseY) {
      const screenText = rowText.slice(0, term.rows);
      const before = Array.from({ length: term.rows }, (_, y) => bottomText[bottomText.length - term.rows + y] ?? "");
      if (primed && written && performance.now() >= viewMovedUntil) announce(newLines(before, screenText));
      if (written) primed = true;
      written = false;
      bottomText = screenText;
    }
    if (changed) {
      const c = vt.cursor();
      Object.assign(cursor.style, c.visible
        ? { display: "block", left: `${c.x * cellW}px`, top: `${c.y * cellH + (c.style === 2 ? cellH - 2 : 0)}px`, width: `${c.style === 0 ? 2 : cellW}px`, height: `${c.style === 2 ? 2 : cellH}px` }
        : { display: "none" });
    }
    const images = vt.placedImages();
    if (images) drawImages(images);
    if (host.hasAttribute("data-folded")) {
      if (muted) { unmuteXtermRows(); term.refresh(0, term.rows - 1); }
    } else muteXtermRows();
  };

  const schedule = (): void => {
    if (cancelFrame !== null || disposed) return;
    cancelFrame = requestShownFrame(() => {
      cancelFrame = null;
      draw();
    });
  };
  const cancelPaint = (): void => { cancelFrame?.(); };

  const write = term.write.bind(term);
  term.write = ((data: string | Uint8Array, callback?: () => void) => {
    // libghostty takes Kitty pictures but not iTerm2 or sixel ones: when xterm draws one (Pictures in the terminal),
    // its cursor moves past the picture and libghostty's would not, so the text after it would sit on other rows.
    // xterm draws the pane from that picture on (#2980)
    if (!disposed && pictureIn(data) && terminalDrawsPictures(term)) overlay.dispose();
    if (!disposed) {
      try {
        vt.write(data);
        written = true;
      } catch (error) {
        console.warn("libghostty stopped drawing this terminal; xterm draws it", error);
        overlay.dispose();
      }
    }
    write(data, callback);
  }) as Terminal["write"];
  const reset = term.reset.bind(term);
  term.reset = () => {
    if (!disposed) {
      vt.reset();
      decoded.clear();
    }
    reset();
  };

  try {
    optionsChanged();
    colors();
    vt.setScrollback(term.options.scrollback ?? 0);
    fit();
    for (const chunk of backlog) vt.write(chunk);
    written = backlog.length > 0;
  } catch (error) {
    disposed = true;
    cancelPaint();
    term.write = write;
    term.reset = reset;
    lateFaces.stop();
    layer.remove();
    vt.dispose();
    throw error;
  }
  const refit = (): void => {
    if (disposed) return;
    try {
      fit();
    } catch (error) {
      console.warn("libghostty stopped drawing this terminal; xterm draws it", error);
      overlay.dispose();
    }
  };
  const subscriptions: IDisposable[] = [
    term.onResize(refit),
    term.onRender(() => schedule()),
    term.onScroll(() => schedule()),
  ];
  // xterm redraws its selection on every step of a drag, and tells onSelectionChange only at the release
  const handleSelectionChanged = renderService?.handleSelectionChanged;
  if (renderService && handleSelectionChanged) {
    renderService.handleSelectionChanged = (start, end, columnSelectMode) => {
      handleSelectionChanged.call(renderService, start, end, columnSelectMode);
      schedule();
    };
  }
  for (const gesture of VIEW_GESTURES) host.addEventListener(gesture, viewMoved, { capture: true, passive: true });
  const screenResize = new ResizeObserver(refit);
  screenResize.observe(screen);

  let muted: { renderer: XtermRowRenderer; renderRows: XtermRowRenderer["renderRows"] } | null = null;
  const muteXtermRows = (): void => {
    const renderer = xtermRowRenderer(term);
    if (!renderer || muted?.renderer === renderer) return;
    unmuteXtermRows();
    muted = { renderer, renderRows: renderer.renderRows };
    renderer.renderRows = () => {};
  };
  const unmuteXtermRows = (): void => {
    if (!muted) return;
    muted.renderer.renderRows = muted.renderRows;
    muted = null;
  };
  muteXtermRows();

  host.dataset["renderer"] = "ghostty";
  const overlay: GhosttyOverlay = {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelPaint();
      delete host.dataset["renderer"];
      unmuteXtermRows();
      term.refresh(0, term.rows - 1);
      term.write = write;
      term.reset = reset;
      for (const subscription of subscriptions) subscription.dispose();
      if (renderService && handleSelectionChanged) renderService.handleSelectionChanged = handleSelectionChanged;
      screenResize.disconnect();
      for (const gesture of VIEW_GESTURES) host.removeEventListener(gesture, viewMoved, { capture: true });
      lateFaces.stop();
      layer.remove();
      decoded.clear();
      vt.dispose();
    },
  };
  return overlay;
}

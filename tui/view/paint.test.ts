import { afterAll, describe, expect, test } from "bun:test";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal } from "@xterm/xterm";
import type { LayoutNode } from "../../server/herdr-core/layout-doc.ts";
import { createEmulator } from "../emulator/ghostty.ts";
import type { Emulator, EngineEvents, WrittenColor } from "../emulator/index.ts";
import { placeholderChrome } from "./chrome.ts";
import { cellsOf, holds, regions, within, type Rect } from "./geometry.ts";
import { PaneGrid } from "./grid.ts";
import { Painter, type Frame, type HitTarget, type Part, type PaneScene, type Scene } from "./paint.ts";

// The painter's writes are replayed into a second emulator standing in for the host terminal: after a frame whose write was
// taken whole, the host's screen must equal the painter's model cell for cell, and its cursor must be where the rule says.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const made: Emulator[] = [];
afterAll(() => {
  for (const emulator of made) emulator.dispose();
});

async function emulator(cols: number, rows: number, events: EngineEvents = {}): Promise<Emulator> {
  const result = await createEmulator({ cols, rows, events });
  if (!result.ok) throw new Error(`emulator ${cols}x${rows}: ${result.error.message}`);
  made.push(result.value);
  return result.value;
}

function feed(target: Emulator, bytes: string | Uint8Array): void {
  const result = target.write(typeof bytes === "string" ? encoder.encode(bytes) : bytes);
  if (!result.ok) throw new Error(`write: ${result.error.message}`);
}

/** a host as the screen leaves it after start: on the alternate screen */
async function hostOf(cols: number, rows: number): Promise<Emulator> {
  const host = await emulator(cols, rows);
  feed(host, "\x1b[?1049h");
  return host;
}

interface Cell { text: string; width: number; fg: WrittenColor | null; bg: WrittenColor | null; flags: number }

function hostCells(host: Emulator, cols: number, rows: number): Cell[] {
  const cells: Cell[] = Array.from({ length: cols * rows }, () => ({ text: " ", width: 1, fg: null, bg: null, flags: 0 }));
  const drawn = host.frameAll((y, runs) => {
    for (const run of runs) {
      let x = run.x;
      for (const cell of run.cells) {
        if (x >= cols || y >= rows) break;
        cells[y * cols + x] = { text: cell.text, width: cell.wide ? 2 : 1, fg: run.fg, bg: run.bg, flags: run.flags };
        if (cell.wide && x + 1 < cols) cells[y * cols + x + 1] = { text: "", width: 0, fg: run.fg, bg: run.bg, flags: run.flags };
        x += cell.wide ? 2 : 1;
      }
    }
  });
  if (!drawn.ok) throw new Error(drawn.error.message);
  return cells;
}

function modelCells(painter: Painter): Cell[] {
  const grid = painter.screen;
  return grid.text.map((text, i) => ({ text, width: grid.width[i]!, ...painter.styles.get(grid.style[i]!) }));
}

/** the first cell where the host and the model differ, or null */
function mismatch(host: Emulator, painter: Painter): string | null {
  const { cols, rows } = painter.screen;
  const seen = hostCells(host, cols, rows);
  const want = modelCells(painter);
  for (let i = 0; i < want.length; i++) {
    if (JSON.stringify(seen[i]) !== JSON.stringify(want[i])) {
      return `cell ${i % cols},${Math.floor(i / cols)}: host ${JSON.stringify(seen[i])} model ${JSON.stringify(want[i])}`;
    }
  }
  return null;
}

/** where the host's cursor is: a hidden one is shown for a moment to read its place, then hidden again */
function hostCursor(host: Emulator): { col: number; row: number; visible: boolean; shape: string; blinking: boolean } {
  const read = () => {
    host.frameAll(() => {});
    const cursor = host.cursorState();
    if (!cursor.ok) throw new Error(cursor.error.message);
    return cursor.value;
  };
  const cursor = read();
  if (cursor.visible) return { col: cursor.x, row: cursor.y, visible: true, shape: cursor.style, blinking: cursor.blinking };
  feed(host, "\x1b[?25h");
  const parked = read();
  feed(host, "\x1b[?25l");
  read();
  return { col: parked.x, row: parked.y, visible: false, shape: "block", blinking: false };
}

function expectReplay(host: Emulator, painter: Painter, frame: Frame): void {
  expect(mismatch(host, painter)).toBeNull();
  const cursor = hostCursor(host);
  if (frame.cursor.visible) expect(cursor).toEqual({ ...frame.cursor });
  else expect({ ...cursor, shape: "block", blinking: false }).toEqual({ ...frame.cursor });
}

/** the cells a write addresses, read from its own moves and text (each grapheme takes the model's width at its place) */
function addressed(bytes: Uint8Array, painter: Painter): Set<string> {
  const grid = painter.screen;
  const out = new Set<string>();
  const text = decoder.decode(bytes);
  let row = 0;
  let col = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x18") { i++; continue; }
    if (text[i] === "\x1b") {
      const match = /^\x1b\[([0-9;:? ]*)([A-Za-z])/.exec(text.slice(i, i + 64));
      if (!match) throw new Error(`unknown sequence at ${i}`);
      if (match[2] === "H") {
        const [r = "1", c = "1"] = match[1]!.split(";");
        row = Number(r) - 1;
        col = Number(c) - 1;
      }
      i += match[0].length;
      continue;
    }
    let end = text.indexOf("\x1b", i);
    if (end < 0) end = text.length;
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text.slice(i, end))) {
      if (segment === "\x18") continue;
      out.add(`${col},${row}`);
      const width = grid.width[row * grid.cols + col] === 2 ? 2 : 1;
      if (width === 2) out.add(`${col + 1},${row}`);
      col += width;
    }
    i = end;
  }
  return out;
}

/** non-ASCII graphemes of a write that are followed by anything but an absolute move (or the write's end) */
function unplaced(bytes: Uint8Array): string[] {
  const text = decoder.decode(bytes);
  const out: string[] = [];
  for (const chunk of text.matchAll(/[^\x1b\x18]+/g)) {
    const after = text.slice(chunk.index + chunk[0].length);
    const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(chunk[0])];
    for (const [i, { segment }] of parts.entries()) {
      if (/^[\x20-\x7e]$/.test(segment)) continue;
      if (i < parts.length - 1 || !/^(?:\x1b\[\d+;\d+H|$)/.test(after)) out.push(segment);
    }
  }
  return out;
}

/** the SGR sequences a full frame needs: one per change of style in writing order, and a reset after a styled last cell */
function styleChanges(painter: Painter): number {
  const grid = painter.screen;
  let changes = 0;
  let last = -1;
  for (let i = 0; i < grid.text.length; i++) {
    if (grid.width[i] === 0) continue;
    if (grid.style[i] !== last) changes++;
    last = grid.style[i]!;
  }
  return changes + (last > 0 ? 1 : 0);
}

interface Shown { emulator: Emulator; grid: PaneGrid; held: { hold: boolean } }

async function shownPane(painter: Painter, cols: number, rows: number, text = ""): Promise<Shown> {
  const held = { hold: false };
  const target = await emulator(cols, rows, { onHold: (hold) => { held.hold = hold; } });
  if (text) feed(target, text);
  const shown = { emulator: target, grid: new PaneGrid(painter.styles, cols, rows), held };
  copy(shown);
  return shown;
}

function copy(shown: Shown): void {
  const result = shown.grid.copy(shown.emulator, shown.grid.allDirty);
  if (!result.ok) throw new Error(result.error.message);
}

function paneScene(id: string, shown: Shown, rect: Rect, extra: Partial<PaneScene> = {}): PaneScene {
  return { id, rect, grid: shown.grid, live: true, hold: shown.held.hold, scrolledBack: false, ...extra };
}

/** one frame: the write handed to the host whole, or only its first `cut` bytes */
function step(painter: Painter, host: Emulator | null, scene: Scene, cut?: number): Frame {
  const frame = painter.paint(scene);
  if (cut === undefined) {
    if (host && frame.bytes.length > 0) feed(host, frame.bytes);
    painter.taken(true);
  } else {
    if (host) feed(host, frame.bytes.subarray(0, cut));
    painter.taken(false);
  }
  return frame;
}

const overlay = (key: string, rect: Rect, text: string): Part => ({
  key, rect, version: 0,
  draw: (canvas) => {
    canvas.fill(canvas.style({ bg: 236 }));
    canvas.print(rect.x + 1, rect.y, text, canvas.style({ fg: 15, bg: 236, flags: 1 }));
    canvas.hit({ x: rect.x + 1, y: rect.y, width: Math.min(rect.width - 1, 4), height: 1 }, "close");
  },
});

const scene = (width: number, height: number, rest: Partial<Scene>): Scene => ({ width, height, parts: [], panes: [], overlays: [], focus: null, input: null, ...rest });

const LINES = [
  "\x1b[1;1H\x1b[31mred\x1b[0m plain \x1b[38;5;208m256\x1b[0m \x1b[38;2;10;200;30mtrue\x1b[0m \x1b[1;4:3mbold-curly\x1b[0m",
  "\x1b[2;1H한글 테스트 漢字 \x1b[7minverse\x1b[0m \x1b[48;5;24m bg \x1b[0m",
  "\x1b[3;1He\u0301 \u{1F469}\u200D\u{1F4BB} \u2764\uFE0F \x1b[9;53mstrike-over\x1b[0m",
].join("");

describe("the frame painter", () => {
  test("replay equals model", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [100, 20];
    const shape = regions(W, H, { sidebar: 18, tabBar: true, modeBar: true });
    const tree: LayoutNode = { split: "right", ratio: 0.5, first: { leaf: "a" }, second: { leaf: "b" } };
    const { panes } = cellsOf(tree, shape.panes);
    const [a, b] = await Promise.all(panes.map((cells) => shownPane(painter, cells.cols, cells.rows, LINES)));
    const host = await hostOf(W, H);
    const build = (overlays: Part[]): Scene => scene(W, H, {
      parts: placeholderChrome(shape, panes), overlays, focus: "a",
      panes: [paneScene("a", a!, panes[0]!.inner), paneScene("b", b!, panes[1]!.inner)],
    });
    const help = overlay("help", { x: 30, y: 6, width: 30, height: 5 }, "도움말 help ✓");

    let frame = step(painter, host, build([help]));
    expect(frame.full).toBe(true);
    expectReplay(host, painter, frame);

    feed(a!.emulator, "\x1b[4;1Hmore 한 line\r\n".repeat(30));
    copy(a!);
    frame = step(painter, host, build([help]));
    expect(frame.full).toBe(false);
    expect(frame.bytes.length).toBeGreaterThan(0);
    expectReplay(host, painter, frame);

    frame = step(painter, host, build([]));
    expectReplay(host, painter, frame);

    feed(b!.emulator, "\x1b[2J\x1b[5;3H\x1b[42m카드 \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\x1b[0m");
    copy(b!);
    frame = step(painter, host, build([]));
    expectReplay(host, painter, frame);
  });

  test("diff equals full", async () => {
    const [W, H] = [70, 14];
    const steps = [
      LINES,
      "\x1b[5;5H\x1b[33mchanged 한\x1b[0m",
      "\x1b[1;1H\x1b[2K\x1b[1;40H\u{1F469}\u200D\u{1F4BB}e\u0301",
      "\r\n".repeat(20) + "scrolled \u2764\uFE0F",
      "\x1b[3;3H\x1b[38;2;1;2;3;48;5;200mx\x1b[0m\x1b[?25l",
      "\x1b[?25h\x1b[6;10H\x1b[5 q",
    ];
    const painter = new Painter({ sync: true });
    const host = await hostOf(W, H);
    const shown = await shownPane(painter, 52, 14);
    for (const [i, bytes] of steps.entries()) {
      feed(shown.emulator, bytes);
      copy(shown);
      const now = scene(W, H, { focus: "p", panes: [paneScene("p", shown, { x: 10, y: 1, width: 50, height: 12 }, { view: { col: 1, row: 2 } })] });
      const frame = step(painter, host, now);
      expectReplay(host, painter, frame);
      // the same state drawn from nothing, by a new painter on a new host, every cell written
      const fresh = new Painter({ sync: true }, painter.styles);
      const freshHost = await hostOf(W, H);
      const whole = step(fresh, freshHost, now);
      expect(whole.full).toBe(true);
      expect(hostCells(host, W, H)).toEqual(hostCells(freshHost, W, H));
      expect(hostCursor(host)).toEqual(hostCursor(freshHost));
      if (i > 0) expect(frame.bytes.length).toBeLessThan(whole.bytes.length);
    }
  });

  test("one bracketed write", async () => {
    for (const sync of [true, false]) {
      const painter = new Painter({ sync });
      const host = await hostOf(40, 8);
      const shown = await shownPane(painter, 30, 6, `${LINES}\x1b[2;4H`);
      const build = () => scene(40, 8, { focus: "p", panes: [paneScene("p", shown, { x: 2, y: 1, width: 30, height: 6 })] });
      const frame = step(painter, host, build());
      const text = decoder.decode(frame.bytes);
      const open = "\x1b[?2026h";
      const close = "\x1b[?2026l";
      if (sync) {
        expect(text.startsWith(`${open}\x1b[?25l`)).toBe(true);
        expect(text.endsWith(`\x1b[?25h${close}`)).toBe(true);
        expect(text.split(open).length - 1).toBe(1);
        expect(text.split(close).length - 1).toBe(1);
      } else {
        expect(text.includes("2026")).toBe(false);
        expect(text.startsWith("\x1b[?25l")).toBe(true);
        expect(text.endsWith("\x1b[?25h")).toBe(true);
      }
      // SGR only where the style changes
      expect(text.match(/\x1b\[[0-9;:]*m/g)?.length).toBe(styleChanges(painter));
      // the cursor is hidden before the first cell and shown only at the end
      expect(text.indexOf("\x1b[?25l")).toBeLessThan(text.indexOf("red"));
      expect(text.indexOf("\x1b[?25h")).toBe(text.lastIndexOf("\x1b[?25h"));
      expectReplay(host, painter, frame);

      // nothing changed: nothing is written
      expect(step(painter, host, build()).bytes.length).toBe(0);

      // only the cursor moved: one write with no cell in it
      feed(shown.emulator, "\x1b[5;9H");
      copy(shown);
      const moved = step(painter, host, build());
      const movedText = decoder.decode(moved.bytes);
      expect(movedText).toBe(`${sync ? open : ""}\x1b[?25l\x1b[6;11H\x1b[?25h${sync ? close : ""}`);
      expectReplay(host, painter, moved);
    }
  });

  test("clip", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [50, 14];
    const host = await hostOf(W, H);
    const rect = { x: 5, y: 2, width: 20, height: 8 };
    const view = { col: 6, row: 3 };
    const shown = await shownPane(painter, 40, 16, Array.from({ length: 16 }, (_, row) => `\x1b[${row + 1};1H${String.fromCharCode(65 + row).repeat(40)}`).join(""));
    const cover = { x: 15, y: 4, width: 20, height: 3 };
    const build = () => scene(W, H, {
      focus: "p", panes: [paneScene("p", shown, rect, { view })],
      parts: [{ key: "frame", rect: { x: 0, y: 0, width: W, height: H }, version: 0, draw: (canvas) => canvas.fill(canvas.style({ fg: 2 }), ":") }],
      overlays: [overlay("menu", cover, "menu")],
    });
    // the pane's own rows show through its view offset
    let frame = step(painter, host, build());
    expectReplay(host, painter, frame);
    expect(painter.screen.text[rect.y * W + rect.x]).toBe(String.fromCharCode(65 + view.row));

    // every row of the pane changes; only its cells outside the overlay may be written
    feed(shown.emulator, Array.from({ length: 16 }, (_, row) => `\x1b[${row + 1};1H${String.fromCharCode(97 + row).repeat(40)}`).join(""));
    copy(shown);
    frame = step(painter, host, build());
    const cells = addressed(frame.bytes, painter);
    expect(cells.size).toBeGreaterThan(0);
    for (const cell of cells) {
      const [col, row] = cell.split(",").map(Number) as [number, number];
      expect({ cell, inPane: holds(rect, col, row), underOverlay: holds(cover, col, row) }).toEqual({ cell, inPane: true, underOverlay: false });
    }
    expectReplay(host, painter, frame);
  });

  test("wide and combining", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [24, 6];
    const host = await hostOf(W, H);
    const text = "\x1b[1;1H한글\u{1F469}\u200D\u{1F4BB}e\u0301x\x1b[2;1Habc한글\x1b[3;1He\u0301한x";
    const left = await shownPane(painter, 12, 3, text);
    const right = await shownPane(painter, 12, 3, text);
    const leftRect = { x: 2, y: 1, width: 7, height: 3 };
    const rightRect = { x: 12, y: 1, width: 5, height: 3 };
    const build = () => scene(W, H, {
      focus: "l",
      parts: [{ key: "ground", rect: { x: 0, y: 0, width: W, height: H }, version: 0, draw: (canvas) => canvas.fill(canvas.style({ fg: 5 }), "#") }],
      panes: [paneScene("l", left, leftRect, { view: { col: 1, row: 0 } }), paneScene("r", right, rightRect)],
    });
    const frames = [step(painter, host, build())];
    const grid = painter.screen;
    const at = (col: number, row: number) => ({ text: grid.text[row * W + col], width: grid.width[row * W + col] });
    // the left clip edge cuts 한 in two: its visible half is a blank, and everything right of it is where the pane has it
    expect(at(2, 1)).toEqual({ text: " ", width: 1 });
    expect([at(3, 1), at(5, 1), at(7, 1), at(8, 1)]).toEqual([{ text: "글", width: 2 }, { text: "\u{1F469}\u200D\u{1F4BB}", width: 2 }, { text: "e\u0301", width: 1 }, { text: "x", width: 1 }]);
    expect([at(2, 2), at(3, 2), at(4, 2), at(6, 2), at(8, 2)]).toEqual([{ text: "b", width: 1 }, { text: "c", width: 1 }, { text: "한", width: 2 }, { text: "글", width: 2 }, { text: " ", width: 1 }]);
    // the right clip edge cuts the emoji: a blank, and the ground right of the pane is untouched
    expect([at(12, 1), at(14, 1), at(16, 1), at(17, 1)]).toEqual([{ text: "한", width: 2 }, { text: "글", width: 2 }, { text: " ", width: 1 }, { text: "#", width: 1 }]);
    expectReplay(host, painter, frames[0]!);
    // every wide or non-ASCII cell is followed by an absolute move, so the host's own width for it cannot shift the rest
    expect(unplaced(frames[0]!.bytes)).toEqual([]);

    // one changed cell between unchanged wide ones: the host keeps every other cell where the model has it
    feed(left.emulator, "\x1b[1;7HE\u0301");
    copy(left);
    frames.push(step(painter, host, build()));
    expect(at(7, 1)).toEqual({ text: "E\u0301", width: 1 });
    expectReplay(host, painter, frames[1]!);
    expect(unplaced(frames[1]!.bytes)).toEqual([]);

    // xterm, the browser's terminal, with its grapheme widths: the same cells and the same cursor column
    const term = new Terminal({ cols: W, rows: H, allowProposedApi: true });
    term.loadAddon(new UnicodeGraphemesAddon());
    term.unicode.activeVersion = "15-graphemes";
    try {
      for (const frame of frames) await new Promise<void>((resolve) => term.write(frame.bytes, resolve));
      const buffer = term.buffer.active;
      for (let row = 0; row < H; row++) {
        const line = buffer.getLine(row)!;
        for (let col = 0; col < W; col++) {
          const want = at(col, row);
          const cell = line.getCell(col)!;
          expect({ col, row, text: want.width === 0 ? "" : cell.getChars() || " ", width: cell.getWidth() }).toEqual({ col, row, text: want.text ?? "", width: want.width ?? -1 });
        }
      }
      const cursor = frames[1]!.cursor;
      expect({ x: buffer.cursorX, y: buffer.cursorY }).toEqual({ x: cursor.col, y: cursor.row });
    } finally {
      term.dispose();
    }
  });

  test("cursor", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [40, 12];
    const host = await hostOf(W, H);
    const shown = await shownPane(painter, 20, 6, "\x1b[2;4H\x1b[5 q");
    const rect = { x: 5, y: 2, width: 20, height: 6 };
    const frameOf = (extra: Partial<PaneScene>, rest: Partial<Scene> = {}): Record<string, unknown> => {
      const frame = step(painter, host, scene(W, H, { focus: "p", panes: [paneScene("p", shown, rect, extra)], ...rest }));
      expectReplay(host, painter, frame);
      return { ...frame.cursor };
    };
    // the focused pane's cursor through its rectangle, with the shape the program chose
    expect(frameOf({})).toEqual({ col: 8, row: 3, visible: true, shape: "bar", blinking: true });
    // hidden, and parked at the pane's last cursor cell, in a hold, when scrolled back, when not Live, under an overlay
    const parked = { col: 8, row: 3, visible: false, shape: "block", blinking: false };
    expect(frameOf({ hold: true })).toEqual(parked);
    expect(frameOf({ scrolledBack: true })).toEqual(parked);
    expect(frameOf({ live: false })).toEqual(parked);
    expect(frameOf({}, { input: "overlay" })).toEqual(parked);
    // an overlay's text field owns it
    expect(frameOf({}, { input: { col: 30, row: 10 } })).toEqual({ col: 30, row: 10, visible: true, shape: "bar", blinking: false });
    // the program hid it: hidden where it was last seen
    feed(shown.emulator, "\x1b[4;7H\x1b[?25l");
    copy(shown);
    expect(frameOf({})).toEqual(parked);
    feed(shown.emulator, "\x1b[?25h\x1b[2 q");
    copy(shown);
    expect(frameOf({})).toEqual({ col: 11, row: 5, visible: true, shape: "block", blinking: false });
    // outside the clip (the view moved it off): hidden, parked inside the pane's cells
    expect(frameOf({ view: { col: 8, row: 0 } })).toEqual({ col: 5, row: 5, visible: false, shape: "block", blinking: false });
    // no focused pane: hidden where it was
    expect(step(painter, host, scene(W, H, { panes: [paneScene("p", shown, rect)] })).cursor.visible).toBe(false);
  });

  test("baseline", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [60, 10];
    const host = await hostOf(W, H);
    const shown = await shownPane(painter, 40, 8, LINES);
    const build = () => scene(W, H, {
      focus: "p", panes: [paneScene("p", shown, { x: 10, y: 1, width: 40, height: 8 })],
      parts: [{ key: "side", rect: { x: 0, y: 0, width: 10, height: H }, version: 0, draw: (canvas) => canvas.fill(canvas.style({ fg: 4 }), ".") }],
    });
    expectReplay(host, painter, step(painter, host, build()));

    // the host takes only part of the next write: it stops inside an escape sequence
    feed(shown.emulator, "\x1b[6;1H\x1b[32mnew text 한글 here\x1b[0m");
    copy(shown);
    const cutFrame = painter.paint(build());
    const cutAt = decoder.decode(cutFrame.bytes).lastIndexOf("\x1b[") + 3;
    feed(host, cutFrame.bytes.subarray(0, cutAt));
    painter.taken(false);

    // so the next frame cancels whatever was left open and writes every cell
    const frame = step(painter, host, build());
    expect(frame.full).toBe(true);
    expect(frame.bytes[0]).toBe(0x18);
    expect(addressed(frame.bytes, painter).size).toBe(W * H);
    expectReplay(host, painter, frame);

    // and after it, frames are small again
    expect(step(painter, host, build()).bytes.length).toBe(0);
  });

  test("resize", async () => {
    const painter = new Painter({ sync: true });
    const host = await hostOf(40, 12);
    const tree: LayoutNode = { split: "down", ratio: 0.5, first: { leaf: "a" }, second: { split: "right", ratio: 0.4, first: { leaf: "b" }, second: { leaf: "c" } } };
    const shown = new Map<string, Shown>();
    for (const id of ["a", "b", "c"]) shown.set(id, await shownPane(painter, 30, 10, LINES));
    const build = (W: number, H: number) => {
      const shape = regions(W, H, { sidebar: 10, tabBar: true, modeBar: true });
      const { panes } = cellsOf(tree, shape.panes);
      return scene(W, H, { focus: "a", parts: placeholderChrome(shape, panes), panes: panes.map((cells) => paneScene(cells.pane, shown.get(cells.pane)!, cells.inner)) });
    };
    expectReplay(host, painter, step(painter, host, build(40, 12)));

    for (const [W, H] of [[30, 8], [90, 30], [10, 3], [1, 1]] as const) {
      const resized = host.resize(W, H, 0, 0);
      expect(resized.ok).toBe(true);
      const frame = step(painter, host, build(W, H));
      expect(frame.full).toBe(true);
      const cells = addressed(frame.bytes, painter);
      for (const cell of cells) {
        const [col, row] = cell.split(",").map(Number) as [number, number];
        expect({ cell, inside: col < W && row < H }).toEqual({ cell, inside: true });
      }
      expect(cells.size).toBe(W * H);
      expectReplay(host, painter, frame);
    }
    const empty = painter.paint(build(0, 0));
    expect(empty.bytes.length).toBe(0);
    expect(painter.screen.text.length).toBe(0);
  });

  test("hit map", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [100, 24];
    const shape = regions(W, H, { sidebar: 20, tabBar: true, modeBar: true });
    const tree: LayoutNode = { split: "right", ratio: 0.6, first: { leaf: "a" }, second: { leaf: "b" } };
    const { panes } = cellsOf(tree, shape.panes);
    const shownPanes = await Promise.all(panes.map((cells) => shownPane(painter, cells.cols, cells.rows, LINES)));
    const parts = placeholderChrome(shape, panes);
    const menu = overlay("menu", { x: 50, y: 8, width: 30, height: 6 }, "menu");
    const build = () => scene(W, H, { focus: "a", parts, overlays: [menu], panes: panes.map((cells, i) => paneScene(cells.pane, shownPanes[i]!, cells.inner)) });
    const screen = { x: 0, y: 0, width: W, height: H };
    const drawnRect = (target: HitTarget): Rect => {
      if ("pane" in target) return panes.find(({ pane }) => pane === target.pane)!.inner;
      return [...parts, menu].find(({ key }) => key === target.part)!.rect;
    };
    const expected = (col: number, row: number): HitTarget | null => {
      if (holds(menu.rect, col, row)) return holds({ x: 51, y: 8, width: 4, height: 1 }, col, row) ? { part: "menu", id: "close" } : { part: "menu", id: "" };
      const pane = panes.find(({ inner }) => holds(inner, col, row));
      if (pane) return { pane: pane.pane };
      const part = [...parts].reverse().find(({ rect }) => holds(rect, col, row));
      if (!part) return null;
      return part.key.startsWith("border") ? { part: part.key, id: "" } : { part: part.key, id: part.key };
    };
    for (const round of [0, 1]) {
      const frame = step(painter, null, build());
      expect(frame.full).toBe(round === 0);
      for (const hit of frame.hits.hits) expect({ hit, inside: within(drawnRect(hit.target), hit.rect) && within(screen, hit.rect) }).toEqual({ hit, inside: true });
      const wrong: string[] = [];
      for (let row = 0; row < H; row++) for (let col = 0; col < W; col++) {
        if (JSON.stringify(frame.hits.at(col, row)) !== JSON.stringify(expected(col, row))) wrong.push(`${col},${row}`);
      }
      expect(wrong).toEqual([]);
    }
  });
});

describe("edges", () => {
  test("a 1x1 pane, no panes, a wide cell in the last column, a long cluster, and a pane removed between frames", async () => {
    const painter = new Painter({ sync: true });
    const [W, H] = [12, 4];
    const host = await hostOf(W, H);
    const tiny = await shownPane(painter, 1, 1, "Z");
    const marks = await shownPane(painter, 4, 1, `e${"\u0301".repeat(10_000)}x\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}`);
    const edge = await shownPane(painter, 6, 1, "abcd한");
    const all = scene(W, H, {
      focus: "t",
      panes: [paneScene("t", tiny, { x: 0, y: 0, width: 1, height: 1 }), paneScene("m", marks, { x: 2, y: 1, width: 4, height: 1 }), paneScene("e", edge, { x: 7, y: 2, width: 6, height: 1 })],
    });
    let frame = step(painter, host, all);
    expect(frame.full).toBe(true);
    expectReplay(host, painter, frame);
    expect(painter.screen.text[0]).toBe("Z");
    // the engine keeps as many of the 10 000 marks as it holds for one cell; the screen shows exactly that cluster
    expect(painter.screen.text[W + 2]).toBe(marks.grid.grid.text[0]!);
    expect(painter.screen.text[W + 2]!.startsWith("e\u0301\u0301")).toBe(true);
    // the pane reaches past the screen's last column: its wide cell there is a blank
    expect([painter.screen.text[2 * W + 11], painter.screen.width[2 * W + 11]]).toEqual([" ", 1]);

    // two panes go away: none of their cells is left
    frame = step(painter, host, scene(W, H, { focus: "t", panes: [paneScene("t", tiny, { x: 0, y: 0, width: 1, height: 1 })] }));
    expectReplay(host, painter, frame);
    expect(painter.screen.text.filter((text) => text !== " ")).toEqual(["Z"]);

    // and none at all
    frame = step(painter, host, scene(W, H, {}));
    expectReplay(host, painter, frame);
    expect(painter.screen.text.every((text) => text === " ")).toBe(true);
    expect(frame.cursor.visible).toBe(false);
  });
});

// ---- the overall proof: random scenes, every frame replayed ----

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env["PAINT_SEED"] ?? 20261117);
const SCENES = 300;

const PIECES = [
  "hello ", "world", "x", "  ", "한글", "테스트 ", "漢字", "\u{1F469}\u200D\u{1F4BB}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "\u{1F1F0}\u{1F1F7}",
  "\u{1F44D}\u{1F3FD}", "e\u0301", "a\u0308\u0323", "\u2764\uFE0F", "\u26BD\uFE0E", "\u0301", "\u{1F3FB}", "\t", "\r\n", "\n", "\x1b[K", "\x1b[1J",
  "\x1b[S", "\x1b[2T", "\x1b[L", "\x1b[P", "\x1b[3@", "\x1b[0m", "\x1b[?25l", "\x1b[?25h", "\x1b[3 q", "\x1b[6 q",
];

function randomText(next: () => number, cols: number, rows: number): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const n = (max: number) => Math.floor(next() * max);
  const color = () => {
    const kind = n(4);
    if (kind === 0) return `${30 + n(8)}`;
    if (kind === 1) return `${90 + n(8)}`;
    if (kind === 2) return `38;5;${n(256)}`;
    return `38;2;${n(256)};${n(256)};${n(256)}`;
  };
  let out = "";
  const count = 5 + n(60);
  for (let i = 0; i < count; i++) {
    const roll = next();
    if (roll < 0.12) out += `\x1b[${1 + n(rows)};${1 + n(cols)}H`;
    else if (roll < 0.22) out += `\x1b[${color()}m`;
    else if (roll < 0.28) out += `\x1b[${color().replace(/^3/, "4").replace(/^9/, "10")}m`;
    else if (roll < 0.34) out += `\x1b[${pick(["1", "2", "3", "4", "4:2", "4:3", "4:4", "4:5", "5", "7", "8", "9", "53", "21", "22", "24"])}m`;
    else if (roll < 0.36) out += "x".repeat(n(cols * 2));
    else out += pick(PIECES);
  }
  return out;
}

function randomTree(next: () => number, ids: string[]): LayoutNode {
  if (ids.length === 1) return { leaf: ids[0]! };
  const cut = 1 + Math.floor(next() * (ids.length - 1));
  return { split: next() < 0.5 ? "right" : "down", ratio: 0.2 + next() * 0.6, first: randomTree(next, ids.slice(0, cut)), second: randomTree(next, ids.slice(cut)) };
}

describe("property", () => {
  test(`replay equals model over ${SCENES} seeded random scenes (seed ${SEED})`, async () => {
    const next = random(SEED);
    const n = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
    let frames = 0;
    let checked = 0;
    let cuts = 0;
    for (let sceneNo = 0; sceneNo < SCENES; sceneNo++) {
      const painter = new Painter({ sync: next() < 0.8 });
      let [W, H] = [n(20, 200), n(6, 60)];
      const host = await hostOf(W, H);
      const ids = Array.from({ length: n(1, 6) }, (_, i) => `p${i}`);
      const tree = randomTree(next, ids);
      const chrome = { sidebar: n(0, 30), tabBar: next() < 0.7, modeBar: next() < 0.7 };
      const borders = next() < 0.6;
      const panes = new Map<string, Shown & { view: { col: number; row: number }; scrolled: boolean }>();
      const owned: Emulator[] = [host];
      const layout = () => {
        const shape = regions(W, H, chrome);
        return { shape, cells: cellsOf(tree, shape.panes, { borders }).panes };
      };
      for (const cells of layout().cells) {
        const cols = Math.max(1, cells.cols + n(-3, 6));
        const rows = Math.max(1, cells.rows + n(-2, 4));
        const shown = await shownPane(painter, cols, rows);
        owned.push(shown.emulator);
        panes.set(cells.pane, { ...shown, view: { col: 0, row: 0 }, scrolled: false });
      }
      const frameCount = n(2, 5);
      for (let f = 0; f < frameCount; f++) {
        if (f > 0 && next() < 0.2) {
          [W, H] = [n(20, 200), n(6, 60)];
          expect(host.resize(W, H, 0, 0).ok).toBe(true);
        }
        const { shape, cells } = layout();
        for (const pane of cells) {
          const shown = panes.get(pane.pane)!;
          if (next() < 0.15) {
            const cols = Math.max(1, pane.cols + n(-3, 6));
            const rows = Math.max(1, pane.rows + n(-2, 4));
            expect(shown.emulator.resize(cols, rows, 0, 0).ok).toBe(true);
            shown.grid.resize(cols, rows);
          }
          const { cols, rows } = shown.grid.grid;
          if (next() < 0.8) feed(shown.emulator, randomText(next, cols, rows));
          if (next() < 0.05) feed(shown.emulator, shown.held.hold ? "\x1b[?2026l" : "\x1b[?2026h");
          if (next() < 0.1) {
            shown.scrolled = !shown.scrolled;
            expect(shown.emulator.scrollFromBottom(shown.scrolled ? n(1, 5) : 0).ok).toBe(true);
          }
          shown.view = { col: n(0, Math.max(0, cols - pane.inner.width + 2)), row: n(0, Math.max(0, rows - pane.inner.height + 2)) };
          copy(shown);
        }
        const overlays: Part[] = next() < 0.4
          ? [overlay("o", { x: n(-5, W), y: n(-2, H), width: n(1, 40), height: n(1, 10) }, pick(next, ["도움말", "help", "\u{1F469}\u200D\u{1F4BB} menu", "e\u0301 x"]))]
          : [];
        const focus = next() < 0.9 ? ids[n(0, ids.length - 1)]! : null;
        const inputRoll = next();
        const sceneNow = scene(W, H, {
          parts: placeholderChrome(shape, cells),
          panes: cells.map((pane) => {
            const shown = panes.get(pane.pane)!;
            return paneScene(pane.pane, shown, pane.inner, { view: shown.view, scrolledBack: shown.scrolled, live: next() < 0.9 });
          }),
          overlays, focus,
          input: inputRoll < 0.85 ? null : inputRoll < 0.92 ? "overlay" : { col: n(0, W - 1), row: n(0, H - 1) },
        });
        const cut = next() < 0.12;
        const frame = painter.paint(sceneNow);
        frames++;
        if (cut) {
          cuts++;
          feed(host, frame.bytes.subarray(0, Math.floor(next() * frame.bytes.length)));
          painter.taken(false);
          continue;
        }
        if (frame.bytes.length > 0) feed(host, frame.bytes);
        painter.taken(true);
        const wrong = mismatch(host, painter);
        if (wrong) throw new Error(`seed ${SEED} scene ${sceneNo} frame ${f} (${W}x${H}): ${wrong}`);
        const cursor = hostCursor(host);
        const want = frame.cursor.visible ? frame.cursor : { ...frame.cursor };
        const seen = frame.cursor.visible ? cursor : { ...cursor, shape: "block", blinking: false };
        if (JSON.stringify(seen) !== JSON.stringify(want)) throw new Error(`seed ${SEED} scene ${sceneNo} frame ${f}: cursor ${JSON.stringify(seen)} want ${JSON.stringify(want)}`);
        checked++;
      }
      for (const target of owned) target.dispose();
    }
    console.log(`property: seed ${SEED}, ${SCENES} scenes, ${frames} frames, ${checked} replayed and equal, ${cuts} not taken whole`);
    expect(checked).toBeGreaterThan(SCENES);
  }, 600_000);
});

function pick<T>(next: () => number, list: readonly T[]): T {
  return list[Math.floor(next() * list.length)]!;
}

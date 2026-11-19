/**
 * The parity comparison (docs/tui/visual-parity.md): the screen's picture of a scene, drawn by the real loop over the
 * headless host and the fake core and read back through the same emulator herdr's captures were read through, against
 * herdr's stored capture of that scene, size and host palette (tui/testing/herdr-captures/, written only by
 * tui/testing/herdr-capture.ts).
 *
 * herdr's picture is first carried through the decisions docs/tui/visual-parity.md records (`no, recorded`) and the
 * forced one, each by name: C1 maps herdr's palette onto the screen's theme roles, C2 puts the screen's own words where
 * herdr has its words, and the others leave out the cells their difference covers. Every other cell must then be the
 * same: its text, its attributes, its background, and its foreground where a glyph shows it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { STRINGS } from "../strings.ts";
import { TUI_THEMES, type TuiColorRole } from "../theme.generated.ts";
import { place } from "./fixtures/fixture.ts";
import { backgroundAnswer, type Cell, type Cells, decodeGrid, gridText, LOOK_BOLD, LOOK_REVERSE, LOOK_STRIKE, LOOK_UNDERLINE, type PaletteName, Screen, type StoredGrid, type Written } from "./herdr-grid.ts";
import { CAPTURE_FOLDER, type PaneSpec, type Scene, type SceneKeys, WORLDS, type WorldName } from "./parity-scenes.ts";
import { Run } from "./run.ts";

/** herdr's stored picture of a scene, or null when the capture script has not written it. */
export function herdrPicture(scene: string, cols: number, rows: number, palette: PaletteName): Cells | null {
  const file = join(CAPTURE_FOLDER, `${scene}.${cols}x${rows}.json`);
  if (!existsSync(file)) return null;
  const stored = JSON.parse(readFileSync(file, "utf8")) as { dark: StoredGrid; light: StoredGrid | "dark" };
  const grid = palette === "light" && stored.light !== "dark" ? stored.light : stored.dark;
  return decodeGrid(grid);
}

/** A pane's first paint: the same lines herdr's capture program prints. */
const paintOf = (name: string): string => `${name}-READY\r\n${[1, 2, 3].map((n) => `line ${n} of ${name}\r\n`).join("")}$ `;

const SGR = (col: number, row: number, code: number, end: "M" | "m") => `\x1b[<${code};${col + 1};${row + 1}${end}`;

function find(rows: readonly string[], needle: string): { col: number; row: number } | null {
  for (let row = 0; row < rows.length; row++) {
    const col = rows[row]!.indexOf(needle);
    if (col >= 0) return { col, row };
  }
  return null;
}

/** The screen's picture of a scene: a fresh run of the world, the scene's keys, the frames it then draws. */
export async function ovisPicture(world: WorldName, scene: Scene, cols: number, rows: number, palette: PaletteName): Promise<Cells> {
  await Screen.load();
  const core = new FakeHcCore();
  const addresses = new Map<string, string>();
  for (const pane of WORLDS[world].panes) {
    const address = place(core, { space: pane.workspace, spaceName: pane.workspace, tab: `${pane.workspace}-${pane.tab}`, tabName: pane.tab, pane: pane.name }, paintOf(pane.name));
    addresses.set(pane.name, address);
    if (pane.agent && pane.state) core.reportStatus(address, { state: pane.state, app: pane.agent });
  }
  const run = await Run.start({ core, cols, rows, answerFirst: backgroundAnswer(palette) });
  try {
    if (WORLDS[world].panes.length > 0) await run.live();
    else {
      // the screen opens a workspace of its own on an empty core: its shell shows a prompt, as herdr's does
      await run.advance(200);
      for (const view of run.loop.panes.views()) core.program(view.terminal).output("$ ");
      await run.live();
    }
    if (world === "ended") {
      core.program(addresses.get("RIGHT")!).exit(0);
      await run.advance(200);
    }
    if (scene.ovis) await apply(run, scene.ovis, addresses, WORLDS[world].panes);
    await run.advance(300);
    const screen = new Screen(cols, rows);
    try {
      screen.write(run.host.output());
      return screen.cells();
    } finally {
      screen.dispose();
    }
  } finally {
    await run.close();
  }
}

async function apply(run: Run, keys: SceneKeys, addresses: ReadonlyMap<string, string>, panes: readonly PaneSpec[]): Promise<void> {
  switch (keys.kind) {
    case "type":
      run.type(keys.text);
      await run.settle();
      return;
    case "click":
    case "drag": {
      const rows = run.grid();
      const at = keys.kind === "click" ? keys.labels.map((label) => find(rows, label)).find((one) => one !== null) ?? null : find(rows, keys.over);
      if (!at) throw new Error(`nothing to point at on the screen:\n${rows.join("\n")}`);
      const to = keys.kind === "drag" ? at.col + keys.over.length - 1 : at.col + 1;
      const from = keys.kind === "drag" ? at.col : at.col + 1;
      run.type(SGR(from, at.row, 0, "M"));
      await run.settle();
      if (keys.kind === "drag") {
        run.type(SGR(to, at.row, 32, "M"));
        await run.settle();
      }
      run.type(SGR(to, at.row, 0, "m"));
      await run.settle();
      return;
    }
    case "report": {
      const agent = panes.find((pane) => pane.name === keys.pane)?.agent ?? "claude";
      run.core.reportStatus(addresses.get(keys.pane)!, { state: keys.state, app: agent });
      await run.settle();
      return;
    }
    case "viewer":
      // P6 (forced): the screen's answer to a second viewer is left out of the comparison whole
      return;
  }
}

/**
 * C1: herdr's palette (its default theme) mapped onto the screen's theme roles, one table for foregrounds and one for
 * backgrounds. A colour neither table names is a difference.
 */
const HERDR_FG: Readonly<Record<string, TuiColorRole>> = {
  "#cdd6f4": "text",
  "#a6adc8": "textDim",
  "#bac2de": "textDim",
  "#6c7086": "textDim",
  "#7f849c": "textDim",
  "#9399b2": "textDim",
  "#89b4fa": "accent",
  "#181825": "primaryText",
  "#11111b": "primaryText",
  "#1e1e2e": "border",
  "#313244": "border",
  "#45475a": "border",
  "#f38ba8": "statusBlocked",
  "#f9e2af": "statusWorking",
  "#94e2d5": "statusDone",
  "#a6e3a1": "statusDone",
  "#cba6f7": "statusWorking",
};
const HERDR_BG: Readonly<Record<string, TuiColorRole>> = {
  "#181825": "bgPanel",
  "#11111b": "bgPanel",
  "#1e1e2e": "bgElevated",
  "#313244": "bgHover",
  "#45475a": "bgHover",
  "#89b4fa": "accent",
  "#f38ba8": "statusBlocked",
  "#cba6f7": "statusWorking",
};

const hexOf = (color: Written): string | null => {
  if (color === null || typeof color === "number") return null;
  return `#${color.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};
const sameColor = (a: Written, b: Written): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * C2: herdr's words and the screen's own for the same thing (the screen keeps its words). With `shift`, what follows the
 * word on its row moves by the difference, as on the mode bar, and the cells left with no known text are holes.
 */
export interface Word { readonly herdr: string; readonly ovis: string; readonly align?: "right"; readonly shift?: true; readonly row?: number; readonly col?: number }

/**
 * A rectangle of cells a kept, owner's, part-2 or forced line covers, with that line's id. `glyph`: only the text and
 * the foreground are left out (a state's own glyph and colour, S8); the background and attributes still count. `bold`:
 * only the bold attribute is left out.
 */
export interface Hole { readonly line: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly glyph?: true; readonly bold?: true }

export interface Decisions { readonly words: readonly Word[]; readonly holes: readonly Hole[] }

export interface Difference { readonly x: number; readonly y: number; readonly what: string; readonly herdr: string; readonly ovis: string }

const describe = (cell: Cell): string => `${JSON.stringify(cell.ch)} fg=${JSON.stringify(cell.look.fg)} bg=${JSON.stringify(cell.look.bg)} flags=${cell.look.flags}`;

/** herdr's picture with C2's words in: each word of a row put in the screen's word, in the look herdr gave the word. */
function withWords(grid: Cells, words: readonly Word[]): { cells: Cell[]; holes: Hole[] } {
  const cells = [...grid.cells];
  const holes: Hole[] = [];
  /** how much of a row is known after shifted words: past it, herdr's picture says nothing of the screen's */
  const known = new Map<number, number>();
  for (let y = 0; y < grid.rows; y++) {
    for (const word of words) {
      if (word.row !== undefined && word.row !== y) continue;
      if (word.col !== undefined) {
        // a word at its place: each of its cells herdr still shows (an overlay may cover some) takes the screen's word
        const herdrChars = [...word.herdr];
        const ovisChars = [...word.ovis];
        const start = word.align === "right" ? word.col - ovisChars.length + 1 : word.col;
        const herdrStart = word.align === "right" ? word.col - herdrChars.length + 1 : word.col;
        if (herdrChars.findIndex((ch, i) => cells[y * grid.cols + herdrStart + i]?.ch === ch) < 0) continue;
        const look = cells[y * grid.cols + herdrStart + (word.herdr.startsWith(" ") ? 1 : 0)]!.look;
        const blankLook = cells[y * grid.cols + (word.align === "right" ? herdrStart - 1 : herdrStart + herdrChars.length)]?.look ?? look;
        for (let x = Math.min(start, herdrStart); x < Math.max(start + ovisChars.length, herdrStart + herdrChars.length); x++) {
          const at = y * grid.cols + x;
          const was = herdrChars[x - herdrStart] ?? " ";
          if (x < 0 || x >= grid.cols || cells[at]!.ch !== was) continue;
          const ch = ovisChars[x - start];
          cells[at] = ch === undefined ? { ch: " ", look: blankLook } : { ch, look: ch === " " ? cells[at]!.look : look };
        }
        continue;
      }
      if (word.shift) {
        const row = cells.slice(y * grid.cols, (y + 1) * grid.cols);
        const end = known.get(y) ?? grid.cols;
        const text = row.slice(0, end).map((cell) => cell.ch || "\u0000").join("");
        let at = text.indexOf(word.herdr);
        let cut = false;
        // a word herdr cut at the end of what is known of the row (the screen's edge): what follows it is not known
        for (let kept = word.herdr.length - 1; at < 0 && kept >= 1; kept--) {
          if (text.endsWith(` ${word.herdr.slice(0, kept)}`)) {
            at = end - kept;
            cut = true;
          }
        }
        if (at < 0) continue;
        const look = row[at]!.look;
        const next = [...row.slice(0, at), ...[...word.ovis].map((ch) => ({ ch, look })), ...(cut ? [] : row.slice(at + word.herdr.length, end))];
        known.set(y, Math.min(grid.cols, next.length));
        while (next.length < grid.cols) next.push({ ch: " ", look: row[grid.cols - 1]!.look });
        for (let x = 0; x < grid.cols; x++) cells[y * grid.cols + x] = next[x]!;
        continue;
      }
      const text = cells.slice(y * grid.cols, (y + 1) * grid.cols).map((cell) => cell.ch || "\u0000").join("");
      const at = text.indexOf(word.herdr);
      if (at < 0) continue;
      const look = cells[y * grid.cols + at]!.look;
      const after = cells[y * grid.cols + at + word.herdr.length]?.look ?? look;
      const start = word.align === "right" ? at + word.herdr.length - word.ovis.length : at;
      const span = [...word.ovis];
      for (let x = Math.min(start, at); x < Math.max(start + span.length, at + word.herdr.length); x++) {
        if (x < 0 || x >= grid.cols) continue;
        const inWord = x >= start && x < start + span.length;
        cells[y * grid.cols + x] = inWord ? { ch: span[x - start]!, look } : { ch: " ", look: word.align === "right" ? cells[y * grid.cols + x]!.look : after };
      }
    }
  }
  for (const [y, end] of known) if (end < grid.cols) holes.push({ line: "C2", x: end, y, width: grid.cols - end, height: 1 });
  return { cells, holes };
}

/** Every cell where the screen's picture differs from herdr's carried through the decisions; empty: the same. */
export function compare(herdr: Cells, ovis: Cells, palette: PaletteName, decisions: Decisions): Difference[] {
  const theme = TUI_THEMES[palette];
  const { cells: expected, holes: shifted } = withWords(herdr, decisions.words);
  const held = new Map<number, "all" | "glyph">();
  const unbold = new Set<number>();
  const cover = (hole: Omit<Hole, "line">, how: (i: number) => void) => {
    for (let y = Math.max(0, hole.y); y < Math.min(herdr.rows, hole.y + hole.height); y++) {
      for (let x = Math.max(0, hole.x); x < Math.min(herdr.cols, hole.x + hole.width); x++) how(y * herdr.cols + x);
    }
  };
  for (const hole of [...decisions.holes, ...shifted]) cover(hole, (i) => {
    if (hole.bold) unbold.add(i);
    else if (held.get(i) !== "all") held.set(i, hole.glyph ? "glyph" : "all");
  });
  const out: Difference[] = [];
  for (let i = 0; i < expected.length; i++) {
    const hold = held.get(i);
    if (hold === "all") continue;
    const want = expected[i]!;
    const got = ovis.cells[i]!;
    const x = i % herdr.cols;
    const y = Math.floor(i / herdr.cols);
    const differ = (what: string) => out.push({ x, y, what, herdr: describe(want), ovis: describe(got) });
    if (hold !== "glyph" && want.ch !== got.ch) { differ("text"); continue; }
    const blank = (want.ch === " " || want.ch === "") && (want.look.flags & (LOOK_UNDERLINE | LOOK_REVERSE | LOOK_STRIKE)) === 0;
    // on a blank cell only underline, reverse and strikethrough show: bold, dim and italic change nothing there
    const seen = (flags: number) => (blank ? flags & (LOOK_UNDERLINE | LOOK_REVERSE | LOOK_STRIKE) : flags) & (unbold.has(i) ? ~LOOK_BOLD : ~0);
    if (seen(want.look.flags) !== seen(got.look.flags)) { differ("attributes"); continue; }
    const wantBg = hexOf(want.look.bg);
    if (want.look.bg === null) {
      if (got.look.bg !== null && !sameColor(got.look.bg, theme.bg)) { differ("background"); continue; }
    } else if (!(wantBg && HERDR_BG[wantBg] && sameColor(got.look.bg, theme[HERDR_BG[wantBg]!]))) { differ("background"); continue; }
    const shown = (want.ch !== " " && want.ch !== "") || (want.look.flags & (LOOK_UNDERLINE | LOOK_REVERSE)) !== 0;
    if (!shown || hold === "glyph") continue;
    const wantFg = hexOf(want.look.fg);
    if (want.look.fg === null) {
      if (got.look.fg !== null) differ("foreground");
    } else if (!(wantFg && HERDR_FG[wantFg] && sameColor(got.look.fg, theme[HERDR_FG[wantFg]!]))) differ("foreground");
  }
  return out;
}

const SIDEBAR = 26;
const NARROW = 64;

/** The sidebar's workspace half on a screen `rows` tall (herdr's rule: half the height, at least 3 rows each from 6 rows on). */
function workspaceRows(rows: number): number {
  return rows < 6 ? Math.ceil(rows / 2) : Math.min(Math.max(Math.round(rows * 0.5), 3), rows - 3);
}

/** A dialog's cells: `width` x `height` centred, at most the screen less 4 columns and 2 rows. */
function dialog(cols: number, rows: number, width: number, height: number): Omit<Hole, "line"> {
  const w = Math.min(width, cols - 4);
  const h = Math.min(height, rows - 2);
  return { x: Math.floor((cols - w) / 2), y: Math.floor((rows - h) / 2), width: w, height: h };
}

/** Every cell where a scene's picture differs from its world's first picture: what the scene's own overlay drew. */
function changed(scene: Cells, base: Cells, line: string): Hole[] {
  const holes: Hole[] = [];
  scene.cells.forEach((cell, i) => {
    const before = base.cells[i]!;
    if (cell.ch !== before.ch || JSON.stringify(cell.look) !== JSON.stringify(before.look)) holes.push({ line, x: i % scene.cols, y: Math.floor(i / scene.cols), width: 1, height: 1 });
  });
  return holes;
}

/** The scenes whose own overlay is an owner's line of part 2 (O6, O7, N2): its cells on either side are left out. */
const OVERLAY_LINES: Readonly<Record<string, string>> = { menu: "O6", "agents-menu": "O6", picker: "O7", "agents-picker": "O7", "toast-agent": "N2" };
/** The scenes left out whole: the agent list herdr has not (O11), the settings herdr has and the screen has not (O10). */
const WHOLE_LINES: Readonly<Record<string, string>> = { agentlist: "O11", "agents-list": "O11", settings: "O10" };
const BAR_SCENES = new Set(["prefix", "navigate", "copy", "resize", "empty-prefix"]);
const DIALOGS: Readonly<Record<string, readonly [number, number]>> = { help: [76, 22], rename: [56, 7], newtab: [56, 7], confirm: [64, 6] };

/**
 * What a scene's comparison leaves out or carries over, each by its line in docs/tui/visual-parity.md: C2's words (the
 * screen keeps its own: `Workspaces`, `Agents`, `Menu`, `Keyboard Shortcuts`, `Rename tab`, `New tab name`,
 * `Copied`, and on the mode bar `navigate` and `help`), S8's state glyphs, S7's agent rows, P4's pane id, the
 * owner's part-2 lines (L6 and L7 on a narrow screen, O5's help content, O6, O7, N2 and O11's overlays, P5's ended
 * pane), O10 and P6. C1's colours are carried by `compare` itself, which also takes the theme's background where herdr
 * writes none (C1 wins over S9 and P2 there). `base`: the world's first picture on each side, for an overlay's cells.
 */
export function decisionsFor(world: WorldName, scene: string, cols: number, rows: number, herdr: Cells, ovis: Cells, base: { herdr: Cells; ovis: Cells } | null): Decisions {
  const words: Word[] = [
    { herdr: " spaces", ovis: ` ${STRINGS.workspacesSection}`, row: 0, col: 0 },
    { herdr: "copied to clipboard", ovis: STRINGS.noticeText("copied", {}) },
  ];
  const holes: Hole[] = [];
  const whole = (line: string) => holes.push({ line, x: 0, y: 0, width: cols, height: rows });
  const narrow = cols <= NARROW;
  const collapsed = scene === "collapsed" || scene === "agents-collapsed";
  const agents = world === "agents";
  if (narrow) {
    // the narrow header (L6) and the narrow screen's panes (L7) are part 2: a dialog over them and the mode bar are kept
    holes.push({ line: "L6", x: 0, y: 0, width: cols, height: 2 }, { line: "L7", x: 0, y: 2, width: cols, height: rows - 2 });
    // the mode bar over the last row is part 1 (L2, M1-M3)
    if (BAR_SCENES.has(scene)) holes.splice(1, 1, { line: "L7", x: 0, y: 2, width: cols, height: rows - 3 });
  } else if (collapsed) {
    const top = rows >= 7 ? Math.ceil(rows / 2) : rows;
    holes.push({ line: "S8", x: 2, y: 0, width: 1, height: top, glyph: true });
    if (agents) holes.push({ line: "S7", x: 0, y: top + 1, width: 3, height: Math.max(0, rows - top - 2) });
  } else {
    const half = workspaceRows(rows);
    words.push({ herdr: " agents", ovis: ` ${STRINGS.agentsSection}`, row: half + 1, col: 0 }, { herdr: "menu", ovis: STRINGS.menuTitle, align: "right", row: half - 1, col: SIDEBAR - 2 });
    holes.push({ line: "S8", x: 1, y: 2, width: 1, height: Math.max(0, half - 3), glyph: true });
    if (agents) holes.push({ line: "S7", x: 0, y: half + 3, width: SIDEBAR - 1, height: Math.max(0, rows - half - 4) });
  }
  if (BAR_SCENES.has(scene)) {
    words.push({ herdr: "workspace nav", ovis: STRINGS.modeHints.workspaceNav, shift: true, row: rows - 1 }, { herdr: "keybinds", ovis: STRINGS.modeHints.keybinds, shift: true, row: rows - 1 });
  }
  const box = DIALOGS[scene];
  if (box) {
    const rect = dialog(cols, rows, box[0], box[1]);
    // herdr's dialog frame keeps the bold of the cell it was drawn over (its panel sets a colour on the old cell's style,
    // as its toolkit merges styles): that is how herdr's toolkit paints, not a look of herdr's, so a frame cell's bold
    // does not count where the picture under the dialog was bold there
    if (base) {
      for (let x = rect.x; x < rect.x + rect.width; x++) for (const y of [rect.y, rect.y + rect.height - 1]) if (base.herdr.cells[y * cols + x]!.look.flags & LOOK_BOLD) holes.push({ line: "O2", x, y, width: 1, height: 1, bold: true });
      for (let y = rect.y; y < rect.y + rect.height; y++) for (const x of [rect.x, rect.x + rect.width - 1]) if (base.herdr.cells[y * cols + x]!.look.flags & LOOK_BOLD) holes.push({ line: "O2", x, y, width: 1, height: 1, bold: true });
    }
    if (narrow) {
      // a dialog over the narrow screen is part 1 (O1-O4, O8, O9): its cells come back out of the L6 and L7 holes
      for (const hole of holes.splice(0, holes.length).flatMap((one) => one.line === "L6" || one.line === "L7" ? minus(one, rect) : [one])) holes.push(hole);
    }
    if (scene === "help") {
      words.push({ herdr: "keybinds", ovis: STRINGS.helpTitle, row: rect.y + 1 });
      // O5 (part 2): the help's content, its close button and the about hint on its bottom border
      holes.push({ line: "O5", x: rect.x + 1, y: rect.y + 2, width: rect.width - 2, height: rect.height - 3 });
      holes.push({ line: "O5", x: rect.x + 1 + STRINGS.helpTitle.length, y: rect.y + 1, width: Math.max(0, rect.width - 2 - STRINGS.helpTitle.length), height: 1 });
      holes.push({ line: "O5", x: rect.x + 2, y: rect.y + rect.height - 1, width: STRINGS.helpAboutHint.length, height: 1 });
    }
    if (scene === "rename") words.push({ herdr: "rename tab", ovis: STRINGS.textRenameTab, row: rect.y + 1 });
    if (scene === "newtab") words.push({ herdr: "new tab", ovis: STRINGS.textNewTab, row: rect.y + 1 });
  }
  // P4: the focused pane's id on its bottom border stays (owner, part 2)
  for (const picture of base ? [ovis, base.ovis] : [ovis]) {
    gridText(picture).forEach((text, y) => {
      for (const match of text.matchAll(/ id \S+(?: \([^)]*\))? (?=─)/g)) holes.push({ line: "P4", x: match.index, y, width: match[0].length, height: 1 });
    });
  }
  if (scene === "toast") {
    // C2: the copy toast says the screen's `Copied`, so its box is narrower than herdr's: both boxes' cells are left out
    // here and the toast's place, shape and colour roles are checked on their own (copyToastShape)
    const spans = [herdr, ovis].map((grid) => {
      const row = gridText(grid).findIndex((text) => text.includes("●"));
      if (row < 0) return null;
      const text = gridText(grid)[row]!;
      const at = text.indexOf("●") - 1;
      return { x: at, width: text.indexOf("│", at + 1) - at + 1, y: row - 1 };
    }).filter((span) => span !== null);
    for (const span of spans) holes.push({ line: "C2", x: span.x, y: span.y, width: span.width, height: 3 });
  }
  if (WHOLE_LINES[scene]) whole(WHOLE_LINES[scene]!);
  // on a narrow screen herdr's prefix+w opens its full-screen switcher (L8, the owner's, part 2)
  if (narrow && scene === "navigate") whole("L8");
  if (OVERLAY_LINES[scene] && base) holes.push(...changed(herdr, base.herdr, OVERLAY_LINES[scene]!), ...changed(ovis, base.ovis, OVERLAY_LINES[scene]!));
  if (scene === "ended") holes.push({ line: "P5", x: narrow ? 0 : SIDEBAR, y: 1, width: cols, height: rows - 1 });
  if (scene === "viewers") holes.push({ line: "P6", x: narrow ? 0 : SIDEBAR, y: 1, width: cols, height: rows - 1 });
  return { words, holes };
}

/** `hole` less the cells of `cut`: at most four rectangles around it. */
function minus(hole: Hole, cut: Omit<Hole, "line">): Hole[] {
  const right = hole.x + hole.width;
  const bottom = hole.y + hole.height;
  const x0 = Math.max(hole.x, cut.x), x1 = Math.min(right, cut.x + cut.width);
  const y0 = Math.max(hole.y, cut.y), y1 = Math.min(bottom, cut.y + cut.height);
  if (x0 >= x1 || y0 >= y1) return [hole];
  return [
    { ...hole, height: y0 - hole.y },
    { ...hole, y: y1, height: bottom - y1 },
    { ...hole, y: y0, height: y1 - y0, width: x0 - hole.x },
    { ...hole, x: x1, y: y0, height: y1 - y0, width: right - x1 },
  ].filter((one) => one.width > 0 && one.height > 0);
}

/**
 * N1 on the toast scene, where C2 makes the box narrower: the screen's copy toast is a box of three rows at the bottom
 * centre of the panes, framed in the done colour on the panel background, its mark in the done colour and its text
 * bold. Answers what is wrong, or null.
 */
export function copyToastShape(ovis: Cells, palette: PaletteName, panes: { x: number; width: number }): string | null {
  const theme = TUI_THEMES[palette];
  const rows = gridText(ovis);
  const y = rows.findIndex((text) => text.includes(`● ${STRINGS.noticeText("copied", {})}`));
  if (y !== ovis.rows - 2) return `the toast's text is on row ${y}, not on row ${ovis.rows - 2}`;
  const x = rows[y]!.indexOf("●") - 1;
  const width = `● ${STRINGS.noticeText("copied", {})}`.length + 2;
  if (x !== panes.x + Math.floor((panes.width - width) / 2)) return `the toast starts at column ${x}, not in the middle of the panes`;
  const at = (dx: number, dy: number) => ovis.cells[(y + dy) * ovis.cols + x + dx]!;
  const frame = [at(0, -1), at(width - 1, -1), at(0, 1), at(width - 1, 1), at(0, 0), at(width - 1, 0)];
  if (frame.map((cell) => cell.ch).join("") !== "┌┐└┘││") return "the toast is not framed in box lines";
  if (!frame.every((cell) => sameColor(cell.look.fg, theme.statusDone) && sameColor(cell.look.bg, theme.bgPanel))) return "the toast's frame is not the done colour on the panel";
  if (!sameColor(at(1, 0).look.fg, theme.statusDone)) return "the toast's mark is not the done colour";
  if ((at(3, 0).look.flags & 1) === 0) return "the toast's text is not bold";
  return null;
}

/** A short report of the first differences, with both pictures' text, for a failing case. */
export function report(herdr: Cells, ovis: Cells, differences: readonly Difference[], limit = 12): string {
  const lines = differences.slice(0, limit).map((d) => `(${d.x},${d.y}) ${d.what}: herdr ${d.herdr} | ovis ${d.ovis}`);
  return [`${differences.length} cells differ`, ...lines, "--- herdr", ...gridText(herdr), "--- ovis", ...gridText(ovis)].join("\n");
}


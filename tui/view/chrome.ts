/**
 * The terminal screen's chrome, drawn as herdr's own client draws its screen (docs/tui/visual-parity.md): the sidebar
 * (workspaces above, agents below, a rule between, the new and menu buttons, the collapse mark) or its collapsed rail,
 * the tab bar or the narrow screen's header, pane borders in box-drawing lines with a title only, the mode bar
 * over the panes' last row outside terminal mode, and the overlays (the help from the one key table, the text field and the
 * confirm dialogs with their buttons, the copy toast, the menu and the picker). Colours are the theme's
 * roles (tui/theme.generated.ts), which take the place of herdr's palette.
 *
 * Each part is built in two steps: its builder works out everything the part shows as plain data, and `draw` paints
 * only that data. A part's `version` is that data, so a part is drawn again exactly when something it shows changed.
 */

import { knownStatus, type KnownStatus } from "../../shared/attention.ts";
import type { PaneView } from "../core/pane.ts";
import type { CoreView } from "../core/world.ts";
import { STYLE_BOLD, type WrittenColor } from "../emulator/index.ts";
import type { ColorDepth } from "../host/index.ts";
import { focused } from "../model/focus.ts";
import { HELP_KEY_COLUMNS, helpLines, helpNotes, helpSize, helpTop, helpWindow } from "../model/help.ts";
import { type CopyLook, type ModeBar, modeBar } from "../model/hints.ts";
import { MENU_ENTRIES } from "../model/menu.ts";
import { type Field, type Overlay, pickerList } from "../model/overlays.ts";
import { chosenAt } from "../model/picker.ts";
import type { ModelState } from "../model/reduce.ts";
import { STRINGS } from "../strings.ts";
import { TUI_THEMES, type TuiColorRole, type TuiThemeMode } from "../theme.generated.ts";
import { agentLines } from "./agents.ts";
import type { CopyView } from "./copy.ts";
import { NO_CELLS, type Rect, type Regions, type SplitCells } from "./geometry.ts";
import { hostLayout, type LaidCell } from "./host-layout.ts";
import type { ShownLink } from "./link-view.ts";
import { nearest256, type Canvas, type Part, type Scene } from "./paint.ts";
import { type PaneSpot, RAIL_COLUMNS } from "./screen.ts";

type Colors = Readonly<Record<TuiColorRole, WrittenColor>>;

const palettes = new Map<string, Colors>();

/** The theme's colours for the host: RGB on a truecolor host, the nearest xterm-256 index on a 256-colour one. */
function themeColors(mode: TuiThemeMode, depth: ColorDepth): Colors {
  const look = `${mode}/${depth}`;
  const known = palettes.get(look);
  if (known) return known;
  const palette = TUI_THEMES[mode];
  const colors = Object.fromEntries((Object.keys(palette) as TuiColorRole[]).map((role) => [role, depth === "256" ? nearest256(palette[role]) : palette[role]])) as Colors;
  palettes.set(look, colors);
  return colors;
}

/** How far a mouse selection's background moves from the theme's own toward white (a dark theme) or black (a light one). */
const SELECTION_MIX = 0.28;

/** A mouse selection's look: the theme's background mixed toward white or black, the theme's text on it. */
export function selectionColors(mode: TuiThemeMode, depth: ColorDepth): { fg: WrittenColor; bg: WrittenColor } {
  const { bg, text } = TUI_THEMES[mode];
  const toward = mode === "dark" ? 255 : 0;
  const mixed = bg.map((value) => Math.round(value + (toward - value) * SELECTION_MIX)) as unknown as readonly [number, number, number];
  return depth === "256" ? { fg: nearest256(text), bg: nearest256(mixed) } : { fg: text, bg: mixed };
}

/** The hc session named by a socket path, for the about line when the entry was handed no session name. */
export function sessionFromSocket(socket: string): string {
  const base = socket.split(/[\\/]/).at(-1) ?? "default";
  const stripped = base.replace(/\.sock$/, "");
  if (stripped === "hc" || stripped === "") return "default";
  return stripped.replace(/^herdr-core-[^-]*-/, "") || "default";
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;
const PRINTABLE_ASCII = /^[\u0020-\u007e]*$/;

/**
 * `text` as the host lays it out (host-layout.ts, never Bun.stringWidth). Printable ASCII takes one cell a character on
 * every host, so it skips the engine: a cold first frame lays out hundreds of such labels.
 */
function measure(text: string): { cells: readonly LaidCell[]; width: number } {
  if (text === "") return { cells: [], width: 0 };
  if (PRINTABLE_ASCII.test(text)) return { cells: [...text].map((char, col): LaidCell => ({ col, text: char, width: 1 })), width: text.length };
  const laid = hostLayout.layout(text.replace(CONTROL, "\ufffd"));
  return { cells: laid.cells, width: laid.end };
}

const widthOf = (text: string): number => measure(text).width;

/**
 * Prints `text` from `col` in at most `room` columns, each cell at the width the host gives it; a wide cell that would
 * cross the edge is left out whole. With `ellipsis`, a cut text ends in `…`. Answers the column after the last cell.
 */
function printFit(canvas: Canvas, col: number, row: number, text: string, room: number, style: number, ellipsis = false): number {
  if (room <= 0 || text === "") return col;
  const { cells, width } = measure(text);
  const cut = width > room;
  const limit = cut && ellipsis && room >= 2 ? room - 1 : room;
  let end = 0;
  for (const cell of cells) {
    if (cell.col + cell.width > limit) break;
    canvas.put(col + cell.col, row, cell.text, cell.width, style);
    end = cell.col + cell.width;
  }
  if (cut && ellipsis && room >= 2) {
    canvas.put(col + end, row, STRINGS.tabsCut, 1, style);
    end += 1;
  }
  return col + end;
}

/** `text` cut to `room` columns, its last kept cell an `…` when anything was cut. */
function truncateEnd(text: string, room: number): string {
  const { cells, width } = measure(text);
  if (width <= room) return text;
  if (room <= 0) return "";
  let kept = "";
  for (const cell of cells) {
    if (cell.col + cell.width > room - 1) break;
    kept += cell.text;
  }
  return `${kept}${STRINGS.tabsCut}`;
}

/** `text` ending at the right edge of `rect` (herdr's right-aligned labels); answers its first column. */
function printRight(canvas: Canvas, rect: Rect, row: number, text: string, style: number): number {
  const width = Math.min(widthOf(text), rect.width);
  const at = rect.x + rect.width - width;
  printFit(canvas, at, row, text, width, style);
  return at;
}

function fillSpan(canvas: Canvas, col: number, row: number, width: number, style: number): void {
  for (let c = col; c < col + width; c++) canvas.put(c, row, " ", 1, style);
}

/** A frame of light box-drawing lines around `rect`. */
function box(canvas: Canvas, rect: Rect, style: number): void {
  if (rect.width < 2 || rect.height < 2) return;
  const right = rect.x + rect.width - 1;
  const bottom = rect.y + rect.height - 1;
  for (let col = rect.x; col <= right; col++) {
    canvas.put(col, rect.y, col === rect.x ? "┌" : col === right ? "┐" : "─", 1, style);
    canvas.put(col, bottom, col === rect.x ? "└" : col === right ? "┘" : "─", 1, style);
  }
  for (let row = rect.y + 1; row < bottom; row++) {
    canvas.put(rect.x, row, "│", 1, style);
    canvas.put(right, row, "│", 1, style);
  }
}

/** A dialog's panel: `rect` filled with the panel background and framed in `border`; answers the cells inside. */
function panel(canvas: Canvas, rect: Rect, border: WrittenColor, colors: Colors): Rect {
  canvas.fill(canvas.style({ fg: colors.text, bg: colors.bgPanel }));
  if (rect.width < 2 || rect.height < 2) return NO_CELLS;
  box(canvas, rect, canvas.style({ fg: border, bg: colors.bgPanel }));
  return { x: rect.x + 1, y: rect.y + 1, width: rect.width - 2, height: rect.height - 2 };
}

/** What a dialog leaves free of the screen: columns at each side, rows above and below. */
const DIALOG_MARGIN = { cols: 2, rows: 1 } as const;
/** A dialog with less room than this in either direction is not drawn. */
const DIALOG_LEAST = 4;

/** A dialog of the size it asks for, shrunk to keep the screen's margins free and centred; null when too small to draw. */
function dialogRect(screenWidth: number, screenHeight: number, width: number, height: number): Rect | null {
  const fitted = { width: Math.min(width, screenWidth - 2 * DIALOG_MARGIN.cols), height: Math.min(height, screenHeight - 2 * DIALOG_MARGIN.rows) };
  if (fitted.width < DIALOG_LEAST || fitted.height < DIALOG_LEAST) return null;
  return { x: Math.floor((screenWidth - fitted.width) / 2), y: Math.floor((screenHeight - fitted.height) / 2), ...fitted };
}

/**
 * Buttons side by side, `spacing` columns apart, the group centred in `area` on its row `line` (its last row when
 * `line` is past it); a button that reaches past the area's right edge is cut there.
 */
function buttonsCentred(area: Rect, widths: readonly number[], spacing: number, line: number): Rect[] {
  const span = widths.reduce((sum, width, at) => sum + width + (at > 0 ? spacing : 0), 0);
  const first = area.x + Math.max(0, Math.floor((area.width - span) / 2));
  const y = area.y + Math.max(0, Math.min(line, area.height - 1));
  const end = area.x + area.width;
  return widths.map((width, at) => {
    const x = first + widths.slice(0, at).reduce((sum, before) => sum + before + spacing, 0);
    return { x, y, width: Math.max(0, Math.min(width, end - x)), height: 1 };
  });
}

/** A button: its cells filled in its look, its label centred among them (from its first cell when wider). */
function drawButton(canvas: Canvas, rect: Rect, label: string, style: number): void {
  if (rect.width <= 0) return;
  fillSpan(canvas, rect.x, rect.y, rect.width, style);
  const lead = Math.max(0, Math.floor((rect.width - widthOf(label)) / 2));
  printFit(canvas, rect.x + lead, rect.y, label, rect.width - lead, style);
}

/** Each state's glyph and word (the glyph its own, so a state never shows by colour alone) and its colour. */
const STATE_LOOK: Readonly<Record<KnownStatus, { glyph: string; word: string; role: TuiColorRole }>> = {
  blocked: { glyph: STRINGS.glyphBlocked, word: STRINGS.stateBlocked, role: "statusBlocked" },
  done: { glyph: STRINGS.glyphDone, word: STRINGS.stateDone, role: "statusDone" },
  working: { glyph: STRINGS.glyphWorking, word: STRINGS.stateWorking, role: "statusWorking" },
  waiting: { glyph: STRINGS.glyphWorking, word: STRINGS.stateWorking, role: "statusWorking" },
  idle: { glyph: STRINGS.glyphIdle, word: STRINGS.stateIdle, role: "statusIdle" },
  unknown: { glyph: STRINGS.glyphUnknown, word: "", role: "textDim" },
};

/** How far a pane's history is scrolled: rows above the bottom, rows of history in all, rows on screen. */
export interface PaneScroll { readonly offset: number; readonly max: number; readonly viewport: number }

interface ChromeInput {
  copying?: ReturnType<CopyView["draw"]>;
  /** the copy session's selection and search, for the copy mode's hints */
  copyLook?: CopyLook;
  readonly regions: Regions;
  readonly spots: readonly PaneSpot[];
  readonly splits: readonly SplitCells[];
  readonly state: ModelState;
  readonly world: CoreView;
  readonly panes: ReadonlyMap<string, PaneView>;
  /** each shown pane's history, for its scrollbar (none: nothing scrolled) */
  readonly scroll?: ReadonlyMap<string, PaneScroll>;
  readonly link: ShownLink;
  readonly session: string;
  readonly theme?: TuiThemeMode;
  readonly colors?: ColorDepth;
}

interface BuiltChrome {
  readonly parts: Part[];
  readonly overlays: Part[];
  readonly input: Scene["input"];
  /** an overlay that dims every cell under it (the help, the about page, the text field and the confirm dialog) */
  readonly dim: boolean;
}

/** A part whose version is exactly the data it draws (and the colours it draws them in). */
function part<T>(key: string, rect: Rect, look: string, data: T, draw: (canvas: Canvas, data: T) => void): Part {
  return { key, rect, version: JSON.stringify([look, data]), draw: (canvas) => draw(canvas, data) };
}

/** The first index of a window of `size` items over `count` that keeps `focus` in its middle. */
function windowStart(count: number, size: number, focus: number): number {
  return count <= size ? 0 : Math.min(Math.max(0, focus - Math.floor(size / 2)), count - size);
}

/** The sidebar's height shared by its two halves: the workspaces take the upper half and the odd row, the agents the rest. */
function sidebarHalves(height: number): { workspaces: number; agents: number } {
  const workspaces = Math.max(0, Math.ceil(height / 2));
  return { workspaces, agents: Math.max(0, height) - workspaces };
}

/** The workspaces' header: its title and the blank row under it. */
const WORKSPACE_HEADER_ROWS = 2;
/** The agents' half: the rule, its header and the blank row under it. */
const AGENT_HEADER_ROWS = 3;

interface WorkspaceLine { readonly id: string; readonly status: KnownStatus; readonly name: string; readonly child: "" | "middle" | "last"; readonly front: boolean; readonly chosen: boolean }
type SidebarAgentLine =
  | { readonly kind: "section"; readonly status: KnownStatus; readonly text: string }
  | { readonly kind: "agent"; readonly id: string; readonly helper: boolean; readonly status: KnownStatus; readonly text: string; readonly front: boolean };

/** The workspaces in the sidebar's order (linked worktrees under their repository's), each with what marks it. */
function workspaceLines(state: ModelState, world: CoreView): WorkspaceLine[] {
  const shown = focused(state.world, state.focus);
  const front = shown.workspace?.id ?? null;
  const chosen = state.mode.name === "navigate" ? state.mode.preview ?? front : null;
  return world.workspaceGroups.flatMap((group) => [
    { id: group.id, status: group.status, name: group.name, child: "" as const },
    ...group.children.map((child, at) => ({ id: child.id, status: child.status, name: child.name, child: at === group.children.length - 1 ? "last" as const : "middle" as const })),
  ]).map((row) => ({ ...row, front: row.id === front, chosen: row.id === chosen }));
}

function sidebarPart(input: ChromeInput, colors: Colors, look: string): Part {
  const { regions, state, world } = input;
  const rect = regions.sidebar;
  const width = Math.max(0, rect.width - 1);
  const heights = sidebarHalves(rect.height);
  const body = Math.max(0, heights.workspaces - WORKSPACE_HEADER_ROWS - 1);
  const lines = workspaceLines(state, world);
  const wsStart = windowStart(lines.length, body, Math.max(0, lines.findIndex((line) => line.chosen || line.front)));
  const frontPane = focused(state.world, state.focus).pane?.id ?? null;
  const agents = agentLines(world.agents).map((line): SidebarAgentLine => line.kind === "section"
    ? { kind: "section", status: line.group, text: STRINGS.agentSection(STATE_LOOK[line.group].word, line.count) }
    : { kind: "agent", id: line.id, helper: line.helper, status: line.status, text: line.text, front: line.id === frontPane });
  const agentRows = Math.max(0, heights.agents - AGENT_HEADER_ROWS - 1);
  const agentStart = windowStart(agents.length, agentRows, Math.max(0, agents.findIndex((line) => line.kind === "agent" && line.front)));
  const data = {
    workspaces: lines.slice(wsStart, wsStart + body),
    agents: agents.slice(agentStart, agentStart + agentRows),
    divided: rect.height >= 6,
  };
  return part("sidebar", rect, look, data, (canvas, { workspaces, agents: agentList, divided }) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    const base = canvas.style({ fg: colors.text, bg: colors.bg });
    const separator = canvas.style({ fg: colors.border, bg: colors.bg });
    const heading = canvas.style({ fg: colors.textDim, bg: colors.bg, flags: STYLE_BOLD });
    const dim = canvas.style({ fg: colors.textDim, bg: colors.bg });
    canvas.fill(base);
    const content: Rect = { x: rect.x, y: rect.y, width, height: rect.height };
    for (let r = rect.y; r < rect.y + rect.height; r++) canvas.put(rect.x + width, r, "│", 1, separator);
    printFit(canvas, rect.x, rect.y, ` ${STRINGS.workspacesSection}`, width, heading);
    let row = rect.y + WORKSPACE_HEADER_ROWS;
    for (const line of workspaces) {
      const bg = line.chosen ? colors.bgHover : line.front ? colors.bgElevated : colors.bg;
      fillSpan(canvas, rect.x, row, width, canvas.style({ fg: colors.text, bg }));
      const end = rect.x + width - 2;
      let col = rect.x + 1;
      if (line.child !== "") col = printFit(canvas, rect.x, row, line.child === "last" ? "   └─ " : "   ├─ ", end - rect.x, canvas.style({ fg: colors.textDim, bg }));
      const state = STATE_LOOK[line.status];
      col = printFit(canvas, col, row, state.glyph, end - col, canvas.style({ fg: colors[state.role], bg }));
      col = printFit(canvas, col, row, " ", end - col, canvas.style({ fg: colors.text, bg }));
      printFit(canvas, col, row, truncateEnd(line.name, end - col), end - col, canvas.style({ fg: line.front ? colors.text : colors.textDim, bg, flags: line.front ? STYLE_BOLD : 0 }));
      canvas.hit({ x: rect.x, y: row, width, height: 1 }, `workspace:${line.id}`);
      row++;
    }
    const footer = rect.y + heights.workspaces - 1;
    if (heights.workspaces > WORKSPACE_HEADER_ROWS) {
      printFit(canvas, rect.x, footer, STRINGS.newWorkspaceButton, width, dim);
      canvas.hit({ x: rect.x, y: footer, width: Math.min(5, width), height: 1 }, "new_workspace");
      const at = printRight(canvas, content, footer, STRINGS.menuTitle, dim);
      canvas.hit({ x: at, y: footer, width: rect.x + width - at, height: 1 }, "menu");
    }
    const detail = rect.y + heights.workspaces;
    if (divided) {
      for (let col = rect.x; col < rect.x + width; col++) canvas.put(col, detail, "─", 1, separator);
      printFit(canvas, rect.x, detail + 1, ` ${STRINGS.agentsSection}`, width, heading);
      printRight(canvas, content, detail + 1, STRINGS.agentsSort, heading);
    }
    row = detail + AGENT_HEADER_ROWS;
    for (const line of agentList) {
      const state = STATE_LOOK[line.status];
      if (line.kind === "section") {
        // the state's word heads its section, so a row shows its state by its glyph alone
        printFit(canvas, rect.x + 1, row++, line.text, width - 1, canvas.style({ fg: colors[state.role], bg: colors.bg, flags: STYLE_BOLD }), true);
        continue;
      }
      const bg = line.front ? colors.bgElevated : colors.bg;
      const style = canvas.style({ fg: colors.text, bg, flags: line.front ? STYLE_BOLD : 0 });
      fillSpan(canvas, rect.x, row, width, style);
      const end = rect.x + width;
      let col = printFit(canvas, rect.x, row, line.helper ? ` ${STRINGS.helperMark}` : " ", 2, canvas.style({ fg: colors.textDim, bg }));
      col = printFit(canvas, col, row, `${state.glyph} `, 2, canvas.style({ fg: colors[state.role], bg }));
      printFit(canvas, col, row, line.text, Math.max(0, end - col), style, true);
      canvas.hit({ x: rect.x, y: row, width, height: 1 }, `agent:${line.id}`);
      row++;
    }
    if (rect.width > 1) {
      const toggle = { x: rect.x + rect.width - 2, y: rect.y + rect.height - 1, width: 1, height: 1 };
      canvas.put(toggle.x, toggle.y, STRINGS.sidebarToggleCollapse, 1, dim);
      canvas.hit(toggle, "toggle_sidebar");
    }
  });
}

/** The collapsed sidebar: a rail of numbered workspaces and agents with their state marks, and the mark that expands it. */
function railPart(input: ChromeInput, colors: Colors, look: string): Part {
  const { regions, state, world } = input;
  const rect = regions.sidebar;
  const width = Math.max(0, rect.width - 1);
  const halves = rect.height >= 7;
  const top = halves ? Math.ceil(rect.height / 2) : rect.height;
  const frontPane = focused(state.world, state.focus).pane?.id ?? null;
  const agents = agentLines(world.agents).flatMap((line) => line.kind === "agent" ? [{ id: line.id, status: line.status, front: line.id === frontPane }] : []);
  const data = {
    workspaces: workspaceLines(state, world).filter((line) => line.child === "").slice(0, top),
    agents: halves ? agents.slice(0, Math.max(0, rect.height - top - 2)) : [],
  };
  return part("sidebar", rect, look, data, (canvas, { workspaces, agents: agentList }) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    canvas.fill(canvas.style({ fg: colors.text, bg: colors.bg }));
    const separator = canvas.style({ fg: colors.border, bg: colors.bg });
    for (let r = rect.y; r < rect.y + rect.height; r++) canvas.put(rect.x + width, r, "│", 1, separator);
    const numbered = (row: number, number: number, status: KnownStatus, bg: WrittenColor, fg: WrittenColor) => {
      fillSpan(canvas, rect.x, row, width, canvas.style({ fg, bg }));
      printFit(canvas, rect.x, row, `${number}`.padEnd(2), Math.min(2, width), canvas.style({ fg, bg }));
      const mark = STATE_LOOK[status];
      printFit(canvas, rect.x + 2, row, mark.glyph, Math.max(0, width - 2), canvas.style({ fg: colors[mark.role], bg }));
    };
    workspaces.forEach((line, at) => {
      const row = rect.y + at;
      if (line.chosen) numbered(row, at + 1, line.status, colors.bgHover, colors.textDim);
      else if (line.front) numbered(row, at + 1, line.status, colors.bgElevated, colors.text);
      else numbered(row, at + 1, line.status, colors.bg, colors.textDim);
      canvas.hit({ x: rect.x, y: row, width, height: 1 }, `workspace:${line.id}`);
    });
    if (halves) {
      for (let col = rect.x; col < rect.x + width; col++) canvas.put(col, rect.y + top, "─", 1, separator);
      agentList.forEach((line, at) => {
        const row = rect.y + top + 1 + at;
        numbered(row, at + 1, line.status, line.front ? colors.bgElevated : colors.bg, line.front ? colors.text : colors.textDim);
        canvas.hit({ x: rect.x, y: row, width, height: 1 }, `agent:${line.id}`);
      });
    }
    if (width > 0) {
      const toggle = { x: rect.x + Math.floor(width / 2), y: rect.y + rect.height - 1, width: 1, height: 1 };
      canvas.put(toggle.x, toggle.y, STRINGS.sidebarToggleExpand, 1, canvas.style({ fg: colors.textDim, bg: colors.bg }));
      canvas.hit(toggle, "toggle_sidebar");
    }
  });
}

/**
 * The narrow screen's header, in the tab bar's row: the shown workspace with its state mark, the shown tab of how many,
 * the hc session, how many agents elsewhere need the user, and the menu's mark. A click anywhere on it opens the menu.
 */
function headerPart(input: ChromeInput, colors: Colors, look: string): Part {
  const { regions, state, world, session } = input;
  const rect = regions.tabBar;
  const shown = focused(state.world, state.focus);
  const row = world.workspaceGroups.flatMap((group) => [group, ...group.children]).find((one) => one.id === shown.workspace?.id);
  const tabs = shown.workspace?.tabs ?? [];
  const tabAt = tabs.findIndex((tab) => tab.id === shown.tab?.id);
  const tab = tabAt < 0 ? "" : ` ${tabAt + 1}/${tabs.length}:${tabs[tabAt]!.name || tabAt + 1}`;
  const waiting = world.agents.filter((agent) => knownStatus(agent.status) === "blocked" && agent.paneId !== shown.pane?.id).length;
  const data = {
    status: row?.status ?? "unknown",
    place: row ? `${row.number}:${row.name}${tab} ${STRINGS.sessionHeader(session)}` : `${STRINGS.noSpaces} ${STRINGS.sessionHeader(session)}`,
    waiting: waiting > 0 ? ` ${STRINGS.glyphBlocked}${waiting}` : "",
  };
  return part("header", rect, look, data, (canvas, { status, place, waiting: others }) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    const head = canvas.style({ fg: colors.textStrong, bg: colors.bgElevated, flags: STYLE_BOLD });
    canvas.fill(head);
    const right = rect.x + rect.width;
    const mark = ` ${STRINGS.menuMark}`;
    const markAt = Math.max(rect.x, right - widthOf(mark));
    const othersAt = Math.max(rect.x, markAt - widthOf(others));
    const state = STATE_LOOK[status];
    const col = printFit(canvas, rect.x, rect.y, state.glyph, Math.min(1, othersAt - rect.x), canvas.style({ fg: colors[state.role], bg: colors.bgElevated, flags: STYLE_BOLD }));
    printFit(canvas, col, rect.y, place, othersAt - col, head, true);
    printFit(canvas, othersAt, rect.y, others, markAt - othersAt, canvas.style({ fg: colors.statusBlocked, bg: colors.bgElevated, flags: STYLE_BOLD }));
    printFit(canvas, markAt, rect.y, mark, right - markAt, canvas.style({ fg: colors.accent, bg: colors.bgElevated, flags: STYLE_BOLD }));
    canvas.hit(rect, "menu");
  });
}

interface TabEntry { readonly id: string; readonly label: string; readonly width: number; readonly active: boolean; readonly named: boolean }

/** A tab's cell: its label and two columns of room on each side, at least this wide. */
const MIN_TAB_COLUMNS = 8;
const NEW_TAB_COLUMNS = 3;
const SCROLL_BUTTON_COLUMNS = 3;
const MIN_STRIP_COLUMNS = MIN_TAB_COLUMNS + NEW_TAB_COLUMNS + SCROLL_BUTTON_COLUMNS * 2;

/**
 * The tab shown first while the tabs overflow `room`, so that the tab in front stands in the middle of the strip: the tabs
 * before it are taken, nearest first, while they fit in the columns a centred tab in front leaves at its left.
 */
function tabCentringFirst(widths: readonly number[], front: number, room: number): number {
  let free = Math.floor((room - Math.min(widths[front] ?? 0, room)) / 2);
  let first = front;
  for (; first > 0 && widths[first - 1]! + 1 <= free; first--) free -= widths[first - 1]! + 1;
  return first;
}

/** The tab shown first when the strip ends at the last tab: the longest run of whole tabs at the end that fits `room`, at least the last tab. */
function tabEndFirst(widths: readonly number[], room: number): number {
  let taken = -1; // the first tab shown has no blank column before it
  for (let at = widths.length - 1; at >= 0; at--) {
    taken += widths[at]! + 1;
    if (taken > room) return Math.min(widths.length - 1, at + 1);
  }
  return 0;
}

function tabBarPart(input: ChromeInput, colors: Colors, look: string): Part {
  const { regions, state, world } = input;
  if (regions.narrow) return headerPart(input, colors, look);
  const rect = regions.tabBar;
  const shown = focused(state.world, state.focus);
  const entries = (shown.workspace?.tabs ?? []).map((tab, at): TabEntry => {
    const name = tab.name || String(at + 1);
    const label = `${name}${(world.tabs.get(tab.id)?.zoomed ?? null) !== null ? STRINGS.tabZoomSuffix : ""}`;
    return { id: tab.id, label, width: Math.max(MIN_TAB_COLUMNS, widthOf(label) + 4), active: tab.id === shown.tab?.id, named: tab.name !== "" && tab.name !== String(at + 1) };
  });
  const ownedBadge = ` ${STRINGS.appOwnedCore} `;
  const showOwned = !world.ownsLayout && rect.width - widthOf(ownedBadge) >= MIN_STRIP_COLUMNS;
  const content = rect.width - (showOwned ? widthOf(ownedBadge) + 1 : 0);
  const total = entries.reduce((sum, entry) => sum + entry.width, 0) + Math.max(0, entries.length - 1) + NEW_TAB_COLUMNS;
  const overflow = total > content && content >= MIN_STRIP_COLUMNS;
  const room = overflow ? content - NEW_TAB_COLUMNS - SCROLL_BUTTON_COLUMNS * 2 : content - NEW_TAB_COLUMNS;
  const widths = entries.map((entry) => entry.width);
  const start = overflow ? Math.min(tabCentringFirst(widths, Math.max(0, entries.findIndex((entry) => entry.active)), room), tabEndFirst(widths, room)) : 0;
  const data = { entries, start, overflow, room, content, showOwned, ownedBadge };
  return part("tabs", rect, look, data, (canvas, d) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    const row = rect.y;
    const bar = canvas.style({ fg: colors.textDim, bg: colors.bgPanel });
    canvas.fill(bar);
    let x = rect.x;
    const scrollButton = canvas.style({ fg: colors.textDim, bg: colors.bgHover });
    if (d.overflow) {
      printFit(canvas, x, row, STRINGS.tabsBefore, SCROLL_BUTTON_COLUMNS, scrollButton);
      canvas.hit({ x, y: row, width: SCROLL_BUTTON_COLUMNS, height: 1 }, "tabs_before");
      x += SCROLL_BUTTON_COLUMNS;
    }
    const tabRight = rect.x + (d.overflow ? d.content - NEW_TAB_COLUMNS - SCROLL_BUTTON_COLUMNS : d.content - NEW_TAB_COLUMNS);
    let first = -1;
    let last = -1;
    for (let index = d.start; index < d.entries.length; index++) {
      const tab = d.entries[index]!;
      const width = Math.min(tab.width, tabRight - x);
      if (width <= 0) break;
      const style = tab.active
        ? canvas.style({ fg: colors.primaryText, bg: colors.accent, flags: tab.named ? STYLE_BOLD : 0 })
        : canvas.style({ fg: colors.textDim, bg: colors.bgHover });
      const pad = Math.max(0, width - widthOf(tab.label));
      fillSpan(canvas, x, row, width, style);
      printFit(canvas, x + Math.floor(pad / 2), row, tab.label, width - Math.floor(pad / 2), style);
      canvas.hit({ x, y: row, width, height: 1 }, `tab:${tab.id}`);
      if (first < 0) first = index;
      last = index;
      x += width + 1;
      if (width < tab.width) break;
    }
    let plus = Math.min(x, rect.x + d.content);
    if (d.overflow) {
      printFit(canvas, tabRight, row, STRINGS.tabsAfter, SCROLL_BUTTON_COLUMNS, scrollButton);
      canvas.hit({ x: tabRight, y: row, width: SCROLL_BUTTON_COLUMNS, height: 1 }, "tabs_after");
      plus = tabRight + SCROLL_BUTTON_COLUMNS;
    }
    const plusWidth = Math.min(NEW_TAB_COLUMNS, rect.x + d.content - plus);
    printFit(canvas, plus, row, STRINGS.newTabButton, plusWidth, bar);
    if (plusWidth > 0) canvas.hit({ x: plus, y: row, width: plusWidth, height: 1 }, "new_tab");
    const cut = canvas.style({ fg: colors.textDim, bg: colors.bgPanel });
    if (first > 0) canvas.put(d.overflow ? rect.x + SCROLL_BUTTON_COLUMNS : rect.x, row, STRINGS.tabsCut, 1, cut);
    if (last >= 0 && last + 1 < d.entries.length) canvas.put(d.overflow ? tabRight - 1 : rect.x + d.content - 1, row, STRINGS.tabsCut, 1, cut);
    if (d.showOwned) printRight(canvas, rect, row, d.ownedBadge, canvas.style({ fg: colors.notice, bg: colors.bgPanel }));
  });
}

type Tone = "error" | "warn" | "info";

/** What a pane's bottom border says of it: why its picture is not live, or who sizes it; null for a plain live pane. */
function paneBanner(view: PaneView | undefined, link: ShownLink): { text: string; tone: Tone } | null {
  if (!link.online) return { text: STRINGS.offlinePaneBanner(), tone: "warn" };
  if (!view) return null;
  const { state, sizedBy } = view;
  switch (state.kind) {
    case "Ended":
      return { text: STRINGS.endedCode(state.code), tone: "info" };
    case "Waiting":
      return { text: state.why === "lost" ? STRINGS.waitingNewShell : state.why === "offline" ? STRINGS.waitingOffline : STRINGS.waitingClosed, tone: "warn" };
    case "Failed":
      return { text: STRINGS.failedPane(state.reason), tone: "error" };
    case "Opening":
      return { text: STRINGS.openingPane, tone: "info" };
    case "Painting":
      return { text: STRINGS.paintingPane, tone: "info" };
    case "Closing":
      return { text: STRINGS.closingPane, tone: "info" };
    case "Idle":
      return { text: STRINGS.idlePane, tone: "info" };
    case "Live":
      return sizedBy === null ? null : { text: STRINGS.sizedByViewer(sizedBy.cols, sizedBy.rows), tone: "warn" };
  }
}

/**
 * A scrollbar's thumb in a track of `track` rows: as long as the screen's share of all the rows (at least one row), and as
 * far down the track as the view is down the history; null when nothing scrolls.
 */
function scrollThumb(scroll: PaneScroll, track: number): { top: number; length: number } | null {
  if (scroll.max <= 0 || track <= 0) return null;
  const length = Math.min(track, Math.max(1, Math.round((track * scroll.viewport) / (scroll.max + scroll.viewport))));
  const down = (scroll.max - scroll.offset) / scroll.max;
  return { top: Math.round((track - length) * down), length };
}

function bordersPart(input: ChromeInput, colors: Colors, look: string): Part {
  const { regions, spots, splits, state, world, panes, link, scroll } = input;
  const rect = regions.panes;
  const shown = focused(state.world, state.focus);
  const visible = spots.filter((spot) => !spot.covered);
  const offline = visible.length === 0 && !link.online ? STRINGS.offlineDetail(link.code) : null;
  const boxes = visible.map((spot) => {
    const summary = world.panes.get(spot.pane);
    const { outer, inner, gutter } = spot.cells;
    const focus = spot.pane === shown.pane?.id && link.online;
    const history = scroll?.get(spot.pane);
    return {
      outer,
      bordered: outer.width !== inner.width + (gutter.width > 0 ? 1 : 0) && outer.height !== inner.height,
      focused: focus,
      title: outer.width > 4 ? ` ${truncateEnd((summary?.label || summary?.title || spot.pane).trim(), outer.width - 4)} ` : null,
      banner: paneBanner(panes.get(spot.pane), link),
      gutter,
      thumb: history && gutter.width > 0 ? scrollThumb(history, gutter.height) : null,
    };
  });
  const dividers = splits.filter((split) => split.divider.width > 0).map(({ id, divider }) => ({ id, divider }));
  const data = { offline, broken: !link.online, boxes, dividers };
  return part("borders", rect, look, data, (canvas, { offline: lost, broken, boxes: drawn, dividers: seams }) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    canvas.fill(canvas.style({ fg: colors.text, bg: colors.bg }));
    if (lost !== null) {
      printFit(canvas, rect.x + 2, rect.y + Math.max(0, Math.floor(rect.height / 2) - 1), lost, Math.max(0, rect.width - 4), canvas.style({ fg: colors.notice, bg: colors.bg, flags: STYLE_BOLD }), true);
      return;
    }
    for (const { id, divider } of seams) canvas.hit(divider, id);
    for (const pane of drawn) {
      if (pane.thumb) {
        const track = canvas.style({ fg: pane.focused ? colors.textDim : colors.border, bg: colors.bg });
        const thumb = canvas.style({ fg: colors.textDim, bg: colors.bg });
        for (let y = 0; y < pane.gutter.height; y++) {
          const inThumb = y >= pane.thumb.top && y < pane.thumb.top + pane.thumb.length;
          canvas.put(pane.gutter.x, pane.gutter.y + y, inThumb && pane.focused ? "▐" : "▕", 1, inThumb ? thumb : track);
        }
      }
      if (!pane.bordered) continue;
      const { outer } = pane;
      const line = broken ? colors.notice : pane.focused ? colors.accent : colors.textDim;
      box(canvas, outer, canvas.style({ fg: line, bg: colors.bg }));
      if (pane.title !== null) printFit(canvas, outer.x + 1, outer.y, pane.title, outer.width - 2, canvas.style({ fg: line, bg: colors.bg, flags: pane.focused ? STYLE_BOLD : 0 }));
      const room = Math.max(0, outer.width - 4);
      if (pane.banner && room > 0) {
        const fg = pane.banner.tone === "error" ? colors.dangerText : pane.banner.tone === "warn" ? colors.notice : colors.textDim;
        printFit(canvas, outer.x + 2, outer.y + outer.height - 1, ` ${pane.banner.text} `, room, canvas.style({ fg, bg: colors.bgElevated, flags: STYLE_BOLD }), true);
      }
    }
  });
}

const MODE_LABELS = {
  prefix: STRINGS.modePrefix,
  locked: STRINGS.modeLocked,
  navigate: STRINGS.modeNavigate,
  resize: STRINGS.modeResize,
  copy: STRINGS.modeCopy,
} as const;
const modeBadge = (mode: keyof typeof MODE_LABELS) => ` ${MODE_LABELS[mode]} `;
/** where the copy search field starts in the bar: after the badge and its marker */
const COPY_QUERY_START = 8;
/** the copy search's footer shows from a bar this wide */
const COPY_FOOTER_COLUMNS = 50;

/**
 * The mode bar, over the panes' last row: outside terminal mode the mode's badge and its hints, cut at the bar's edge;
 * herdr-core out of reach, or a prefix or detach no key reaches, shows an error badge and its reason; copy mode's
 * search its field. Otherwise none in terminal mode. A notice is the toast's alone (herdr's bar repeats none).
 */
function modeBarPart(input: ChromeInput, colors: Colors): { overlay: Part; input: Scene["input"] } | null {
  const { regions, state, link } = input;
  const rect = regions.modeBar;
  if (rect.width <= 0) return null;
  const bar: ModeBar | null = modeBar(state, input.copyLook);
  const offline = link.online ? null : STRINGS.offlineDetail(link.code);
  const unreachable = state.keymap.notes.filter((note) => note.code === "prefix_unreachable" || note.code === "detach_unreachable").map((note) => note.code);
  // as herdr's bar shows for an error in terminal mode too, a prefix or detach no key reaches keeps the bar up
  if (bar === null && offline === null && unreachable.length === 0) return null;
  const query = state.mode.name === "copy" && state.mode.phase === "query" ? fieldView(state.mode.field, Math.max(1, rect.width - COPY_QUERY_START - (rect.width >= COPY_FOOTER_COLUMNS ? widthOf(STRINGS.copySearchFooter) : 0))) : null;
  const overlay: Part = {
    key: "mode", rect, version: 0,
    draw(canvas) {
      const base = canvas.style({ fg: colors.textDim, bg: colors.bgPanel });
      const key = canvas.style({ fg: colors.accent, bg: colors.bgPanel, flags: STYLE_BOLD });
      const badge = (mode: keyof typeof MODE_LABELS | "error") => canvas.style({ fg: colors.primaryText, bg: mode === "resize" ? colors.statusWorking : mode === "locked" || mode === "error" ? colors.statusBlocked : colors.accent, flags: STYLE_BOLD });
      canvas.fill(base);
      const row = rect.y;
      const end = rect.x + rect.width;
      let x = rect.x;
      const write = (text: string, style: number) => { if (x < end) x = printFit(canvas, x, row, text, end - x, style); };
      if (offline !== null) {
        write(` ${STRINGS.errorBadge} `, badge("error"));
        write(` ${offline}`, base);
        return;
      }
      if (bar === null) {
        write(` ${STRINGS.errorBadge} `, badge("error"));
        for (const code of unreachable) write(` [${code}]`, canvas.style({ fg: colors.dangerText, bg: colors.bgPanel, flags: STYLE_BOLD }));
        return;
      }
      if (query !== null) {
        write(modeBadge("copy"), badge("copy"));
        if (rect.width >= COPY_QUERY_START) canvas.put(rect.x + COPY_QUERY_START - 1, row, "/", 1, key);
        printFit(canvas, rect.x + COPY_QUERY_START, row, query.text, end - rect.x - COPY_QUERY_START, canvas.style({ fg: colors.text, bg: colors.bgPanel }));
        if (rect.width >= COPY_FOOTER_COLUMNS) printRight(canvas, rect, row, STRINGS.copySearchFooter, base);
        return;
      }
      write(modeBadge(bar.mode), badge(bar.mode));
      // a tap on the LOCKED badge unlocks: a keyboard that cannot type the unlock chord has no other way
      if (bar.mode === "locked") canvas.hit({ x: rect.x, y: row, width: Math.min(widthOf(modeBadge("locked")), rect.width), height: 1 }, "lock");
      for (const code of unreachable) write(` [${code}]`, canvas.style({ fg: colors.dangerText, bg: colors.bgPanel, flags: STYLE_BOLD }));
      write(bar.lead, base);
      bar.hints.forEach((hint, at) => {
        if (at > 0) write("  ", base);
        if (hint.key !== "") {
          write(hint.key, key);
          write(" ", base);
        }
        write(STRINGS.modeHints[hint.label], base);
      });
      const notice = input.copying?.searchNotice ?? (state.mode.name === "copy" && state.mode.phase === "hints" && input.copying?.hints.length === 0 ? "copy_no_hints" : null);
      if (notice !== null) write(`  ${notice === "copy_no_hints" ? STRINGS.copyNoHints : STRINGS.noticeText(notice, {})}`, base);
    },
  };
  const cursor = query === null ? null : { col: rect.x + COPY_QUERY_START + query.cursor, row: rect.y };
  return { overlay, input: cursor };
}

/** The part of a text field shown in `width` columns, scrolled so the cursor stays in view, and the cursor's column in it. */
function fieldView(field: Field, width: number): { text: string; cursor: number } {
  const before = widthOf(field.graphemes.slice(0, field.cursor).join(""));
  let skip = 0;
  let skipped = 0;
  while (skip < field.graphemes.length && before - skipped > width - 1) skipped += widthOf(field.graphemes[skip++]!);
  return { text: field.graphemes.slice(skip).join(""), cursor: before - skipped };
}

/** The buttons of a dialog: each one's text, its look and what a tap on it does. */
interface DialogButton { readonly text: string; readonly width: number; readonly main: "accent" | "danger" | null; readonly hit: string }

function drawButtons(canvas: Canvas, inner: Rect, buttons: readonly DialogButton[], off: number, colors: Colors): void {
  const rects = buttonsCentred(inner, buttons.map((one) => one.width), 2, off);
  buttons.forEach((one, at) => {
    const rect = rects[at]!;
    const style = one.main === null
      ? canvas.style({ fg: colors.text, bg: colors.bgHover, flags: STYLE_BOLD })
      : canvas.style({ fg: colors.primaryText, bg: one.main === "danger" ? colors.statusBlocked : colors.accent, flags: STYLE_BOLD });
    drawButton(canvas, rect, one.text, style);
    canvas.hit(rect, one.hit);
  });
}

const FIELD_BUTTONS: readonly DialogButton[] = [
  { text: STRINGS.saveButton, width: 8, main: "accent", hit: "accept" },
  { text: STRINGS.clearButton, width: 10, main: null, hit: "clear" },
  { text: STRINGS.cancelButton, width: 12, main: null, hit: "close" },
];

/** A dialog with its title, one text field across it and its buttons under the field; the field's cell takes typing. */
function fieldOverlay(width: number, height: number, title: string, field: Field, colors: Colors): { overlay: Part; input: Scene["input"] } | null {
  const rect = dialogRect(width, height, 56, 7);
  if (!rect) return null;
  const room = Math.max(1, rect.width - 3);
  const view = fieldView(field, room);
  const overlay: Part = {
    key: "overlay:text", rect, version: 0,
    draw(canvas) {
      const inner = panel(canvas, rect, colors.accent, colors);
      if (inner.width <= 0 || inner.height <= 0) return;
      printFit(canvas, inner.x, inner.y, title, inner.width, canvas.style({ fg: colors.text, bg: colors.bgPanel, flags: STYLE_BOLD }));
      if (inner.height > 2) {
        const style = canvas.style({ fg: colors.text, bg: colors.bgHover });
        fillSpan(canvas, inner.x, inner.y + 2, inner.width, style);
        printFit(canvas, inner.x + 1, inner.y + 2, view.text, inner.width - 1, style);
      }
      drawButtons(canvas, inner, FIELD_BUTTONS, 3, colors);
    },
  };
  return { overlay, input: { col: rect.x + 2 + view.cursor, row: rect.y + 3 } };
}

/** The copy feedback: a three-row box at the bottom centre of the panes, its mark and the notice in it. */
function copyToastPart(panes: Rect, text: string, colors: Colors): Part | null {
  const line = `${STRINGS.toastMark} ${text}`;
  const width = Math.min(panes.width, widthOf(line) + 2);
  if (width < 4 || panes.height < 3) return null;
  const rect: Rect = { x: panes.x + Math.floor((panes.width - width) / 2), y: panes.y + panes.height - 3, width, height: 3 };
  return {
    key: "toast:copy", rect, version: 0,
    draw(canvas) {
      const inner = panel(canvas, rect, colors.statusDone, colors);
      if (inner.width <= 0) return;
      const col = printFit(canvas, inner.x, inner.y, STRINGS.toastMark, inner.width, canvas.style({ fg: colors.statusDone, bg: colors.bgPanel }));
      printFit(canvas, col + 1, inner.y, text, inner.x + inner.width - col - 1, canvas.style({ fg: colors.text, bg: colors.bgPanel, flags: STYLE_BOLD }));
    },
  };
}

/** Every other notice: a box at the top right of the screen, the newest three. */
function toastPart(width: number, height: number, notices: ModelState["notices"], colors: Colors): Part | null {
  if (notices.length === 0 || width < 16 || height < 3) return null;
  const glyph = (notice: ModelState["notices"][number]) => notice.calm ? STRINGS.glyphIdle : STRINGS.glyphBlocked;
  const lines = notices.slice(-3).map((notice) => `${glyph(notice)} ${STRINGS.noticeText(notice.code, notice.data)}`);
  const toastWidth = Math.min(width, Math.max(20, Math.max(...lines.map((line) => widthOf(line))) + 4));
  const toastHeight = Math.min(height, lines.length + 2);
  const rect: Rect = { x: width - toastWidth, y: Math.min(1, height - toastHeight), width: toastWidth, height: toastHeight };
  return {
    key: "toast", rect, version: 0,
    draw(canvas) {
      const inner = panel(canvas, rect, colors.notice, colors);
      const text = canvas.style({ fg: colors.text, bg: colors.bgPanel });
      lines.forEach((line, at) => {
        if (at < inner.height) printFit(canvas, inner.x + 1, inner.y + at, line, Math.max(0, inner.width - 2), text, true);
      });
    },
  };
}

/**
 * herdr's help (tui/model/help.ts): its dialog, the title and the close button on its first row, the filter row, a
 * window of the lines (headings in the accent, a command's keys bold in mauve before its words), a scrollbar over that
 * window while there is more than it shows, and the keys at its foot. The screen behind it is dimmed.
 */
function helpPart(width: number, height: number, state: ModelState, help: Extract<Overlay, { kind: "help" }>, colors: Colors): { overlay: Part; input: Scene["input"] } | null {
  const size = helpSize(width, height);
  const rect = dialogRect(width, height, size.width, size.height);
  if (!rect) return null;
  const lines = helpLines(state.keymap, helpNotes(state.keymap), help.filter.graphemes.join(""), rect.width);
  const view = helpWindow(height);
  const top = helpTop(lines.length, view, help.scroll);
  const filter = help.filtering || help.filter.graphemes.length > 0 ? fieldView(help.filter, Math.max(1, rect.width - 5)) : null;
  const overlay: Part = {
    key: "overlay:help", rect, version: 0,
    draw(canvas) {
      const inner = panel(canvas, rect, colors.accent, colors);
      if (inner.width <= 0 || inner.height <= 0) return;
      const panelStyle = (fg: WrittenColor, flags = 0) => canvas.style({ fg, bg: colors.bgPanel, flags });
      const dim = panelStyle(colors.textDim);
      printFit(canvas, inner.x, inner.y, STRINGS.helpTitle, inner.width, panelStyle(colors.text, STYLE_BOLD));
      const button = help.filtering ? STRINGS.helpBack : STRINGS.helpClose;
      const close = Math.min(widthOf(button), inner.width);
      const closeAt = inner.x + inner.width - close;
      printFit(canvas, closeAt, inner.y, button, close, canvas.style({ fg: colors.primaryText, bg: colors.accent, flags: STYLE_BOLD }));
      canvas.hit({ x: closeAt, y: inner.y, width: close, height: 1 }, "close");
      if (inner.height > 1) {
        if (filter === null) printFit(canvas, inner.x, inner.y + 1, STRINGS.helpFilterHint, inner.width, dim);
        else {
          printFit(canvas, inner.x, inner.y + 1, ` / ${filter.text}`, inner.width, panelStyle(colors.text));
        }
      }
      const first = inner.y + 3;
      const room = Math.max(0, inner.width - 1);
      lines.slice(top, top + view).forEach((line, at) => {
        const y = first + at;
        if (y >= inner.y + inner.height - 2) return;
        switch (line.kind) {
          case "heading":
            printFit(canvas, inner.x, y, ` ${line.text}`, room, panelStyle(colors.accent, STYLE_BOLD));
            return;
          case "command": {
            // filtered, the words follow the keys after one blank; otherwise they stand in their own column
            const keys = filter === null ? HELP_KEY_COLUMNS : Math.min(room, widthOf(` ${line.keys} `));
            printFit(canvas, inner.x, y, ` ${line.keys} `, Math.min(room, keys), panelStyle(colors.statusWorking, STYLE_BOLD));
            printFit(canvas, inner.x + keys, y, line.text, Math.max(0, room - keys), panelStyle(colors.text));
            return;
          }
          case "more":
            printFit(canvas, inner.x, y, line.text, room, panelStyle(colors.text));
            return;
          case "note":
            printFit(canvas, inner.x, y, ` ${line.text}`, room, panelStyle(line.warn ? colors.dangerText : colors.notice, line.warn ? STYLE_BOLD : 0), true);
            return;
          case "blank":
            return;
        }
      });
      // the scrollbar while there is more than the window shows: herdr's thumb is a lighter grey than its track, and the
      // theme has one dim text for both (C1), so the thumb shows no place of its own
      if (lines.length > view) for (let at = 0; at < view && first + at < inner.y + inner.height - 2; at++) canvas.put(inner.x + inner.width - 1, first + at, "▐", 1, dim);
      printFit(canvas, inner.x, inner.y + inner.height - 1, help.filtering ? STRINGS.helpFilterFooter : STRINGS.helpFooter, inner.width, dim);
    },
  };
  return { overlay, input: help.filtering && filter !== null ? { col: rect.x + 4 + filter.cursor, row: rect.y + 2 } : "overlay" };
}

/** The overlays of one frame: the notices, the mode bar, and the overlay on top of the stack. */
function buildOverlays(input: ChromeInput, colors: Colors): { overlays: Part[]; input: Scene["input"]; dim: boolean } {
  const { state, world, regions } = input;
  const { width, height } = regions.screen;
  const overlays: Part[] = [];
  let sceneInput: Scene["input"] = null;
  const bar = modeBarPart(input, colors);
  if (bar) {
    overlays.push(bar.overlay);
    if (bar.input !== null) sceneInput = bar.input;
  }
  if (state.mode.name !== "copy") {
    const copied = state.notices.at(-1);
    const copyToast = copied?.code === "copied" ? copyToastPart(regions.panes, STRINGS.noticeText("copied", copied.data), colors) : null;
    if (copyToast) overlays.push(copyToast);
    const toast = toastPart(width, height, state.notices.filter((notice) => notice.code !== "copied"), colors);
    if (toast) overlays.push(toast);
  }
  const top: Overlay | undefined = state.overlays.at(-1);
  if (!top) return { overlays, input: sceneInput, dim: false };
  switch (top.kind) {
    case "help": {
      const help = helpPart(width, height, state, top, colors);
      return { overlays: help ? [...overlays, help.overlay] : overlays, input: help?.input ?? "overlay", dim: true };
    }
    case "text": {
      const title = top.purpose === "rename_workspace" ? STRINGS.textRenameWorkspace
        : top.purpose === "rename_tab" ? STRINGS.textRenameTab
          : top.purpose === "rename_pane" ? STRINGS.textRenamePane
            : STRINGS.textNewTab;
      const field = fieldOverlay(width, height, title, top.field, colors);
      return { overlays: field ? [...overlays, field.overlay] : overlays, input: field?.input ?? "overlay", dim: true };
    }
    case "confirm": {
      const rect = dialogRect(width, height, 64, 6);
      if (!rect) return { overlays, input: "overlay", dim: true };
      const workspace = state.world.workspaces.find((one) => one.id === top.target.id);
      const name = workspace?.name || top.target.id;
      const panes = workspace?.tabs.reduce((sum, tab) => sum + tab.panes.length, 0) ?? 0;
      const confirm: Part = {
        key: "overlay:confirm", rect, version: 0,
        draw(canvas) {
          const inner = panel(canvas, rect, colors.statusBlocked, colors);
          if (inner.width <= 0 || inner.height <= 0) return;
          printFit(canvas, inner.x, inner.y, ` ${STRINGS.confirmCloseTitle}`, inner.width, canvas.style({ fg: colors.statusBlocked, bg: colors.bgPanel, flags: STYLE_BOLD }));
          if (inner.height > 1) printFit(canvas, inner.x, inner.y + 1, ` ${STRINGS.confirmCloseDetail(name, panes)}`, inner.width, canvas.style({ fg: colors.text, bg: colors.bgPanel }));
          drawButtons(canvas, inner, [
            { text: STRINGS.confirmButton, width: 13, main: "danger", hit: "accept" },
            { text: STRINGS.cancelButton, width: 12, main: null, hit: "close" },
          ], 3, colors);
        },
      };
      return { overlays: [...overlays, confirm], input: "overlay", dim: true };
    }
    case "goto": {
      const picker = pickerPart(width, height, top, state, world, colors);
      return { overlays: picker ? [...overlays, picker.overlay] : overlays, input: picker?.input ?? "overlay", dim: false };
    }
    case "menu":
      return { overlays: [...overlays, menuPart(regions, top, colors)], input: "overlay", dim: false };
  }
}

/** A place's state, as the sidebar marks it: a workspace's and a tab's roll-up, an agent's own. */
/** The agent and state columns of a picker row, counted from its right end: herdr's widths. */
const PICKER_STATE_COLUMNS = 11;
const PICKER_AGENT_COLUMNS = 12;
/** The picker shows its state column from this inner width (herdr's did at 74 columns, not at 58). */
const PICKER_STATE_FROM = 70;
/** The picker's foot: the chosen terminal's path, its folder, and the keys. */
const PICKER_FOOT_ROWS = 3;

/**
 * herdr's picker: the screen less its margins, ` Go to ` on its top border; the search row (its hint, or what is
 * searched) with the count of terminals at its right, a rule, then each workspace's name and its terminals beneath it,
 * `├─` and `└─`, `◆` on the one in front, its state mark and its name (its tab's name and its number in the tab when
 * the tab holds several), and two columns at the right: its agent or `terminal`, and when the box is wide its state or
 * `shell`. The chosen row
 * is the accent across the box; the foot shows its path, its folder and the keys. Each row is a click target.
 */
function pickerPart(width: number, height: number, picker: Extract<Overlay, { kind: "goto" }>, state: ModelState, world: CoreView, colors: Colors): { overlay: Part; input: Scene["input"] } | null {
  const rect = dialogRect(width, height, width, height);
  if (!rect) return null;
  const matches = pickerList(picker);
  const chosen = chosenAt(matches, picker.chosen);
  const front = focused(state.world, state.focus).pane?.id ?? null;
  const panes = new Map(state.world.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes.map((pane, at) => [pane.id, { workspace, tab, pane, at }] as const))));
  const field = picker.searching || picker.field.graphemes.length > 0 ? fieldView(picker.field, Math.max(1, rect.width - 5)) : null;
  const overlay: Part = {
    key: "overlay:goto", rect, version: 0,
    draw(canvas) {
      const inner = panel(canvas, rect, colors.accent, colors);
      if (inner.width <= 0 || inner.height <= 0) return;
      const style = (fg: WrittenColor, flags = 0) => canvas.style({ fg, bg: colors.bgPanel, flags });
      printFit(canvas, rect.x + 1, rect.y, `─ ${STRINGS.gotoTitle} `, Math.max(0, rect.width - 2), style(colors.accent));
      const count = STRINGS.pickerCount(matches.length);
      // the count stands whole at the right; the search row is cut a column before it
      const searchRoom = Math.max(0, inner.width - widthOf(count) - 1);
      if (field === null) printFit(canvas, inner.x, inner.y, STRINGS.pickerSearchHint, searchRoom, style(colors.textDim));
      else printFit(canvas, inner.x, inner.y, ` / ${field.text}`, searchRoom, style(colors.text));
      printRight(canvas, inner, inner.y, count, style(colors.textDim));
      if (inner.height < 2) return;
      for (let x = inner.x; x < inner.x + inner.width; x++) canvas.put(x, inner.y + 1, "─", 1, style(colors.border));
      const listTop = inner.y + 2;
      const listRows = Math.max(0, inner.height - 2 - PICKER_FOOT_ROWS);
      const rows: ({ kind: "workspace"; name: string } | { kind: "pane"; index: number })[] = [];
      matches.forEach((place, index) => {
        if (index === 0 || matches[index - 1]!.workspace !== place.workspace) rows.push({ kind: "workspace", name: panes.get(place.id)?.workspace.name ?? place.workspace });
        rows.push({ kind: "pane", index });
      });
      const chosenRow = rows.findIndex((row) => row.kind === "pane" && row.index === chosen);
      const start = windowStart(rows.length, listRows, Math.max(0, chosenRow));
      const end = inner.x + inner.width;
      // with no state column, the agent column takes the last eleven columns
      const stateAt = inner.width >= PICKER_STATE_FROM ? end - PICKER_STATE_COLUMNS : end;
      const agentAt = stateAt < end ? stateAt - PICKER_AGENT_COLUMNS : end - PICKER_STATE_COLUMNS;
      rows.slice(start, start + listRows).forEach((row, at) => {
        const y = listTop + at;
        if (row.kind === "workspace") {
          printFit(canvas, inner.x, y, ` ${row.name}`, inner.width, style(colors.text, STYLE_BOLD));
          return;
        }
        const place = matches[row.index]!;
        const found = panes.get(place.id);
        const summary = world.panes.get(place.id);
        const last = row.index === matches.length - 1 || matches[row.index + 1]!.workspace !== place.workspace;
        const picked = row.index === chosen;
        const look = STATE_LOOK[knownStatus(summary?.status)];
        const name = found ? (found.tab.panes.length > 1 ? `${found.tab.name} · ${found.pane.name || place.id} · ${found.at + 1}` : found.pane.name || found.tab.name || place.id) : place.id;
        const pick = canvas.style({ fg: colors.primaryText, bg: colors.accent, flags: STYLE_BOLD });
        const cell = (fg: WrittenColor) => picked ? pick : style(fg);
        if (picked) fillSpan(canvas, inner.x, y, inner.width, pick);
        let col = printFit(canvas, inner.x, y, " ", 1, cell(colors.text));
        col = printFit(canvas, col, y, last ? "└─" : "├─", end - col, cell(colors.textDim));
        col = printFit(canvas, col, y, " ", end - col, cell(colors.text));
        if (place.id === front) col = printFit(canvas, col, y, `${STRINGS.pickerFront} `, end - col, cell(colors.text));
        col = printFit(canvas, col, y, look.glyph, end - col, cell(colors[look.role]));
        printFit(canvas, col, y, ` ${name}`, Math.max(0, agentAt - col), cell(colors.text), true);
        printFit(canvas, agentAt, y, summary?.agent ?? STRINGS.pickerTerminal, PICKER_AGENT_COLUMNS, cell(colors.textDim));
        if (stateAt < end) printFit(canvas, stateAt, y, summary?.agent ? look.word : STRINGS.pickerShell, PICKER_STATE_COLUMNS, cell(colors.textDim));
        canvas.hit({ x: inner.x, y, width: inner.width, height: 1 }, `menu:${row.index}`);
      });
      const foot = inner.y + inner.height - PICKER_FOOT_ROWS;
      const picked = chosen >= 0 ? panes.get(matches[chosen]!.id) : undefined;
      if (picked) {
        printFit(canvas, inner.x, foot, ` ${picked.workspace.name} / ${picked.tab.name} / ${picked.pane.id}`, inner.width, style(colors.textDim));
        printFit(canvas, inner.x, foot + 1, ` ${world.panes.get(picked.pane.id)?.folder ?? ""}`, inner.width, style(colors.textDim));
      }
      printFit(canvas, inner.x, foot + 2, picker.searching ? STRINGS.pickerSearchFooter : STRINGS.pickerFooter, inner.width, style(colors.textDim));
    },
  };
  return { overlay, input: picker.searching && field !== null ? { col: rect.x + 4 + field.cursor, row: rect.y + 1 } : "overlay" };
}

/**
 * herdr's menu: a box just big enough for its four entries, its bottom row on the row above the sidebar's menu button
 * and its right side on the sidebar's last column, the chosen entry on the accent; with no sidebar, above the screen's
 * last row at its left. Each entry is a click target that chooses it.
 */
function menuPart(regions: Regions, menu: Extract<Overlay, { kind: "menu" }>, colors: Colors): Part {
  const labels = MENU_ENTRIES.map((action) => STRINGS.menuEntries[action]);
  const width = Math.max(...labels.map((label) => widthOf(label))) + 4;
  const height = labels.length + 2;
  const sidebar = regions.sidebar.width > RAIL_COLUMNS ? regions.sidebar : null;
  const right = sidebar ? sidebar.x + sidebar.width - 1 : width;
  const bottom = sidebar ? sidebar.y + sidebarHalves(sidebar.height).workspaces - 1 : regions.screen.height - 1;
  const rect: Rect = { x: Math.max(0, right - width), y: Math.max(0, bottom - height), width: Math.min(width, regions.screen.width), height: Math.min(height, bottom) };
  return {
    key: "overlay:menu", rect, version: 0,
    draw(canvas) {
      const inner = panel(canvas, rect, colors.accent, colors);
      labels.forEach((label, at) => {
        const y = inner.y + at;
        if (y >= inner.y + inner.height) return;
        const chosen = at === menu.cursor;
        const style = canvas.style(chosen ? { fg: colors.primaryText, bg: colors.accent, flags: STYLE_BOLD } : { fg: colors.text, bg: colors.bgPanel });
        fillSpan(canvas, inner.x, y, inner.width, style);
        printFit(canvas, inner.x + 1, y, label, Math.max(0, inner.width - 1), style);
        canvas.hit({ x: inner.x, y, width: inner.width, height: 1 }, `menu:${at}`);
      });
    },
  };
}

/**
 * The banner of a pane drawn without a border (a tab's only pane): why its picture is not live, or who sizes it
 * (docs/tui/parity.md). With no border to carry it, it goes in the row above the pane (the tab bar, or the narrow
 * screen's header) at that row's right end, clear of the narrow header's menu mark, so it never covers the pane's own
 * text. herdr has no such state on a pane, so there is no herdr place for it.
 */
function bannerParts(input: ChromeInput, colors: Colors, look: string): Part[] {
  return input.spots.filter((spot) => !spot.covered).flatMap((spot) => {
    const { outer, inner, gutter } = spot.cells;
    const bordered = outer.width !== inner.width + (gutter.width > 0 ? 1 : 0) && outer.height !== inner.height;
    const banner = bordered ? null : paneBanner(input.panes.get(spot.pane), input.link);
    if (!banner || outer.y === 0) return [];
    const text = ` ${banner.text} `;
    const right = outer.x + outer.width - (input.regions.narrow ? widthOf(` ${STRINGS.menuMark}`) : 0);
    const width = Math.min(widthOf(text), right - outer.x);
    if (width <= 0) return [];
    const rect: Rect = { x: right - width, y: outer.y - 1, width, height: 1 };
    return [part(`banner:${spot.pane}`, rect, look, [text, banner.tone], (canvas) => {
      const fg = banner.tone === "error" ? colors.dangerText : banner.tone === "warn" ? colors.notice : colors.textDim;
      printFit(canvas, rect.x, rect.y, text, rect.width, canvas.style({ fg, bg: colors.bgElevated, flags: STYLE_BOLD }), true);
    })];
  });
}

/** Every chrome part and overlay of one frame pass. */
export function buildChrome(input: ChromeInput): BuiltChrome {
  const theme = input.theme ?? "dark";
  const depth = input.colors ?? "truecolor";
  const colors = themeColors(theme, depth);
  const look = `${theme}/${depth}`;
  const parts = [bordersPart(input, colors, look)];
  if (input.regions.sidebar.width > 0) parts.unshift(input.state.sidebarCollapsed ? railPart(input, colors, look) : sidebarPart(input, colors, look));
  if (input.regions.tabBar.width > 0) parts.push(tabBarPart(input, colors, look));
  const built = buildOverlays(input, colors);
  const { dim } = built;
  // under the dialogs and the mode bar: a borderless pane's banner first
  const overlays = [...bannerParts(input, colors, look), ...built.overlays];
  const copying = input.copying;
  if (!copying) return { parts, overlays, input: built.input, dim };
  for (const hint of copying.hints) {
    const rect = { x: hint.col, y: hint.row, width: hint.width, height: 1 };
    overlays.unshift(part(`copy-hint:${hint.digit}`, rect, look, hint.digit, (canvas, digit) => {
      const style = canvas.style({ fg: colors.primaryText, bg: colors.accent, flags: STYLE_BOLD });
      canvas.fill(style);
      canvas.put(rect.x, rect.y, String(digit), 1, style);
    }));
  }
  // copy mode's cursor is a cell of the pane drawn in the accent; the host's own cursor is hidden meanwhile
  if (copying.input !== null && copying.input !== "overlay" && built.input === null) {
    const point = copying.input;
    const scene = copying.pane;
    const gx = point.col - scene.rect.x + (scene.view?.col ?? 0);
    const gy = point.row - scene.rect.y + (scene.view?.row ?? 0);
    const grid = scene.grid.grid;
    const at = gy * grid.cols + gx;
    const text = gy >= 0 && gy < grid.rows && gx >= 0 && gx < grid.cols ? grid.text[at] || " " : " ";
    const wide = gy >= 0 && gy < grid.rows && gx >= 0 && gx < grid.cols && grid.width[at] === 2;
    const rect = { x: point.col, y: point.row, width: wide ? 2 : 1, height: 1 };
    overlays.unshift(part("copy-cursor", rect, look, [text, wide], (canvas) => {
      canvas.put(rect.x, rect.y, text, wide ? 2 : 1, canvas.style({ fg: colors.primaryText, bg: colors.accent, flags: STYLE_BOLD }));
    }));
    return { parts, overlays, input: "overlay", dim };
  }
  return { parts, overlays, input: built.input ?? copying.input, dim };
}

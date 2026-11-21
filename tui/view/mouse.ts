/**
 * What a mouse event does on the screen, from the hit map of the last frame: the press makes a grab, and the drag,
 * the release and the wheel follow it. Over chrome a press selects a tab, a workspace or an agent's pane, runs the
 * sidebar toggle, or grabs a divider. Over a pane that is not focused a press only focuses it. Over the focused
 * pane the event goes to its program, in its own grid's cells, when the program asked for a mouse mode and shift
 * is not held; otherwise the wheel scrolls the pane's history here and a drag selects, and the release copies.
 * A program gets a drag and its release only if its press went there, it is focused, and the grab is still active.
 * Over an open overlay only its close control and its entries (the menu's) act.
 * The answer is a list of acts for the loop to perform; nothing here writes, sends or draws.
 */
import type { LayoutNode, SplitDirection } from "../../server/herdr-core/layout-doc.ts";
import { type DividerName, dividerAt } from "../core/divider.ts";
import type { EngineHistory, ScreenPoint, ScreenRange } from "../emulator/index.ts";
import type { MouseInput } from "../model/effects.ts";
import type { Target } from "../model/focus.ts";
import type { Rect, SplitCells } from "./geometry.ts";
import { type GridCell, type HitMap, ordered } from "./paint.ts";

/** Rows the history moves for one notch of the wheel. */
const WHEEL_ROWS = 3;

/** What the pointer reads of a shown pane, as the last frame drew it. */
export interface PaneLook {
  /** the screen cells its terminal shows in */
  readonly rect: Rect;
  /** the grid row drawn at the rectangle's top (a terminal taller than its cells is drawn clipped) */
  readonly top: number;
  /** the terminal's real grid */
  readonly grid: { readonly cols: number; readonly rows: number };
  /** the program asked for a mouse mode */
  readonly programMouse: boolean;
  readonly altScreen: boolean;
  /** the emulator drawn: a new one (a new attach) holds none of the old one's selection */
  readonly emulator: object;
  readonly history: EngineHistory;
}

/** What the pointer reads of the screen at an event. */
export interface PointerScene {
  readonly hits: HitMap | null;
  /** the pane input goes to */
  readonly focus: string | null;
  /** the shown tab and its tree as drawn, for naming a divider */
  readonly tab: { readonly id: string; readonly root: LayoutNode } | null;
  readonly splits: readonly SplitCells[];
  look(pane: string): PaneLook | null;
}

export type PointerAct =
  | { readonly kind: "select"; readonly target: Target }
  | { readonly kind: "action"; readonly action: "toggle_sidebar" | "new_workspace" | "menu" }
  /** the top overlay's entry with this index was clicked */
  | { readonly kind: "choose"; readonly entry: number }
  /** to the focused pane's program, in its grid's cells */
  | { readonly kind: "forward"; readonly pane: string; readonly event: MouseInput }
  /** show the pane's screen this many rows above its newest rows */
  | { readonly kind: "scroll"; readonly pane: string; readonly fromBottom: number }
  | { readonly kind: "copy"; readonly pane: string; readonly range: ScreenRange }
  /** the dragged divider's ratio; `done` at the release */
  | { readonly kind: "divider"; readonly grab: number; readonly tab: string; readonly name: DividerName; readonly ratio: number; readonly done: boolean }
  /** the selection changed: the next frame draws it */
  | { readonly kind: "redraw" }
  /** the top overlay's close control was clicked */
  | { readonly kind: "close_overlay" };

type Grab =
  | { readonly kind: "none" }
  | { readonly kind: "forward"; readonly pane: string }
  | { readonly kind: "select"; readonly pane: string; readonly anchor: ScreenPoint }
  | { readonly kind: "divider"; readonly id: number; readonly tab: string; readonly name: DividerName; readonly rect: Rect; readonly direction: SplitDirection; readonly offset: number; moved: number | null };

interface Selection { readonly pane: string; readonly start: ScreenPoint; readonly end: ScreenPoint; readonly emulator: object; readonly altScreen: boolean }

const NONE: Grab = { kind: "none" };
const isWheel = (event: MouseInput): boolean => event.button !== undefined && event.button.startsWith("wheel");

/** How many rows above its newest rows a pane's screen shows. */
export function rowsAboveBottom(look: PaneLook): number {
  return Math.max(0, look.history.total - look.grid.rows - look.history.viewportTop);
}

/** One screen's pointer: its grab, the selection and the grabs counted for the divider writes. */
export class Pointer {
  private grab: Grab = NONE;
  private selection: Selection | null = null;
  private grabs = 0;

  /** On a reported focus change, cancel a forward grab on any other pane. Selection and divider grabs keep their anchors. */
  focusChanged(pane: string | null): void {
    if (this.grab.kind === "forward" && this.grab.pane !== pane) this.grab = NONE;
  }

  mouse(over: "overlay" | "screen", event: MouseInput, scene: PointerScene): PointerAct[] {
    if (over === "overlay") {
      // an open overlay owns the mouse: nothing reaches the chrome or a pane under it; its close control closes it.
      // A gesture that began before it opened ends at its release: a program that got the press gets that release,
      // and a selection or divider grab is dropped, so nothing of it goes on once the overlay closes.
      if (event.action === "release") {
        const grab = this.grab;
        this.grab = NONE;
        const look = grab.kind === "forward" && grab.pane === scene.focus ? scene.look(grab.pane) : null;
        return grab.kind === "forward" && look ? [{ kind: "forward", pane: grab.pane, event: inGrid(event, look) }] : [];
      }
      if (event.action !== "press") return [];
      this.grab = NONE;
      const hit = event.button === "left" ? scene.hits?.at(event.col, event.row) : null;
      if (!hit || !("part" in hit) || !hit.part.startsWith("overlay:")) return [];
      if (hit.id === "close") return [{ kind: "close_overlay" }];
      const [kind, entry] = splitId(hit.id);
      return kind === "menu" && /^\d+$/.test(entry) ? [{ kind: "choose", entry: Number(entry) }] : [];
    }
    if (isWheel(event)) return this.wheel(event, scene);
    if (event.action === "press") return this.press(event, scene);
    const grab = this.grab;
    if (event.action === "release") this.grab = NONE;
    switch (grab.kind) {
      case "forward": {
        if (grab.pane !== scene.focus) {
          this.grab = NONE;
          return [];
        }
        const look = scene.look(grab.pane);
        return look ? [{ kind: "forward", pane: grab.pane, event: inGrid(event, look) }] : [];
      }
      case "select":
        return this.extend(grab, event, scene);
      case "divider":
        return this.drag(grab, event);
      case "none": {
        // with no grab only a move with no button held goes on: the focused program sees it only if it asked for any
        // motion (the pane machine's rule). A drag whose press went to no program, and its release, go nowhere.
        if (event.action !== "motion" || event.button !== undefined) return [];
        const hit = scene.hits?.at(event.col, event.row);
        const pane = hit && "pane" in hit ? hit.pane : null;
        const look = pane !== null && pane === scene.focus ? scene.look(pane) : null;
        return look && pane !== null && look.programMouse && !event.mods.shift ? [{ kind: "forward", pane, event: inGrid(event, look) }] : [];
      }
    }
  }

  /** Before input is routed to `pane`, drop a forward grab on any other pane and show the newest rows. */
  typed(pane: string, look: PaneLook | null): PointerAct[] {
    if (this.grab.kind === "forward" && this.grab.pane !== pane) this.grab = NONE;
    return look && rowsAboveBottom(look) > 0 ? [{ kind: "scroll", pane, fromBottom: 0 }] : [];
  }

  /**
   * The selection to draw in `pane`, in its grid's cells; null when there is none there. A selection whose pane lost
   * the focus, got a new emulator or switched its alternate screen is dropped here.
   */
  shown(pane: string, focus: string | null, look: PaneLook | null): { start: GridCell; end: GridCell } | null {
    const selection = this.selection;
    if (!selection || selection.pane !== pane) return null;
    if (pane !== focus || !look || look.emulator !== selection.emulator || look.altScreen !== selection.altScreen) {
      this.selection = null;
      return null;
    }
    const top = look.history.viewportTop;
    return { start: { x: selection.start.x, y: selection.start.y - top }, end: { x: selection.end.x, y: selection.end.y - top } };
  }

  private press(event: MouseInput, scene: PointerScene): PointerAct[] {
    this.grab = NONE;
    const dropped: PointerAct[] = this.selection ? [{ kind: "redraw" }] : [];
    this.selection = null;
    const hit = scene.hits?.at(event.col, event.row) ?? null;
    if (hit === null) return dropped;
    if ("pane" in hit) {
      if (hit.pane !== scene.focus) return [...dropped, { kind: "select", target: { kind: "pane", id: hit.pane } }];
      const look = scene.look(hit.pane);
      if (!look) return dropped;
      if (look.programMouse && !event.mods.shift) {
        this.grab = { kind: "forward", pane: hit.pane };
        return [...dropped, { kind: "forward", pane: hit.pane, event: inGrid(event, look) }];
      }
      if (event.button === "left") this.grab = { kind: "select", pane: hit.pane, anchor: pointOf(event, look) };
      return dropped;
    }
    if (event.button !== "left") return dropped;
    const [kind, id] = splitId(hit.id);
    if (kind === "tab" || kind === "workspace") return [...dropped, { kind: "select", target: { kind, id } }];
    if (kind === "agent") return [...dropped, { kind: "select", target: { kind: "pane", id } }];
    if (hit.id === "toggle_sidebar" || hit.id === "new_workspace" || hit.id === "menu") return [...dropped, { kind: "action", action: hit.id }];
    const split = scene.splits.find((candidate) => candidate.id === hit.id);
    const path = split ? pathOf(split.id) : null;
    const name = split && path && scene.tab ? dividerAt(scene.tab.root, path) : null;
    if (split && name && scene.tab) {
      const across = split.direction === "right";
      const first = (across ? split.divider.x - split.rect.x : split.divider.y - split.rect.y) + 1;
      const at = (across ? event.col - split.rect.x : event.row - split.rect.y) + 1;
      this.grab = { kind: "divider", id: ++this.grabs, tab: scene.tab.id, name, rect: split.rect, direction: split.direction, offset: first - at, moved: null };
    }
    return dropped;
  }

  private wheel(event: MouseInput, scene: PointerScene): PointerAct[] {
    const grabbed = this.grab.kind === "forward" || this.grab.kind === "select" ? this.grab.pane : null;
    const hit = grabbed === null ? scene.hits?.at(event.col, event.row) ?? null : null;
    const pane = grabbed ?? (hit && "pane" in hit ? hit.pane : null);
    // the wheel acts on the focused pane only: over another one it neither scrolls nor focuses
    if (pane === null || pane !== scene.focus) return [];
    const look = scene.look(pane);
    if (!look) return [];
    if (look.programMouse && !event.mods.shift) return [{ kind: "forward", pane, event: inGrid(event, look) }];
    if (event.button !== "wheelUp" && event.button !== "wheelDown") return [];
    const now = rowsAboveBottom(look);
    const next = event.button === "wheelUp" ? Math.min(now + WHEEL_ROWS, look.history.scrollback) : Math.max(0, now - WHEEL_ROWS);
    return next === now ? [] : [{ kind: "scroll", pane, fromBottom: next }];
  }

  private extend(grab: Extract<Grab, { kind: "select" }>, event: MouseInput, scene: PointerScene): PointerAct[] {
    const look = scene.look(grab.pane);
    if (!look) return [];
    const end = pointOf(event, look);
    const moved = this.selection !== null || end.x !== grab.anchor.x || end.y !== grab.anchor.y;
    if (moved) this.selection = { pane: grab.pane, start: grab.anchor, end, emulator: look.emulator, altScreen: look.altScreen };
    const acts: PointerAct[] = moved ? [{ kind: "redraw" }] : [];
    if (event.action === "release" && this.selection) acts.push({ kind: "copy", pane: grab.pane, range: ordered(this.selection) });
    return acts;
  }

  private drag(grab: Extract<Grab, { kind: "divider" }>, event: MouseInput): PointerAct[] {
    const across = grab.direction === "right";
    const extent = across ? grab.rect.width : grab.rect.height;
    const first = (across ? event.col - grab.rect.x : event.row - grab.rect.y) + 1 + grab.offset;
    const ratio = extent > 0 ? first / extent : 0.5;
    if (event.action === "motion") grab.moved = ratio;
    else if (grab.moved === null) return [];
    return [{ kind: "divider", grab: grab.id, tab: grab.tab, name: grab.name, ratio: event.action === "motion" ? ratio : grab.moved, done: event.action === "release" }];
  }
}

/** `tab:<id>` and its kin: the kind and the id; anything else: the whole id as the kind. */
function splitId(id: string): [string, string] {
  const at = id.indexOf(":");
  return at < 0 ? [id, ""] : [id.slice(0, at), id.slice(at + 1)];
}

/** A split's path from its id (`split_<n>_root`, `split_<n>_01`: 0 the first side, 1 the second). */
function pathOf(id: string): boolean[] | null {
  const match = /^split_\d+_(root|[01]+)$/.exec(id);
  if (!match) return null;
  return match[1] === "root" ? [] : [...match[1]!].map((step) => step === "1");
}

/** The event's cell in the pane's grid: clamped into the pane's rectangle, then through the rows the frame clips. */
function gridCell(event: MouseInput, look: PaneLook): GridCell {
  const { rect } = look;
  const col = Math.min(Math.max(event.col, rect.x), rect.x + Math.max(0, rect.width - 1));
  const row = Math.min(Math.max(event.row, rect.y), rect.y + Math.max(0, rect.height - 1));
  return {
    x: Math.min(col - rect.x, Math.max(0, look.grid.cols - 1)),
    y: Math.min(row - rect.y + look.top, Math.max(0, look.grid.rows - 1)),
  };
}

function inGrid(event: MouseInput, look: PaneLook): MouseInput {
  const cell = gridCell(event, look);
  return { ...event, col: cell.x, row: cell.y };
}

/** The event's cell in the whole kept screen (history included), where a selection is kept. */
function pointOf(event: MouseInput, look: PaneLook): ScreenPoint {
  const cell = gridCell(event, look);
  return { x: cell.x, y: look.history.viewportTop + cell.y };
}

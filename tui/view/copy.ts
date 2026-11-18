import type { PaneNotice, Panes, PaneView } from "../core/pane.ts";
import { clipTop } from "../core/size.ts";
import type { Emulator, EmulatorResult, EngineHistory, ScreenPoint, ScreenRange } from "../emulator/index.ts";
import type { Effect } from "../model/effects.ts";
import { type CopyHint, visibleCopyHints } from "./copy-hints.ts";
import { clamp, movedCopyPoint } from "./copy-motion.ts";
import { holds } from "./geometry.ts";
import { ordered, type PaneScene, type Scene } from "./paint.ts";

interface Session {
  readonly pane: string;
  readonly emulator: Emulator;
  readonly gen: number;
  readonly cols: number;
  readonly rows: number;
  readonly alt: boolean;
  readonly original: number;
  point: ScreenPoint;
  top: number;
  selection: { readonly anchor: ScreenPoint; readonly shape: "char" | "line" } | null;
  query: string;
  match: ScreenRange | null;
  searchFresh: boolean;
  noMatch: boolean;
  hints: "scan" | readonly CopyHint[] | null;
}

const value = <T>(result: EmulatorResult<T>): T | null => result.ok ? result.value : null;
const bottom = (s: Session, history: EngineHistory) => Math.max(0, history.total - s.rows);

function range(s: Session): ScreenRange | null {
  if (!s.selection) return null;
  const selected = ordered({ start: s.selection.anchor, end: s.point });
  if (s.selection.shape === "char") return selected;
  return { start: { x: 0, y: selected.start.y }, end: { x: s.cols - 1, y: selected.end.y } };
}

/** Coordinates refer to one emulator generation and buffer. Only its current viewport is rendered. */
export class CopyView {
  private session: Session | null = null;

  retain(pane: string | null): void {
    const s = this.session;
    if (!s || s.pane === pane) return;
    this.session = null;
    if (value(s.emulator.modes())?.altScreen === s.alt) {
      if (s.searchFresh) s.emulator.search("");
      s.emulator.scrollFromBottom(s.original);
    }
  }

  /** Drops stale screen coordinates on data, even if pruning left the history with the same row count. */
  changed(notice: PaneNotice, panes: Panes): boolean {
    const s = this.session;
    if (!s || notice.terminal !== s.pane) return false;
    if (notice.type !== "state" && notice.type !== "output" && notice.type !== "gone") return false;
    const view = panes.view(notice.terminal);
    if (notice.type === "gone" || view?.state.kind !== "Live" || view.gen !== s.gen || view.emulator !== s.emulator
      || view.covered || value(s.emulator.modes())?.altScreen !== s.alt) return true;
    if (notice.type === "output") {
      const history = value(s.emulator.history());
      if (!history) return true;
      s.point = { x: s.point.x, y: clamp(s.point.y + history.viewportTop - s.top, history.total) };
      s.top = history.viewportTop;
      s.selection = null;
      s.match = null;
      s.searchFresh = false;
      s.noMatch = false;
      s.hints = null;
    }
    return false;
  }

  run(effect: Extract<Effect, { type: "copy" }>, view: PaneView | undefined, scene: PaneScene | undefined):
    { readonly close: boolean; readonly text?: string; readonly unavailable?: true } {
    const { pane, command } = effect;
    if (command.kind === "enter") {
      const emulator = view?.emulator, size = view?.actual;
      const history = emulator && value(emulator.history());
      const modes = emulator && value(emulator.modes());
      if (view?.state.kind !== "Live" || view.covered || !emulator || !size || !scene || scene.hold || !history || !modes || modes.syncOutput) {
        return { close: true, unavailable: true };
      }
      const cursor = scene.grid.cursor;
      const original = Math.max(0, history.total - size.rows - history.viewportTop);
      const col = original > 0 || !cursor?.visible ? 0 : cursor.x;
      const row = original > 0 || !cursor?.visible ? (scene.view?.row ?? 0) + scene.rect.height - 1 : cursor.y;
      this.session = {
        pane, emulator, gen: view.gen, ...size, original, alt: modes.altScreen,
        point: { x: clamp(col, Math.min(size.cols, scene.rect.width)), y: clamp(history.viewportTop + row, history.total) },
        top: history.viewportTop, selection: null, match: null, query: "", searchFresh: false, noMatch: false, hints: null,
      };
      return { close: false };
    }
    const s = this.session;
    if (!s || s.pane !== pane || !scene) return { close: true };
    const emulator = s.emulator;
    // The held frame may still show the old cells, so it cannot be used to select or copy.
    if (scene.hold || value(emulator.modes())?.syncOutput) return { close: false };
    const history = value(emulator.history());
    if (!history) return { close: true };
    const height = Math.min(scene.rect.height, s.rows);
    switch (command.kind) {
      case "move": {
        s.point = movedCopyPoint(command.motion, {
          point: s.point, cols: s.cols, total: history.total, height,
          wordAt: (point) => value(emulator.wordAt(point)),
          rowText: (y) => value(emulator.textOf({ start: { x: 0, y }, end: { x: s.cols - 1, y } })) ?? "",
        });
        const half = Math.max(1, Math.floor(height / 2));
        const top = command.motion === "copy_half_up" ? history.viewportTop - half
          : command.motion === "copy_half_down" ? history.viewportTop + half : history.viewportTop;
        const shown = Math.max(0, Math.min(top, bottom(s, history)));
        const target = Math.min(Math.max(s.point.y - s.rows + 1, shown), s.point.y);
        if (target !== history.viewportTop) emulator.scrollFromBottom(bottom(s, history) - target);
        s.top = value(emulator.history())?.viewportTop ?? history.viewportTop;
        s.match = null;
        break;
      }
      case "select":
        s.selection = s.selection?.shape === command.shape ? null : { shape: command.shape, anchor: s.point };
        s.match = null;
        break;
      case "find":
        s.query = command.query;
        s.searchFresh = false;
        s.selection = null;
        this.search(s, "older");
        break;
      case "step":
        s.selection = null;
        this.search(s, command.toward);
        break;
      case "hints":
        s.hints = "scan";
        break;
      case "pick": {
        const chosen = s.hints !== "scan" && s.hints?.[command.digit - 1];
        if (chosen) return { close: true, text: chosen.text };
        break;
      }
      case "yank": {
        const selected = range(s);
        const text = selected && value(emulator.textOf(selected));
        if (text) return { close: true, text };
        break;
      }
    }
    return { close: false };
  }

  private search(s: Session, toward: "older" | "newer"): void {
    if (!s.searchFresh) {
      s.match = null;
      const found = value(s.emulator.search(s.query));
      s.searchFresh = found !== null;
      s.noMatch = s.query !== "" && found?.length === 0;
      if (!found?.length) return;
    }
    if (s.query === "") return;
    s.match = value(s.emulator.searchStep(toward));
    if (s.match) s.point = s.match.start;
    s.top = value(s.emulator.history())?.viewportTop ?? s.top;
  }

  draw(scene: PaneScene): { pane: PaneScene; hints: readonly CopyHint[]; input: Scene["input"]; noMatch: boolean } | null {
    const s = this.session;
    if (!s || s.pane !== scene.id) return null;
    const gridRow = s.point.y - s.top;
    const row = clipTop(gridRow, s.rows, scene.rect.height);
    const col = clipTop(s.point.x, s.cols, scene.rect.width);
    const view = { col, row };
    const selected = range(s) ?? s.match;
    const point = { col: scene.rect.x + s.point.x - col, row: scene.rect.y + gridRow - row };
    const { grid } = scene.grid;
    if (s.point.x > 0 && grid.width[gridRow * grid.cols + s.point.x] === 0) point.col--;
    const pane = { ...scene, view, ...(selected === null ? {} : {
      selection: { start: { x: selected.start.x, y: selected.start.y - s.top }, end: { x: selected.end.x, y: selected.end.y - s.top } },
    }) };
    if (s.hints === "scan") s.hints = visibleCopyHints(pane);
    return {
      pane, hints: s.hints ?? [], input: holds(scene.rect, point.col, point.row) ? point : "overlay",
      noMatch: s.noMatch,
    };
  }
}

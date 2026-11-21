/**
 * A split divider dragged with the mouse: named by the panes on its two sides so it can be found again on a
 * document someone else changed meanwhile, drawn ahead at the newest ratio while the drag lasts, and written to
 * the core's layout document with one write in flight at a time and the newest ratio kept for the next.
 */
import { type LayoutNode, leaves, type OvisLayout, setRatio, type SplitDirection } from "../../server/herdr-core/layout-doc.ts";
import { type Edited, ratioEdit } from "../../server/herdr-core/layout-ops.ts";
import { errorCode } from "../crash.ts";
import type { TabShape } from "./world.ts";

/** A divider by what lies on its two sides: the first pane (in tree order) of each side, and the split's direction. */
export interface DividerName { readonly first: string; readonly second: string; readonly direction: SplitDirection }

/** The divider of the split at `path` (false the first side, true the second); null where no split is. */
export function dividerAt(root: LayoutNode, path: readonly boolean[]): DividerName | null {
  let node = root;
  for (const second of path) {
    if ("leaf" in node) return null;
    node = second ? node.second : node.first;
  }
  if ("leaf" in node) return null;
  return { first: leaves(node.first)[0]!, second: leaves(node.second)[0]!, direction: node.split };
}

/**
 * Where the named divider is in `root`: the lowest split holding the first name on its first side and the second
 * on its second, in the named direction; null when the tree has no such split (it was closed, moved or turned).
 */
export function dividerPath(root: LayoutNode, name: DividerName): boolean[] | null {
  const path: boolean[] = [];
  let node = root;
  for (;;) {
    if ("leaf" in node) return null;
    const firstHere = leaves(node.first);
    const secondHere = leaves(node.second);
    if (firstHere.includes(name.first) && secondHere.includes(name.second)) return node.split === name.direction ? path : null;
    if (firstHere.includes(name.first) && firstHere.includes(name.second)) {
      path.push(false);
      node = node.first;
    } else if (secondHere.includes(name.first) && secondHere.includes(name.second)) {
      path.push(true);
      node = node.second;
    } else return null;
  }
}

/** The ratio of the named divider in whichever tab holds it now; `stale` and no layout when none does. */
export const dividerEdit = (name: DividerName, ratio: number) => (layout: OvisLayout): Edited => {
  for (const workspace of layout.workspaces) {
    for (const tab of workspace.tabs) {
      const path = dividerPath(tab.root, name);
      if (path) return ratioEdit(tab.id, path, ratio)(layout);
    }
  }
  return { layout: null, reason: "stale" };
};

/** Why a drag's write did not land: the divider was gone (`stale`), or the core refused the write (its code). */
export interface DividerRefusal { readonly code: "stale" | "layout_refused"; readonly reason: string | null }

export interface DividerWritesOptions {
  /** one read-edit-write of the layout document (layout-ops.ts `editLayout`) */
  edit: (change: (layout: OvisLayout) => Edited) => Promise<{ changed: boolean; reason: string | null }>;
  /** a write did not land; the drag's local ratio is dropped */
  refused: (refusal: DividerRefusal) => void;
}

interface Drag {
  readonly grab: number;
  readonly tab: string;
  readonly name: DividerName;
  ratio: number;
  /** the ratio of the write in flight or the last one answered */
  sent: number | null;
  inFlight: boolean;
  /** the button was released */
  done: boolean;
  /** once released and answered: the shown tree it was drawn over, kept until that tree changes */
  over: string | null;
}

/** The drags of one screen: one at a time; a new grab replaces the old one's local ratio. */
export class DividerWrites {
  private drag: Drag | null = null;
  /** grabs whose divider was gone or whose write was refused: their later moves write nothing */
  private ended = -1;

  constructor(private readonly options: DividerWritesOptions) {}

  /** The pointer moved the divider of grab `grab` to `ratio`; `done` when the button was released there. */
  move(grab: number, tab: string, name: DividerName, ratio: number, done: boolean): void {
    if (grab <= this.ended) return;
    if (this.drag?.grab !== grab) this.drag = { grab, tab, name, ratio, sent: null, inFlight: false, done, over: null };
    this.drag.ratio = ratio;
    this.drag.done = done;
    this.write(this.drag);
  }

  /** The tab's shape as drawn: the dragged divider at its local ratio while the drag lasts and until the tree changes after it. */
  shape(tab: string, shape: TabShape | undefined): TabShape | undefined {
    const drag = this.drag;
    if (!drag || drag.tab !== tab || !shape) return shape;
    if (drag.done && !drag.inFlight && drag.sent === drag.ratio) {
      const seen = JSON.stringify(shape.root);
      drag.over ??= seen;
      if (drag.over !== seen) {
        this.drag = null;
        return shape;
      }
    }
    const path = dividerPath(shape.root, drag.name);
    const root = path && setRatio(shape.root, path, drag.ratio);
    return root ? { ...shape, root } : shape;
  }

  private write(drag: Drag): void {
    if (drag.inFlight || drag.sent === drag.ratio) return;
    drag.inFlight = true;
    drag.sent = drag.ratio;
    const end = (refusal: DividerRefusal) => {
      this.ended = Math.max(this.ended, drag.grab);
      if (this.drag === drag) this.drag = null;
      this.options.refused(refusal);
    };
    this.options.edit(dividerEdit(drag.name, drag.ratio)).then((answer) => {
      drag.inFlight = false;
      if (answer.reason === "stale") end({ code: "stale", reason: null });
      else if (this.drag === drag) this.write(drag);
    }, (error: unknown) => {
      drag.inFlight = false;
      end({ code: "layout_refused", reason: errorCode(error) });
    });
  }
}

import type { SplitTarget } from "./split.ts";

export interface WorkspaceDropTarget {
  machineId: string;
  workspaceId: string;
}

export interface TabWorkspaceMove {
  targets: ReadonlySet<string>;
  move: (workspaceId: string) => void;
}

export type ElementAtPoint = (x: number, y: number) => Element | null;

const defaultElementAt: ElementAtPoint = (x, y) =>
  typeof document === "undefined" || typeof document.elementFromPoint !== "function" ? null : document.elementFromPoint(x, y);

/**
 * Resolves a valid sidebar workspace row on `machineId` under `(x, y)` while dragging a single-pane
 * tab out of its strip, ignoring offline or inert containers and non-target rows.
 */
export function workspaceDropAt(
  x: number,
  y: number,
  machineId: string,
  targets: ReadonlySet<string>,
  elementAt: ElementAtPoint = defaultElementAt,
): WorkspaceDropTarget | null {
  if (targets.size === 0) return null;
  const hit = elementAt(x, y);
  const header = hit?.closest<HTMLElement>(".workspace-header") ?? null;
  if (!header || header.closest(".machine-offline, [inert], [hidden]") !== null) return null;
  const group = header.closest<HTMLElement>(".workspace-group[data-workspace]");
  const workspaceId = group?.dataset["workspace"];
  const machine = group?.closest<HTMLElement>(".machine-workspaces[data-machine]")?.dataset["machine"];
  if (!workspaceId || machine !== machineId || !targets.has(workspaceId)) return null;
  return { machineId, workspaceId };
}

/**
 * A tab dragged out of its strip (useTabReorder): the strip holds the pointer, so the pane area
 * never sees the drag.
 */
export interface PaneDrag {
  target: SplitTarget;
  point: { x: number; y: number } | null;
  workspaceTarget?: WorkspaceDropTarget;
}

let current: PaneDrag | null = null;
const listeners = new Set<() => void>();
let dropHandler: ((target: SplitTarget, x: number, y: number) => void) | null = null;
let workspaceMove: TabWorkspaceMove | null = null;

const set = (next: PaneDrag | null): void => {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
};

export const paneDrag = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  snapshot: (): PaneDrag | null => current,
  start(target: SplitTarget, moveToWorkspace?: TabWorkspaceMove): void {
    workspaceMove = moveToWorkspace ?? null;
    set({ target, point: null });
  },
  move(x: number, y: number): void {
    if (!current) return;
    const hit = workspaceMove ? workspaceDropAt(x, y, current.target.machineId, workspaceMove.targets) : null;
    const workspaceTarget = hit === null ? undefined
      : current.workspaceTarget?.machineId === hit.machineId && current.workspaceTarget.workspaceId === hit.workspaceId
        ? current.workspaceTarget
        : hit;
    set(workspaceTarget === undefined ? { target: current.target, point: { x, y } } : { target: current.target, point: { x, y }, workspaceTarget });
  },
  back(): void {
    if (current?.point || current?.workspaceTarget) set({ target: current.target, point: null });
  },
  drop(x: number, y: number): void {
    const held = current;
    const heldMove = workspaceMove;
    const hit = held && heldMove ? workspaceDropAt(x, y, held.target.machineId, heldMove.targets) : null;
    workspaceMove = null;
    set(null);
    if (hit !== null) {
      heldMove?.move(hit.workspaceId);
      return;
    }
    if (held) dropHandler?.(held.target, x, y);
  },
  cancel(): void {
    workspaceMove = null;
    set(null);
  },
  onDrop(handler: ((target: SplitTarget, x: number, y: number) => void) | null): void {
    dropHandler = handler;
  },
};

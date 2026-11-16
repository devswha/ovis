import type { HerdrPane, HerdrTab } from "../../../shared/protocol.ts";
import { adjacentTabBoundary } from "../../lib/tabOrder.ts";

type Tab = Pick<HerdrTab, "tab_id" | "workspace_id">;
type Pane = Pick<HerdrPane, "pane_id" | "tab_id" | "workspace_id" | "parent_pane_id">;

/** Presentation only: keep the authoritative order/IDs for menus, close and reorder. */
export function groupAgentTabs<T extends Tab>(tabs: readonly T[], panes: readonly Pane[], enabled: boolean, renaming?: string) {
  const byId = new Map(tabs.map((tab) => [tab.tab_id, tab]));
  const byPane = new Map(panes.map((pane) => [pane.pane_id, pane]));
  const parents = new Map<string, string>();
  if (enabled) for (const pane of panes) {
    const child = byId.get(pane.tab_id);
    const parent = pane.parent_pane_id ? byPane.get(pane.parent_pane_id) : undefined;
    if (child && parent && byId.has(parent.tab_id) && parent.tab_id !== child.tab_id && child.tab_id !== renaming
      && pane.workspace_id === parent.workspace_id && child.workspace_id === parent.workspace_id
      && byId.get(parent.tab_id)?.workspace_id === child.workspace_id) parents.set(child.tab_id, parent.tab_id);
  }
  const parentOf = new Map<string, string>();
  for (const tab of tabs) {
    const seen = new Set([tab.tab_id]);
    let root = tab.tab_id;
    while (parents.has(root)) {
      root = parents.get(root)!;
      if (seen.has(root)) break;
      seen.add(root);
    }
    // Cycles (including their descendants) have no visible root; keep them ordinary.
    if (!parents.has(root) && root !== tab.tab_id) parentOf.set(tab.tab_id, root);
  }
  const children = new Map<string, T[]>();
  const append = (parent: string, into: T[]): void => {
    for (const tab of tabs) if (parents.get(tab.tab_id) === parent && parentOf.has(tab.tab_id)) {
      into.push(tab);
      append(tab.tab_id, into);
    }
  };
  const visible = tabs.filter((tab) => !parentOf.has(tab.tab_id));
  for (const tab of visible) {
    const own: T[] = [];
    append(tab.tab_id, own);
    if (own.length) children.set(tab.tab_id, own);
  }
  const adjacentBoundary = (id: string, direction: -1 | 1): number | null => {
    const pool = parentOf.has(id) ? tabs.filter((tab) => parentOf.has(tab.tab_id) && parents.get(tab.tab_id) === parents.get(id)) : visible;
    const boundary = adjacentTabBoundary(pool.map((tab) => tab.tab_id), id, direction);
    if (boundary === null) return null;
    const neighbour = pool[direction === 1 ? boundary - 1 : boundary]!;
    return tabs.indexOf(neighbour) + (direction === 1 ? 1 : 0);
  };
  const dropBoundary = (id: string, target: string, after: boolean): number | null => {
    if (id === target || !parentOf.has(id) || !parentOf.has(target) || parents.get(id) !== parents.get(target)) return null;
    return tabs.findIndex((tab) => tab.tab_id === target) + (after ? 1 : 0);
  };
  return { tabs: visible, children, parentOf, adjacentBoundary, dropBoundary };
}

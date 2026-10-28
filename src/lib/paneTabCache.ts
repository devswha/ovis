import type { LayoutCell } from "./layoutMap.ts";

/**
 * How many tabs stay mounted on a PC canvas, the current one included: a return to any of them
 * draws its kept screen at once instead of a new terminal and attach. A hidden attached pane holds
 * no pty (#1061), so more of them cost only memory. A mirrored PC (no terminal attach) keeps 4: a
 * hidden mirrored pane keeps polling `pane.read`.
 */
export function paneTabCacheSize(mirrored: boolean): number {
  return mirrored ? 4 : 8;
}

/** Newest first, including the current tab and at most `size - 1` previous tabs. */
export function visitPaneTab(previous: readonly string[], current: string | null, liveTabs: ReadonlySet<string>, size = paneTabCacheSize(false)): readonly string[] {
  const surviving = previous.filter((id) => liveTabs.has(id) && id !== current);
  return current !== null && liveTabs.has(current) ? [current, ...surviving].slice(0, size) : surviving.slice(0, size);
}

/** Only previously mounted panes survive: new hidden splits must not acquire an attach. */
export function cachedPaneCells(
  tabs: readonly string[], current: string | null,
  panes: readonly { readonly pane_id: string; readonly tab_id: string }[],
  lastCells: ReadonlyMap<string, LayoutCell>, shownIds: ReadonlySet<string>,
): LayoutCell[] {
  const cachedTabs = new Set(tabs.filter((id) => id !== current));
  return panes.flatMap((pane) => {
    const cell = lastCells.get(pane.pane_id);
    return cachedTabs.has(pane.tab_id) && !shownIds.has(pane.pane_id) && cell ? [cell] : [];
  });
}

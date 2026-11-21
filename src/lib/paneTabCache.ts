import type { LayoutCell } from "./layoutMap.ts";

export function visitPaneTab(previous: readonly string[], current: string | null, liveTabs: ReadonlySet<string>): readonly string[] {
  const surviving = previous.filter((id) => liveTabs.has(id) && id !== current);
  return current !== null && liveTabs.has(current) ? [current, ...surviving].slice(0, 4) : surviving.slice(0, 4);
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

/**
 * The order panes keep in the canvas: a keyed child that changes rank is moved in the DOM by React,
 * and moving a frame resets the scrollTop of everything it scrolls (the chat view lands on its
 * oldest row). So a frame the tab already drew holds its place unless the layout itself reorders
 * what is drawn — an explicit swap, which moves the exchanged frames as it always did, keeping the
 * keyboard order on the visual one. A split inserts its pane at the new pane's layout place without
 * moving any frame (an insert moves no sibling), a cached pane keeps its place, and a tab switch
 * appends the presented frames instead of reordering the ones already mounted.
 */
export function orderedPaneCells<T extends { readonly paneId: string }>(
  previous: readonly string[], cells: readonly T[], drawn: ReadonlySet<string>,
): T[] {
  const byId = new Map(cells.map((cell) => [cell.paneId, cell]));
  const layoutsDrawn = cells.filter((cell) => drawn.has(cell.paneId));
  const known = layoutsDrawn.filter((cell) => previous.includes(cell.paneId));
  const order: T[] = [];
  // the drawn frames among the places drawn frames already held, in the layout's order; the two
  // counts are equal (both are the mounted drawn panes), so the queue never runs dry
  for (const id of previous) {
    const cell = byId.get(id);
    if (cell === undefined) continue;
    order.push(drawn.has(id) ? known.shift()! : cell);
  }
  for (const cell of layoutsDrawn.filter((candidate) => !previous.includes(candidate.paneId))) {
    // a split's pane goes where the layout puts it: before the next frame the layout draws after it
    const after = layoutsDrawn.slice(layoutsDrawn.indexOf(cell) + 1).find((candidate) => order.includes(candidate));
    order.splice(after === undefined ? order.length : order.indexOf(after), 0, cell);
  }
  const placed = new Set(order.map((cell) => cell.paneId));
  return [...order, ...cells.filter((cell) => !placed.has(cell.paneId))];
}

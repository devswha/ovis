import type { CSSProperties } from "react";
import { TAB_MIN_WIDTH, TAB_MORE_WIDTH, tabsInRow } from "../../lib/tabOverflow.ts";

export function forkTabGroupStyle(count: number): CSSProperties | undefined {
  return count ? { "--fork-chip-room": `calc(${count} * (var(--fork-chip-size, 24px) + 2px) + 4px)` } as CSSProperties : undefined;
}

/** Keep upstream's More behavior, budgeting each group's attached controls as well. */
export function forkTabsInRow(tabs: readonly { tab_id: string }[], children: ReadonlyMap<string, readonly unknown[]>, open: number, room: number, add: number, openWidth: number, keep = -1): number[] {
  if (!children.size) return tabsInRow(tabs.length, open, room, add, openWidth, keep);
  const widths = tabs.map((tab, index) => Math.max(index === open ? openWidth : TAB_MIN_WIDTH, TAB_MIN_WIDTH + ((children.get(tab.tab_id)?.length ?? 0) * 26 + (children.has(tab.tab_id) ? 4 : 0))));
  if (widths.reduce((sum, width) => sum + width, add) <= room) return tabs.map((_, index) => index);
  const pinned = new Set(keep >= 0 && keep < tabs.length ? [open, keep] : [open]);
  let left = room - add - TAB_MORE_WIDTH - [...pinned].reduce((sum, index) => sum + (widths[index] ?? 0), 0);
  for (let index = 0; index < tabs.length; index++) {
    if (pinned.has(index)) continue;
    const width = widths[index]!;
    if (width > left) break;
    pinned.add(index); left -= width;
  }
  return tabs.map((_, index) => index).filter((index) => pinned.has(index));
}

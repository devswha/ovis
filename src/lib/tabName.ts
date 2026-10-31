import type { HerdrTab, PaneInfo } from "../../shared/protocol.ts";
import { shortTabLabel, tabLabelKey } from "./tabLabels.ts";

/**
 * The name a tab was given, or null while herdr names it itself: by its place in the row ("2"),
 * which herdr moves up when a tab before it closes while the tab keeps its number.
 */
export function customTabLabel(tab: Pick<HerdrTab, "label" | "number">, place: number = tab.number): string | null {
  const label = tab.label.trim();
  return label === "" || label === String(place) ? null : label;
}

/** herdr names a tab by its place until it is renamed: the strip says so in words. */
export function tabLabel(tab: Pick<HerdrTab, "label" | "number">, t: (key: string, vars?: Record<string, string | number>) => string, place: number = tab.number): string {
  return customTabLabel(tab, place) ?? t("Tab {n}", { n: place });
}

type TabPane = Pick<PaneInfo, "pane_id">;

/**
 * The label a tab takes from its first message (lib/tabLabels.ts), and the whole line for its hover:
 * only while herdr names it by its number, never over a name someone gave it (Rename tab, the New
 * tab dialog's Name, a script, an agent's name typed as one). `panes` are the tab's, in the order
 * whose first line wins; null when none has one.
 */
export function autoTabLabel(tab: Pick<HerdrTab, "label" | "number">, panes: readonly TabPane[], machineId: string, labels: Readonly<Record<string, string>>, place: number = tab.number): { label: string; title: string } | null {
  if (customTabLabel(tab, place) !== null) return null;
  for (const pane of panes) {
    const line = labels[tabLabelKey(machineId, pane.pane_id)];
    if (line) return { label: shortTabLabel(line), title: line };
  }
  return null;
}

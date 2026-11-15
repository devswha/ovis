import type { ReactElement } from "react";
import type { RowMenuItem } from "../components/RowMenu.tsx";

/** Only the opt-in compact menu substitutes a tab's rename/close for its lone pane's. */
export function paneMenuItems(items: RowMenuItem[], tabs: RowMenuItem[], compact: boolean, lone: boolean, solo: boolean, zoomed: boolean): RowMenuItem[] {
  return items.filter((item) => (compact ? !lone || (item.id !== "rename" && item.id !== "close") : !tabs.some((tab) => tab.id === item.id))
    && (!solo || (item.id === "zoom" ? zoomed : item.id !== "split-right" && item.id !== "split-down")));
}

export function tabMenuHeader(compact: boolean, title: string, place: string, workspaces: boolean, sheet: boolean): { subtitle?: string; header?: ReactElement } {
  if (!compact) return { header: <span className="tab-strip-menu-target">{title}</span> };
  return { subtitle: workspaces ? undefined : place, header: workspaces || sheet ? undefined : <span className="tab-menu-place" title={place}>{place}</span> };
}

import type { PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";
import type { Translate } from "./i18n.ts";
import { tabLabel } from "./tabName.ts";

export const PANE_TABPANEL_ID = "pane-tabpanel";

export function paneTabPanelLabel(snapshot: SessionSnapshot | null, pane: PaneInfo | null, t: Translate): string | null {
  if (snapshot === null || pane === null) return null;
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === pane.workspace_id);
  const tab = tabs.find((candidate) => candidate.tab_id === pane.tab_id);
  return tab === undefined ? null : tabLabel(tab, t, tabs.indexOf(tab) + 1);
}

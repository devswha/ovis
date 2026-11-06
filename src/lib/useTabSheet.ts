import { useCallback, useState } from "react";

import { SHEET_QUERY } from "./sheets.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

/**
 * A phone's header title and the workspace's tabs it lists (TabStrip's sheet). At the sheets' width
 * no tab row is drawn (`tabsInHeader`); `sheet` is the title's button while the list is open. The
 * list goes when the screen widens past a phone or no pane is selected (`shown` false).
 */
export function useTabSheet(shown: boolean): { tabsInHeader: boolean; sheet: HTMLElement | null; toggle: (anchor: HTMLElement) => void; close: () => void } {
  const tabsInHeader = useMediaQuery(SHEET_QUERY);
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  if (sheet !== null && (!tabsInHeader || !shown)) setSheet(null);
  const close = useCallback(() => setSheet(null), []);
  const toggle = useCallback((anchor: HTMLElement) => setSheet((open) => open ? null : anchor), []);
  return { tabsInHeader, sheet, toggle, close };
}

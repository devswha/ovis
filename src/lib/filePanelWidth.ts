export type FilePanelKind = "file" | "browser";
export const FILE_PANEL_MIN_WIDTH = 320;
export const FILE_PANEL_MAX_WIDTH = 900;
const PANELS = {
  file: { key: "ovis:file-panel-width", min: FILE_PANEL_MIN_WIDTH, max: FILE_PANEL_MAX_WIDTH },
  browser: { key: "ovis:files-browser-width", min: 220, max: 600 },
};

export function filePanelMinWidth(kind: FilePanelKind = "file"): number { return PANELS[kind].min; }

export const FILE_PANEL_DOCK_QUERY = "(min-width: 980px)";
export const FILE_PANEL_WIDTH_STEP = 16;

export function filePanelMaxWidth(viewportWidth: number, sidebarWidth = 0, kind: FilePanelKind = "file"): number {
  const { min, max } = PANELS[kind];
  return Math.max(0, Math.min(
    Math.max(min, Math.min(max, Math.floor(viewportWidth * 0.6))),
    Math.floor(viewportWidth - sidebarWidth - 320),
  ));
}

export function clampFilePanelWidth(width: number, viewportWidth = Number.POSITIVE_INFINITY, sidebarWidth = 0, kind: FilePanelKind = "file"): number {
  const max = filePanelMaxWidth(viewportWidth, sidebarWidth, kind);
  return Math.round(Math.min(max, Math.max(filePanelMinWidth(kind), width)));
}

export function keyedFilePanelWidth(current: number, key: string, viewportWidth = Number.POSITIVE_INFINITY, sidebarWidth = 0, kind: FilePanelKind = "file"): number | null {
  if (key === "ArrowLeft") return clampFilePanelWidth(current + FILE_PANEL_WIDTH_STEP, viewportWidth, sidebarWidth, kind);
  if (key === "ArrowRight") return clampFilePanelWidth(current - FILE_PANEL_WIDTH_STEP, viewportWidth, sidebarWidth, kind);
  if (key === "Home") return clampFilePanelWidth(filePanelMinWidth(kind), viewportWidth, sidebarWidth, kind);
  if (key === "End") return filePanelMaxWidth(viewportWidth, sidebarWidth, kind);
  return null;
}

export function parseFilePanelWidth(stored: string | null, kind: FilePanelKind = "file"): number | null {
  if (stored === null || !/^\d+$/.test(stored)) return null;
  return clampFilePanelWidth(Number(stored), undefined, undefined, kind);
}

export function storedFilePanelWidth(kind: FilePanelKind = "file"): number | null {
  try {
    return parseFilePanelWidth(window.localStorage.getItem(PANELS[kind].key), kind);
  } catch {
    return null;
  }
}

export function storeFilePanelWidth(width: number | null, kind: FilePanelKind = "file"): void {
  try {
    if (width === null) window.localStorage.removeItem(PANELS[kind].key);
    else window.localStorage.setItem(PANELS[kind].key, String(clampFilePanelWidth(width, undefined, undefined, kind)));
  } catch {
    /* private mode: the width simply is not remembered */
  }
}

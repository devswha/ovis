export const SHEET_HISTORY_KEY = "ovis:sheet";
export const SHEET_UNDER_KEY = "ovis:sheet-under";
export const PLACE_KEY = "ovis:place";

export const SEEN_KEY = "ovis:seen";

export const FILE_PREVIEW_KEY = "ovis:file-preview";
export const REPO_DIFF_KEY = "ovis:repo-diff";

export const WEB_PANEL_KEY = "ovis:web-panel";
export const WEB_PANEL_DOCKED_KEY = "ovis:web-panel-docked";
export const WEB_PANEL_BELOW_KEY = "ovis:web-panel-below";

export function webPagesBelow(state: Record<string, unknown>): number {
  const below = state[WEB_PANEL_BELOW_KEY];
  return typeof below === "number" && Number.isInteger(below) && below > 0 ? below : 0;
}

export function overCopiedEntry(state: Record<string, unknown>, overlays: boolean): Record<string, unknown> {
  const owned = state[WEB_PANEL_KEY] !== undefined || state[WEB_PANEL_DOCKED_KEY] === true ||
    (overlays && (state[FILE_PREVIEW_KEY] !== undefined || state[REPO_DIFF_KEY] !== undefined));
  if (!owned && webPagesBelow(state) === 0) return state;
  return { ...state, [WEB_PANEL_BELOW_KEY]: webPagesBelow(state) + 1 };
}

export function withoutFile(state: unknown): unknown {
  if (state === null || typeof state !== "object") return state;
  const { [FILE_PREVIEW_KEY]: _file, ...rest } = state as Record<string, unknown>;
  return rest;
}

export function withoutWebPanel(state: Record<string, unknown>): Record<string, unknown> {
  const { [WEB_PANEL_KEY]: _page, [WEB_PANEL_DOCKED_KEY]: _docked, [WEB_PANEL_BELOW_KEY]: _below, ...rest } = state;
  return rest;
}

export const sheetStep: {
  lands: (event: Event) => boolean;
  goingBack: (state: unknown) => boolean;
  dropped: () => void;
  taking: (event: Event) => boolean;
  holds: (event: Event) => boolean;
} = { lands: () => false, goingBack: () => false, dropped: () => {}, taking: () => false, holds: () => false };

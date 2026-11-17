import type { SplitPaneDirection } from "../../shared/protocol.ts";
import type { ZoomMode } from "./layoutMap.ts";
import type { Machine } from "../../shared/machines.ts";
import type { TelemetryAction, TelemetryActionSource, TelemetryViewSource } from "../../shared/telemetry.ts";

export interface AddPcPreset { destination: string; name?: string }

export type PaneView = "chat" | "terminal";

export interface PaneControls {
  focusInput: () => void;
  scrollPage: (direction: -1 | 1) => void;
}

export interface AppActions {
  selectPane: (paneId: string) => void;
  selectAdjacentPane: (direction: -1 | 1) => void;
  selectAdjacentTab: (direction: -1 | 1) => void;
  selectTabNumber: (number: number) => void;
  selectAdjacentWorkspace: (direction: -1 | 1) => void;
  setView: (view: PaneView, source: TelemetryViewSource | null) => void;
  toggleView: (source: TelemetryViewSource) => void;
  counted?: (action: TelemetryAction, source: TelemetryActionSource) => void;
  focusInput: () => void;
  scrollPage: (direction: -1 | 1) => void;
  openNewSession: () => void;
  openNewTab: (target?: { machineId: string; workspaceId: string }) => void;
  renameTab: () => void;
  openTerminalTab: (target?: { machineId: string; workspaceId: string }) => Promise<void>;
  moveTabToWorkspace: (target: { machineId: string; tabId: string; workspaceId: string; notice?: boolean }) => Promise<void>;
  openSessionHistory: (target?: { machineId: string; workspaceId: string; agent?: string | null; scope?: "pane" | "workspace"; paneId?: string }) => void;
  openWorktree?: (mode: "create" | "open") => void;
  openPalette: (query?: string) => void;
  agentStarted: (machineId: string, paneId: string) => void;
  openFind: () => void;
  openSettings: () => void;
  openAddPc: (preset?: AddPcPreset) => void;
  connectPc: (machine: Machine) => void;
  toggleSidebar: () => void;
  inboxMode: { on: boolean; go: () => void } | null;
  openSidebarFilter: () => void;
  toggleTheme: () => void;
  /** Sign out of token/device authentication; null for automatic local/Tailscale access. */
  lock: (() => Promise<void>) | null;
  enableNotifications: (() => void) | null;
  refresh: () => void;
  openFiles: (() => void) | null;
  openLocalPage: ((url: string) => void) | null;
  searchConversation: (() => void) | null;
  /**
   * herdr's split beside the selected pane (its prefix+v and prefix+-), null without a pane. The
   * selection stays on this pane, as herdr's --no-focus keeps its focus, unless `focus` asks for
   * the new pane: then herdr focuses it and the app opens it.
   */
  splitPane: ((direction: SplitPaneDirection, focus?: boolean) => void) | null;
  zoomPane: ((mode: ZoomMode) => void) | null;
  toggleZoom: (() => void) | null;
  closePane: (() => void) | null;
  closeTab: (() => void) | null;
}

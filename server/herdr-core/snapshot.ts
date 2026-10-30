import type { AgentInfo, AgentStatus, PaneInfo, PaneLayoutSnapshot, PaneProcessInfo, SessionSnapshot, TabInfo, WorkspaceInfo } from "../../shared/herdr-api.generated.ts";

/**
 * How herdr-core's terminals look to the rest of the server: herdr's session snapshot, built from
 * hc's terminal records and the Herdr app's layout document.
 *
 * hc has no workspaces, tabs or panes. The Herdr desktop app keeps its own (spaces, tabs and split
 * trees) in the core's `herdr-app` document, and labels each terminal it starts with its space and
 * tab (`herdr.space`, `herdr.tab`). A space reads as a workspace, a tab as a tab and each terminal
 * block in the tab's tree as a pane, in the app's order. A live terminal no tab holds (a worker
 * another agent started, a terminal from `hc run`) gets a tab of its own in one more workspace.
 *
 * A pane's id is its terminal's address (`t7`): it lasts as long as the terminal does, as a herdr
 * pane id does, and a tab that gets a new terminal in the same block gets a new pane.
 */

/** The protocol these answers keep to: herdr's, as `shared/herdr-api.generated.ts` was made from. */
export const HERDR_PROTOCOL = 22;
export const OTHER_WORKSPACE_ID = "hc-other";
export const LAYOUT_DOC = "herdr-app";

/** One OSC 7501 report (hc's `Status`): the program's own words. */
export interface HcStatus { app?: string; state: string; title?: string; msg?: string }
export interface HcForeground { pid: number; name: string; argv?: string[]; cwd?: string }

/** The fields of hc's `Terminal` record this side reads. */
export interface HcTerminal {
  address: string;
  argv?: string[];
  cols: number;
  rows: number;
  cwd: string;
  pid?: number | null;
  name?: string | null;
  title?: string | null;
  state: string;
  status?: HcStatus | null;
  foreground?: HcForeground | null;
  labels?: Record<string, string>;
  turn?: number;
}

/** The one object guard of server/herdr-core/: hc's records and the app's document come from outside. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * hc stores the program's own status word (idle, working, done, blocked, error, …). herdr's
 * vocabulary is narrower: an error ends a turn the way done does, and a word neither knows says
 * nothing.
 */
export function agentStatusOf(status: HcStatus | null | undefined): AgentStatus {
  switch (status?.state) {
    case "working":
    case "blocked":
    case "idle":
    case "done":
      return status.state;
    case "error":
      return "done";
    default:
      return "unknown";
  }
}

/** The agent a status names; a terminal whose program never reported one runs none herdr would see. */
export function agentOf(terminal: HcTerminal): string | null {
  return terminal.status?.app || null;
}

const STATUS_RANK: Record<string, number> = { blocked: 4, working: 3, done: 2, idle: 1 };

/** A group's status is its most pressing pane's, as herdr's sidebar rolls it up. */
function rollUp(statuses: readonly AgentStatus[]): AgentStatus {
  let best: AgentStatus = "unknown";
  for (const status of statuses) if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[best] ?? 0)) best = status;
  return best;
}

/** The terminals a tab's split tree (the app's document: never trusted to have a shape) holds, in reading order. */
function terminalsIn(node: unknown, into: string[] = []): string[] {
  if (!isRecord(node)) return into;
  const content = node["content"];
  if (isRecord(content) && typeof content["terminal"] === "string") into.push(content["terminal"]);
  const children = node["children"];
  if (Array.isArray(children)) for (const child of children) terminalsIn(child, into);
  return into;
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

interface Group { id: string; label: string; tabs: { id: string; label: string; terminals: HcTerminal[] }[] }

/**
 * The app's spaces and tabs over the live terminals. A name the user gave wins; an unnamed space
 * or tab reads as the app labels its terminals (`where`: `<space> / <tab>`), and failing that as
 * its first terminal's folder, or its number.
 */
function groups(terminals: readonly HcTerminal[], layout: unknown): Group[] {
  const live = new Map(terminals.filter((terminal) => terminal.state === "live").map((terminal) => [terminal.address, terminal]));
  const placed = new Set<string>();
  const result: Group[] = [];
  const spaces = isRecord(layout) && Array.isArray(layout["spaces"]) ? layout["spaces"] : [];
  for (const space of spaces) {
    if (!isRecord(space) || typeof space["id"] !== "string" || !Array.isArray(space["tabs"])) continue;
    const group: Group = { id: space["id"], label: "", tabs: [] };
    for (const [index, tab] of space["tabs"].entries()) {
      if (!isRecord(tab) || typeof tab["id"] !== "string") continue;
      const held = terminalsIn(tab["root"]).map((address) => live.get(address)).filter((terminal): terminal is HcTerminal => terminal !== undefined && !placed.has(terminal.address));
      if (held.length === 0) continue;
      for (const terminal of held) placed.add(terminal.address);
      const where = held[0]!.labels?.["where"]?.split(" / ");
      const tabName = tab["name"];
      group.tabs.push({ id: tab["id"], label: typeof tabName === "string" && tabName ? tabName : where?.[1] ?? String(index + 1), terminals: held });
      if (!group.label) {
        const spaceName = space["name"];
        const folder = space["folder"];
        group.label = typeof spaceName === "string" && spaceName ? spaceName
          : where?.[0] ?? (typeof folder === "string" && folder ? basename(folder) : basename(held[0]!.foreground?.cwd ?? held[0]!.cwd));
      }
    }
    if (group.tabs.length > 0) result.push(group);
  }
  const rest = [...live.values()].filter((terminal) => !placed.has(terminal.address));
  if (rest.length > 0) {
    result.push({
      id: OTHER_WORKSPACE_ID,
      label: "Other terminals",
      tabs: rest.map((terminal) => ({ id: `${OTHER_WORKSPACE_ID}:${terminal.address}`, label: terminal.name || terminal.address, terminals: [terminal] })),
    });
  }
  return result;
}

function paneOf(terminal: HcTerminal, workspaceId: string, tabId: string): PaneInfo {
  const cwd = terminal.foreground?.cwd ?? terminal.cwd;
  return {
    pane_id: terminal.address,
    terminal_id: terminal.address,
    workspace_id: workspaceId,
    tab_id: tabId,
    agent: agentOf(terminal),
    agent_status: agentStatusOf(terminal.status),
    cwd,
    foreground_cwd: cwd,
    title: terminal.title ?? null,
    terminal_title: terminal.title ?? null,
    label: terminal.name ?? null,
    focused: false,
    revision: terminal.turn ?? 0,
  };
}

export function agentInfoOf(pane: PaneInfo): AgentInfo {
  return {
    pane_id: pane.pane_id,
    terminal_id: pane.terminal_id,
    workspace_id: pane.workspace_id,
    tab_id: pane.tab_id,
    agent: pane.agent ?? null,
    agent_status: pane.agent_status,
    cwd: pane.cwd ?? null,
    foreground_cwd: pane.foreground_cwd ?? null,
    title: pane.title ?? null,
    terminal_title: pane.terminal_title ?? null,
    focused: false,
    revision: pane.revision,
  };
}

/**
 * herdr's session snapshot of the core. Nothing has herdr's focus: the app keeps its own focus per
 * window, and no pane is in front of anyone the way a herdr TUI's is. Each pane's layout rect is
 * its terminal's own grid, the size an observer attaches at.
 */
export function buildSnapshot(terminals: readonly HcTerminal[], layout: unknown, version: string): SessionSnapshot {
  const workspaces: WorkspaceInfo[] = [];
  const tabs: TabInfo[] = [];
  const panes: PaneInfo[] = [];
  const layouts: PaneLayoutSnapshot[] = [];
  for (const [index, group] of groups(terminals, layout).entries()) {
    const groupPanes: PaneInfo[] = [];
    for (const [tabIndex, tab] of group.tabs.entries()) {
      const tabPanes = tab.terminals.map((terminal) => paneOf(terminal, group.id, tab.id));
      groupPanes.push(...tabPanes);
      tabs.push({ tab_id: tab.id, workspace_id: group.id, label: tab.label, number: tabIndex + 1, agent_status: rollUp(tabPanes.map((pane) => pane.agent_status)), focused: false, pane_count: tabPanes.length });
      layouts.push({
        workspace_id: group.id,
        tab_id: tab.id,
        area: { x: 0, y: 0, width: Math.max(...tab.terminals.map((terminal) => terminal.cols)), height: Math.max(...tab.terminals.map((terminal) => terminal.rows)) },
        focused_pane_id: tabPanes[0]!.pane_id,
        panes: tab.terminals.map((terminal, at) => ({ pane_id: terminal.address, focused: at === 0, rect: { x: 0, y: 0, width: terminal.cols, height: terminal.rows } })),
        splits: [],
        zoomed: false,
      });
    }
    panes.push(...groupPanes);
    workspaces.push({
      workspace_id: group.id,
      label: group.label,
      number: index + 1,
      active_tab_id: group.tabs[0]!.id,
      agent_status: rollUp(groupPanes.map((pane) => pane.agent_status)),
      focused: false,
      pane_count: groupPanes.length,
      tab_count: group.tabs.length,
    });
  }
  return {
    version,
    protocol: HERDR_PROTOCOL,
    workspaces,
    tabs,
    panes,
    layouts,
    agents: panes.filter((pane) => pane.agent).map(agentInfoOf),
    focused_workspace_id: null,
    focused_tab_id: null,
    focused_pane_id: null,
  };
}

/** herdr's `pane.process_info` for a terminal: its shell and what runs in front of it. */
export function processInfoOf(terminal: HcTerminal): PaneProcessInfo {
  const foreground = terminal.foreground;
  return {
    pane_id: terminal.address,
    shell_pid: terminal.pid ?? null,
    foreground_process_group_id: foreground?.pid ?? null,
    foreground_processes: foreground
      ? [{ name: foreground.name, pid: foreground.pid, argv: foreground.argv ?? null, argv0: foreground.argv?.[0] ?? null, cmdline: foreground.argv?.join(" ") ?? null, cwd: foreground.cwd ?? null }]
      : [],
  };
}

/**
 * herdr's key names (`Enter`, `Escape`, `ctrl+alt+shift+left`) as bytes typed into the terminal,
 * the way a terminal without extended keyboard modes sends them, or null for a key that has no
 * such encoding (hc's `terminal.keys` encodes those for the program's current modes).
 */
export function keyBytes(key: string): string | null {
  const name = key.toLowerCase();
  const plain: Record<string, string> = {
    enter: "\r", return: "\r", escape: "\x1b", esc: "\x1b", tab: "\t", backspace: "\x7f", space: " ",
    up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
    home: "\x1b[H", end: "\x1b[F", pageup: "\x1b[5~", pagedown: "\x1b[6~", delete: "\x1b[3~", insert: "\x1b[2~",
  };
  if (name in plain) return plain[name]!;
  const ctrl = /^(?:ctrl|c)[+-]([a-z])$/.exec(name);
  if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96);
  // one printable character types itself
  if ([...key].length === 1 && key >= " ") return key;
  return null;
}

/** herdr's key name as hc's `terminal.keys` names it (lowercase, `esc` for Escape). */
export function hcKeyName(key: string): string {
  const name = key.toLowerCase();
  if (name === "escape") return "esc";
  if (name === "return") return "enter";
  return name.replace(/^c-/, "ctrl+");
}

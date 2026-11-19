/**
 * The scenes herdr's TUI and the screen are compared in (docs/tui/visual-parity.md): four worlds of workspaces, tabs
 * and panes, the keys that open each scene from a world's first picture, and the sizes. Shared by the capture script
 * (tui/testing/herdr-capture.ts) and the parity cases (tui/view/parity.test.ts), so both sides get the same scene.
 */
import { join } from "node:path";

export const CAPTURE_FOLDER = join(import.meta.dir, "herdr-captures");
export const PARITY_SIZES = [[120, 40], [80, 24], [64, 20], [45, 30]] as const;

/** One pane of a world: where it stands, and the agent state its program reports, if any. */
export interface PaneSpec { readonly workspace: string; readonly tab: string; readonly name: string; readonly agent?: string; readonly state?: "working" | "blocked" | "done" | "idle" }

export interface World {
  readonly panes: readonly PaneSpec[];
  /** extra lines for herdr's config (its defaults otherwise) */
  readonly herdrConfig?: string;
  /** the first picture is complete */
  readonly ready: (text: string) => boolean;
}

export type WorldName = "main" | "agents" | "ended" | "empty";

export const WORLDS: Readonly<Record<WorldName, World>> = {
  /** two workspaces; the first has a tab split in two and a second tab */
  main: {
    panes: [
      { workspace: "work", tab: "one", name: "LEFT" },
      { workspace: "work", tab: "one", name: "RIGHT" },
      { workspace: "work", tab: "two", name: "SOLO" },
      { workspace: "docs", tab: "notes", name: "NOTES" },
    ],
    ready: (text) => text.includes("LEFT-READY"),
  },
  /** a plain shell in front, and one agent in each state in a second workspace */
  agents: {
    panes: [
      { workspace: "home", tab: "sh", name: "SHELL" },
      { workspace: "bots", tab: "run", name: "A-WORK", agent: "claude", state: "working" },
      { workspace: "bots", tab: "run", name: "A-BLOCK", agent: "codex", state: "blocked" },
      { workspace: "bots", tab: "wait", name: "A-DONE", agent: "gemini", state: "done" },
      { workspace: "bots", tab: "wait", name: "A-IDLE", agent: "opencode", state: "idle" },
    ],
    herdrConfig: "[ui.toast]\ndelivery = \"herdr\"\n",
    ready: (text) => text.includes("SHELL-READY"),
  },
  /** a split whose right pane's program ended */
  ended: {
    panes: [
      { workspace: "work", tab: "one", name: "LEFT" },
      { workspace: "work", tab: "one", name: "RIGHT" },
    ],
    ready: (text) => text.includes("LEFT-READY"),
  },
  /** nothing at all */
  empty: { panes: [], ready: () => true },
};

/** What opens a scene: keys typed, a click on the first label found, a drag over a text, an agent's report, a second viewer. */
export type SceneKeys =
  | { readonly kind: "type"; readonly text: string }
  | { readonly kind: "click"; readonly labels: readonly string[] }
  | { readonly kind: "drag"; readonly over: string }
  | { readonly kind: "report"; readonly pane: string; readonly state: "working" | "blocked" | "idle" | "done" }
  | { readonly kind: "viewer" };

export interface Scene {
  readonly id: string;
  /** what opens it on herdr and on the screen; absent: the world's first picture */
  readonly herdr?: SceneKeys;
  readonly ovis?: SceneKeys;
  /** what closes it on herdr (Esc when absent) */
  readonly herdrLeave?: SceneKeys;
  /** the keys may change nothing on herdr (it has no such screen) */
  readonly maySame?: boolean;
  /** nothing follows it in herdr's session */
  readonly last?: boolean;
  /** what herdr's picture must show before it is taken (a toast herdr shows a second after its event) */
  readonly expect?: RegExp;
  /** how long herdr's notice may stay before its first picture is back */
  readonly lingerMs?: number;
}

const PREFIX = "\x02";
const type = (text: string): SceneKeys => ({ kind: "type", text });
const both = (keys: SceneKeys) => ({ herdr: keys, ovis: keys });

export const SCENES: Readonly<Record<WorldName, readonly Scene[]>> = {
  main: [
    { id: "main" },
    { id: "prefix", ...both(type(PREFIX)) },
    { id: "help", ...both(type(`${PREFIX}?`)) },
    { id: "menu", herdr: { kind: "click", labels: ["menu", "switch"] }, ovis: type(`${PREFIX}\r`) },
    { id: "picker", ...both(type(`${PREFIX}g`)) },
    { id: "navigate", ...both(type(`${PREFIX}w`)) },
    { id: "confirm", ...both(type(`${PREFIX}D`)) },
    { id: "rename", ...both(type(`${PREFIX}T`)) },
    { id: "newtab", ...both(type(`${PREFIX}c`)) },
    { id: "agentlist", ...both(type(`${PREFIX}a`)), maySame: true },
    { id: "copy", ...both(type(`${PREFIX}[`)) },
    { id: "resize", ...both(type(`${PREFIX}r`)) },
    { id: "zoom", ...both(type(`${PREFIX}z`)), herdrLeave: type(`${PREFIX}z`) },
    { id: "collapsed", ...both(type(`${PREFIX}b`)), herdrLeave: type(`${PREFIX}b`), maySame: true },
    { id: "single", ...both(type(`${PREFIX}n`)), herdrLeave: type(`${PREFIX}p`) },
    { id: "settings", ...both(type(`${PREFIX}s`)), lingerMs: 8000 },
    { id: "toast", ...both({ kind: "drag", over: "line 2 of LEFT" }), expect: /copied/, lingerMs: 9000 },
    { id: "viewers", ...both({ kind: "viewer" }), maySame: true, last: true },
  ],
  agents: [
    { id: "agents" },
    { id: "agents-collapsed", ...both(type(`${PREFIX}b`)), herdrLeave: type(`${PREFIX}b`), maySame: true },
    { id: "agents-picker", ...both(type(`${PREFIX}g`)) },
    { id: "agents-list", ...both(type(`${PREFIX}a`)), maySame: true },
    { id: "agents-menu", herdr: { kind: "click", labels: ["menu", "switch"] }, ovis: type(`${PREFIX}\r`) },
    { id: "toast-agent", ...both({ kind: "report", pane: "A-WORK", state: "blocked" }), expect: /needs attention|claude waiting/, herdrLeave: { kind: "report", pane: "A-WORK", state: "working" }, lingerMs: 12000 },
    { id: "agents-tab", ...both(type(`${PREFIX}w\x1b[B\r`)), last: true },
  ],
  ended: [{ id: "ended" }],
  empty: [{ id: "empty" }, { id: "empty-prefix", ...both(type(PREFIX)), last: true }],
};

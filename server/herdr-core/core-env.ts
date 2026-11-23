/**
 * The environment a herdr-core that `ovis tui` starts runs in, after the user said yes (scripts/plugin-tui.ts). A core
 * hands the environment it started with to every pane for as long as it lives, so what names the launching terminal
 * or this program would outlive both in every later pane.
 */

import { SERVER_ENV } from "./hc-connect.ts";

/**
 * What names the launching terminal or session rather than the user: Bun's own switch to run as bare Bun, the pane of
 * another core this runs in (its terminal, that core's socket for its panes, its scope: a new core must not pass on
 * another core's pane), an SSH login's terminal and address, tmux, screen and an X window. A core started over SSH
 * would give every pane that login's agent socket, gone once the login ends; a local one keeps the user's.
 */
const LAUNCH_BOUND = new Set(["BUN_BE_BUN", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "SSH_TTY", "SSH_CONNECTION", "SSH_CLIENT", "TMUX", "TMUX_PANE", "STY", "WINDOWID"]);

/**
 * `base` without this program's own variables (SERVER_ENV, as the server keeps them from `hc connect`) and without
 * what names the launching terminal. HOME, the chosen core's HC_* and XDG_* stay: they say which core starts.
 */
export function coreLaunchEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const overSsh = (base["SSH_CONNECTION"] ?? "") !== "";
  return Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => {
    const [name, value] = entry;
    return value !== undefined && !SERVER_ENV.test(name) && !LAUNCH_BOUND.has(name) && !(overSsh && name === "SSH_AUTH_SOCK");
  }));
}

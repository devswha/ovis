import { folderName, shortPathTitle } from "../../shared/path-title.ts";

// shared with the server's push titles, which name a pane as the client's alerts do
export { folderName, shortPathTitle };

/**
 * Codex titles its terminal "<thread> | <project folder>" (0.162: "Respond to greeting |
 * worktree-rapid-valley..."). The row already says where under the title, in full, so the title
 * keeps the thread alone. A title that is only the place is left as it is.
 */
export function codexThreadTitle(title: string): string {
  const at = title.lastIndexOf(" | ");
  return at > 0 && title.slice(0, at).trim() !== "" ? title.slice(0, at) : title;
}

/** shell prompt titles: `user@host:` is chrome, the path after it is the information */
const SHELL_PREFIX = /^[^:@\s]+@[^:@\s]+:/;
/** Herdr's agent glyph and spinner are already represented by the row mark and badge. */
const AGENT_CHROME = /^π\s*[^\p{L}\p{N}\s]?\s*/u;

/**
 * A pane's live title without what is drawn beside it: a shell's `user@host:`, an agent's glyph and
 * spinner, and the folder Codex adds after its thread. `whole` keeps that folder: an alert is read
 * away from the row that says where the pane is.
 */
export function stripPaneChrome(title: string, agent: string | null | undefined, whole = false): string {
  const shellStripped = title.replace(SHELL_PREFIX, "");
  if (!agent) return shellStripped;
  const marked = shellStripped.replace(AGENT_CHROME, "");
  return agent === "codex" && !whole ? codexThreadTitle(marked) : marked;
}

/**
 * A pane's live title as the browser tab shows it: as a row's, with the agent's glyph and spinner
 * kept in front. The tab has no row mark or badge, so its title is where a working agent shows it
 * is working (#2568). The rest is shortened as a row's is, so a path after the mark is still its folder.
 */
export function tabTitle(title: string, agent: string | null | undefined): string {
  const rest = shortPathTitle(stripPaneChrome(title, agent));
  const mark = agent ? title.replace(SHELL_PREFIX, "").match(AGENT_CHROME)?.[0] ?? "" : "";
  return rest ? `${mark}${rest}` : "";
}

/**
 * A roster row drawn on two lines: what its pane is doing, and where under it. A shell's title
 * is often just its folder, which says nothing a workspace's name does not say better, so that
 * row leads with the workspace and keeps the second line for what is left to say.
 */
export function taskRowLines({ paneTitle, labelled, folder, workspace, alias }: {
  /** the pane's title as the roster shows it */
  paneTitle: string;
  /** the user named the pane: the name is kept as it is */
  labelled: boolean;
  /** the last folder of the pane's working directory */
  folder: string;
  /** the workspace's row name: its label, which herdr makes from the branch until its owner names it */
  workspace: string;
  /** a linked worktree's branch, when the label does not already say it */
  alias?: string | null;
}): { title: string; place: string } {
  const title = !labelled && paneTitle === folder ? workspace : paneTitle;
  const where = [workspace === title ? "" : workspace, alias && alias !== title && alias !== workspace ? alias : ""].filter(Boolean).join(" · ");
  const said = folder === title || folder === workspace || folder === alias;
  return { title, place: placeLine(where, said ? "" : folder) };
}

/** "workspace · folder", without saying the same name twice. */
export function placeLine(workspace: string, folder: string): string {
  return !folder || folder === workspace ? workspace : !workspace ? folder : `${workspace} · ${folder}`;
}

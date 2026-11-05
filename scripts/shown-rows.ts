/**
 * The rows a pane shows, for a browser regression to read its text from: libghostty's own rows while it
 * draws the pane (Settings > Terminal > Draw with libghostty, src/lib/ghostty/overlay.ts), where xterm's
 * are hidden and no longer redrawn; xterm's rows otherwise, and while a folded mirror (lib/terminalFold.ts)
 * hands the drawing back to xterm. `scope` narrows each alternative, e.g. ".pane-frame.is-current".
 */
export function shownRows(scope = ""): string {
  const at = scope ? `${scope} ` : "";
  return [
    `${at}.pane-terminal[data-renderer='ghostty']:not([data-folded]) .ghostty-text`,
    `${at}.pane-terminal:not([data-renderer='ghostty']) .xterm-rows`,
    `${at}.pane-terminal[data-folded] .xterm-rows`,
  ].join(", ");
}

/** One shown row each: libghostty's `.ghostty-row`, else xterm's row divs (see shownRows). */
export function shownRow(scope = ""): string {
  const at = scope ? `${scope} ` : "";
  return [
    `${at}.pane-terminal[data-renderer='ghostty']:not([data-folded]) .ghostty-row`,
    `${at}.pane-terminal:not([data-renderer='ghostty']) .xterm-rows > div`,
    `${at}.pane-terminal[data-folded] .xterm-rows > div`,
  ].join(", ");
}

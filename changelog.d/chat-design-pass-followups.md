### Fixed
- Moving a pane across workspaces now carries unsent prompt-card text safely (write-first and
  keep-on-conflict) so a subsequent herdr restart does not offer stale answers under the old pane
  ID (#3458).
- Removed redundant per-pane `/api/health` role fetches in `PaneTerminal`, relying on the already
  provided `deviceWatching` prop (#3458).
- Made the composer context ring keyboard-focusable on desktop with a focus tooltip showing the
  remaining context percentage and token counts (#3458).
- Live-updated relative timestamps while the Recover unsent text dialog stays open (#3458).
- Scoped the hidden-command suppression check to the active trigger prefix (`/` vs `$`) so `$`
  skill triggers are not suppressed by hidden `/` commands (#3458).

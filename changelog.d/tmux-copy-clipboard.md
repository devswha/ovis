### Added
- Settings → Terminal → Copies in tmux (off by default): while a pane that runs tmux is shown, a copy
  made in that tmux (copy mode, or a program's OSC 52) reaches the browser's clipboard, which herdr's
  terminal stream does not carry. Ovis adds its own hook to the running tmux and removes it when the
  setting is off or the pane is no longer shown; no tmux config file is changed.

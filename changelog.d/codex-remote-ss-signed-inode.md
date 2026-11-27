### Fixed
- Chat again shows the native conversation of a Codex TUI on the app server Ovis started beside it
  on Linux PCs whose `ss` prints socket numbers past 2^31 as negative (iproute2 6.1, as on Ubuntu
  24.04), instead of the terminal's scrollback.

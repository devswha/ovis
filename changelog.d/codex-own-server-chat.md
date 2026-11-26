### Fixed
- A Codex that Ovis starts on herdr-core now opens in Chat again, even after a long answer or a
  server restart. Ovis reads the conversation that Codex's own server for that pane holds open.
  After `/new` or a resume, while that server holds more than one conversation, the pane still
  falls back to the terminal.

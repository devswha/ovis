### Fixed
- A GJC pane whose turn ended while a background subagent or command it started still runs reads BG
  with its task count, not DONE, and alerts its finish once that work is delivered and answered.

### Fixed
- A Codex pane herdr reports no thread for no longer stays on "Conversation unavailable" in three
  cases: its last answer is longer than the screen or holds a code block, its last answer is a
  short word such as "ok", or a second Codex starts in its folder while its own screen has not
  changed. Chat still shows the terminal whenever the screen could be another conversation's: a
  prompt or a tool's output that quotes one, two conversations that ended on the same text, or,
  for a short answer on Windows, where the conversations Codex has loaded cannot be read. A pane
  whose chat only its last turn brought back shows the terminal again while its next turn runs.
  ([#3558](https://github.com/devswha/ovis/pull/3558),
  [#3559](https://github.com/devswha/ovis/pull/3559),
  [#3560](https://github.com/devswha/ovis/pull/3560) by @vibewriter-hand)

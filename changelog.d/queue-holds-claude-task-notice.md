### Fixed
- A message queued for a Claude Code pane no longer goes into the turn Claude just began by itself
  because a background task ended (a subagent, a background command, a monitor or a workflow): for
  up to a minute after that turn began it waits for the turn to end, whatever herdr reads the pane
  as meanwhile, as it already did after a `/loop` wakeup. When such a turn is interrupted, or ends
  in a session whose Claude Code writes no end-of-turn entry, the pane's queue can stay held for up
  to about a minute after the turn began though the pane shows as idle; Send now still sends a
  waiting message at once.

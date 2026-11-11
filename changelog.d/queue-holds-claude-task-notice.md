### Fixed
- A message queued for a Claude Code pane no longer goes into the turn Claude just began by itself
  because a background task ended (a subagent, a background command, a monitor or a workflow): for
  up to a minute after that turn began it waits for the turn to end, whatever herdr reads the pane
  as meanwhile, as after a `/loop` wakeup. When such a turn is interrupted, or ends in a session
  whose Claude Code writes no end-of-turn entry, the pane's queue can stay held for up to about a
  minute after the turn began though the pane shows as idle, and for as long as such turns keep
  beginning less than a minute apart; Send now still sends a waiting message at once. A turn that
  begins this way while a message is being typed, in the few tenths of a second between its paste
  and its Enter, leaves the text in Claude's input line, with the message marked as not confirmed,
  instead of sending it into that turn. This is most likely when the task ended during the turn the
  message was waiting behind.

### Fixed
- A message queued for a Claude Code pane no longer goes into the turn a `/loop` wakeup or another
  scheduled task just resumed: it waits for that turn to end, whatever herdr reads the pane as
  meanwhile. When such a turn is interrupted before it finishes, the pane's queue can stay held
  for up to a minute after the pane shows as idle; Send now still sends a waiting message at
  once. A wakeup that fires while a message is being typed, in the few tenths of a second between
  its paste and its Enter, leaves the text in Claude's input line, with the message marked as not
  confirmed, instead of sending it into that turn.

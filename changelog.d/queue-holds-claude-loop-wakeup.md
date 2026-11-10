### Fixed
- A message queued for a Claude Code pane no longer goes into the turn a `/loop` wakeup just
  resumed, in the moment before herdr reads that pane as working: it waits for that turn to end.
  A wakeup whose turn is interrupted before herdr read it, or that came due during a turn already
  at work which is then interrupted, holds the queue for a minute at most.

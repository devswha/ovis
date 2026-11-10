### Fixed
- A message queued for a Claude Code pane no longer goes into the turn a `/loop` wakeup just
  resumed, in the moment before herdr reads that pane as working: it waits for that turn to end.
  A wakeup whose turn was interrupted before herdr read it holds the queue for a minute at most.

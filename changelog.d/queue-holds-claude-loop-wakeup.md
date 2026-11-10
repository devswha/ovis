### Fixed
- A message queued for a Claude Code pane no longer goes into the turn a `/loop` wakeup or another
  scheduled task just resumed, in the moment before herdr reads that pane as working: it waits for
  that turn to end. A wakeup whose turn is interrupted holds the queue for a minute at most when
  herdr had not read that turn yet, when it is the first turn in that pane since Ovis started, or
  when the wakeup came due during a turn already at work. A wakeup that fires in the instant
  between a message's paste and its Enter leaves the text in Claude's input line, with the message
  marked as not confirmed, instead of sending it into that turn.

### Fixed
- A phone put away no longer keeps a read-only watch on its pane: a frozen page could not parse
  those frames, so the whole burst was drawn on return and a weak link's unacknowledged queue
  could close the connection (4008). Returning now attaches afresh, and the pane's replay draws
  the current screen.

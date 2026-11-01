### Fixed
- A hidden page (a phone put away, or a desktop window minimized or behind a full-screen app) no
  longer keeps a read-only watch on its pane: a frozen page could not parse those frames, so the
  whole burst was drawn on return and a weak link's unacknowledged queue could close the
  connection (4008). Returning attaches afresh, and the pane's replay draws the current screen; a
  window shown again without the focus watches its pane again.

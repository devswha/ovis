### Fixed
- A hidden page (a phone put away, or a desktop window minimized or behind a full-screen app) no
  longer watches its pane read-only, including one that opens or reconnects while hidden: a frozen
  page could not parse those frames, so the whole burst was drawn on return and a weak link's
  unacknowledged queue could close the connection (4008). The pane still reads as view only;
  returning attaches afresh and the pane's replay draws the current screen, and a window shown
  again without the focus starts watching its pane then.

### Fixed
- In a Codex pane of the Herdr app's terminals (herdr-core), a drag in the desktop terminal goes to
  Codex, which selects through its whole history, scrolls it while the drag is held past the top or
  bottom edge, and copies the selection on Ctrl+C or Enter. Before, Ovis made the selection, and it
  stopped at the screen's edge. Hold Shift (Option on a Mac) to select in Ovis instead. On herdr a
  Codex drag stays Ovis's, because herdr keeps no history for a program on the alternate screen and
  drops Codex's copy.

### Changed
- A terminal that is only following new output at the bottom reads its scroll position every 2 s
  instead of every 250 ms, so a busy pane no longer sends four requests a second. Scrolling,
  resizing, paging and search still read it at once.

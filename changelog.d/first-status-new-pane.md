### Fixed
- On classic herdr, the first status of a new pane is no longer lost when its agent reports within
  about half a second of the pane's creation, whether herdr focuses the pane or not and also on a
  server started before its engine: the page shows it at once, and that turn's end counts as a
  finish. After an engine restart this holds for a pane created once Ovis has reconnected.

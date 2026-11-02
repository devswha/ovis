### Fixed
- On herdr-core, closing a tab or pane in the Herdr app (or in Ovis) no longer sends a "terminal
  ended" notification, as closing one in herdr does not. A program that exits by itself, or is
  ended by a signal from elsewhere, still sends one.

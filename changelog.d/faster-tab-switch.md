### Changed
- Switching tabs is faster. A tab opened for the first time shows its screen and takes input
  sooner: the bridge passes an attach's screen on as soon as herdr draws it instead of holding it
  100 ms (a pane another web bridge held keeps the hold). Each pane area (each half in split view)
  keeps the last eight tabs ready to show at once, up from four; a PC whose panes are mirrored
  keeps four, since a hidden mirrored pane keeps reading its screen.

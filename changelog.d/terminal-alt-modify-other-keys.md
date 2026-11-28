### Fixed
- In the terminal, Alt with a letter (Alt+K and the like) now reaches a program that asked for
  xterm's modifyOtherKeys level 2, such as Pi with gentle-shell, the way Ghostty and xterm send it,
  so its Alt shortcuts work. Other programs still get ESC before the letter, and Option+Left/Right
  on a Mac still move by word. Not covered yet: a mirrored pane (Windows, or a PC without the PTY
  host) still sends ESC before the letter.

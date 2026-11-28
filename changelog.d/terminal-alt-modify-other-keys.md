### Fixed
- In the terminal, Alt with a letter (Alt+K and the like) now reaches a program that asked for
  xterm's modifyOtherKeys level 2, such as Pi with gentle-shell, the way Ghostty and xterm send it,
  so its Alt shortcuts work. Other programs still get ESC before the letter.

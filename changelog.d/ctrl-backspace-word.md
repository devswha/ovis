### Fixed
- Ctrl+Backspace in the terminal deletes the previous word, as Ctrl+W does.
  xterm was sending Ctrl+H, which deletes one character.

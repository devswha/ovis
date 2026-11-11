### Fixed
- An OpenCode chat paused with Ctrl+Z stays open when its shell runs many other processes, and when
  OpenCode's process was re-read without an ID or verified twice at once.
- A failed SSH tunnel to a PC shows ssh's own error first, without the lines ssh adds in verbose
  mode.

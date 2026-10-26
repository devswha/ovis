### Added
- Antigravity (Agy) chat on Windows: the pane's held conversation lock is found through the
  Restart Manager, so Chat reads the native conversation instead of falling back to terminal text.
  The first lock resolution scans the presence locks once, yielding between calls, and each pane
  re-validates its own lock per refresh; a process without a conversation, an unreadable creation
  time, or an ambiguous hold keeps Terminal.

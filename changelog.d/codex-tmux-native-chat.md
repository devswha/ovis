### Fixed
- Codex chat can read the native conversation of a Codex reached through a verified local tmux
  attachment, including a current Codex on the shared app-server daemon: the attached pane's own
  screen is matched as a direct pane's is. Dead, switched, ambiguous or unprovable attachments keep
  the terminal fallback instead of picking another session's conversation.

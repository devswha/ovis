### Fixed
- Recognize safely verified interpreter-launched Codex scripts behind tmux and refuse failed binding re-reads.
- Read native chats through verified outer shell ancestors of a tmux attachment.
- Ignore exited zombie processes when proving a tmux pane's live foreground Codex.
- Codex chat can read the native conversation through a verified local tmux attachment when one
  native Codex holds its rollout open, including a foreground shell launcher. Dead, switched or
  unprovable attachments keep the terminal fallback instead of selecting a conversation from a
  session hint or matching directory.

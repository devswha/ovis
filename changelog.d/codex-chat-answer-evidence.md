### Fixed
- A Codex pane's chat no longer shows another session's conversation from weaker screen evidence:
  it reads the screen only while a Codex process runs in the pane, a long answer must match the
  one shown symbol for symbol where that changes its meaning (`a < b` is not `a > b`), and a
  command Codex shows it ran or is running, and a tool's output, are not taken for an answer.
  When nothing proves the conversation, the pane shows its terminal.

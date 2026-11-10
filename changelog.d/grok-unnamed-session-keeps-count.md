### Fixed
- A grok pane keeps its background-task count, and the hold of a turn that ended on a task, when
  herdr names no session for it for a moment: the pane was looked up as another session, not
  found, and read as holding nothing for about ten seconds.

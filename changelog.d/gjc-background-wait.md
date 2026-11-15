### Fixed
- A GJC pane whose turn ended while a background subagent or command it started still runs reads BG
  with its task count, not DONE, and alerts its finish once that work is delivered and answered.
- A pane no longer keeps reading BG, or alerting a finished turn as still working, for an agent that
  left it: the wait on background work ends when another agent takes the pane or its agent exits.
  An OmO pane's wait, which has no time limit, could stay on a pane OmO had left.

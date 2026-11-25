### Fixed
- An Antigravity (agy) timer keeps its turn waiting until it is due even with a command running
  beside it, instead of letting go after 30 minutes.
- Opening a long Antigravity session no longer stalls the server while its background tasks are
  read: a long file is read a few megabytes at a time.
- A pane that switches from Antigravity to Grok while its session is being looked up no longer
  shows the Antigravity session's background tasks.

### Fixed
- Claude background-command history uses bounded asynchronous positional reads, so slow transcript
  storage no longer blocks the server while old task completions are checked. Changed transcripts
  are checked before historical completions are applied, preserving call and session ownership.

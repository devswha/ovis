### Fixed
- The background-command history of an old Claude transcript is read and rechecked with
  asynchronous reads, so slow transcript storage (an SSHFS home, for example) no longer holds the
  server while each 1 MiB is read. The time a session reads for before the next one's turn now
  counts only the work on what was read, so on such storage each read is taken in whole instead of
  one record at a time, which kept a large history reading for minutes. What the history tells is
  unchanged.

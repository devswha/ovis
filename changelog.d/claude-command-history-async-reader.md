### Fixed
- The background-command history of an old Claude transcript is read and rechecked with
  asynchronous reads, so slow transcript storage no longer holds the server for each 1 MiB it
  reads. What the history tells is unchanged.

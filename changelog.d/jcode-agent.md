### Added
- Jcode is a supported agent: the picker starts it in a pane, the catalog installs and detects it,
  the composer lists its skills, session history resumes a recent session by its id, and a pane
  running Jcode is read as Jcode rather than as the shell it was started from.
- A recent Jcode session's row keeps its start time: a generated session id carries the creation
  millisecond, so the row says when it started as well as when it last ran.

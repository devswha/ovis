### Fixed
- A chat whose transcript is rewritten in place while it keeps growing no longer shows the old
  history for one refresh: the read waits for the next refresh, which notices the rewrite.
- A chat whose transcript file is a symbolic link is read in one pass instead of three. Such a
  transcript is never digested, so a change of its times alone still reloads its history.

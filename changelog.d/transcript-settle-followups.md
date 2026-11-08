### Fixed
- A chat whose transcript is rewritten in place while it keeps growing no longer shows the old
  history: the read waits for one refresh, and a transcript still being written then reloads its
  history instead of waiting again.
- A chat whose transcript file is a symbolic link is read in one pass instead of three. Such a
  transcript is never digested, so any change to it (a change of its times alone, or an append)
  reloads its history.

### Fixed
- An install that finishes while another waits for it no longer fails with "Directory not empty"
  where `mkdir` does not refuse an existing folder (uutils coreutils): the install lock leaves in
  one rename, so the waiter that takes it next is never inside the folder being removed.

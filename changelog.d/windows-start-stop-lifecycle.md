### Fixed
- Ovis for Windows' Start no longer cuts off a server that is still coming up (started by herdr or a
  terminal moments before): its stop asks the server again once it has its turn, and leaves one that
  answers running.
- Ovis for Windows' Start also clears a recorded Ovis server that hangs while herdr is not running,
  instead of ending on "Not running" with no error.
- On Windows, `ovis stop` tells a recorded pid that another program now holds ("Ovis is not running
  (pid N now belongs to another process)", which Start goes on from) apart from a process it could
  not identify, which is reported as a failed stop, and it ends the server only through a handle
  whose creation time is the one it checked.

### Fixed
- Reading the background-command history of a long Claude transcript on slow storage, such as an
  SSHFS home, no longer blocks the server while each part of it is read, and reads each part once
  instead of once for every record in it.

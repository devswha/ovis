### Fixed
- On Windows, connecting to an SSH PC no longer sends its bridge's access token to another program
  that took the local tunnel port before ssh did: the connection now waits for ssh to report that
  its forward is open, and fails with ssh's own error when the port was taken.

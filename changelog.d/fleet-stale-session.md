### Fixed
- Right after a fleet batch is confirmed or the controller restarts, a machine's row no longer shows
  its ending session as online: it says the machine is reconnecting, and a launch made then waits
  briefly for the machine's new session instead of failing with a transport error.

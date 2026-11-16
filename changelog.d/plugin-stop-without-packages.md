### Fixed
- The herdr plugin's `stop` and `status` work in a checkout whose package install was cut off, so a
  server that runs from it can still be stopped: they no longer load the QR code's, the relay's or
  the account's packages, which only the commands that use them do.
- Phone setup run from a checkout passes a SIGTERM or SIGHUP on to the installed release it starts,
  instead of ending and leaving that release running in the pane.
- A command the herdr plugin's launcher runs that ends by a signal other than SIGHUP, SIGINT or
  SIGTERM now exits with 128 plus that signal's number (137 for SIGKILL), not 128.

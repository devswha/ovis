### Fixed
- Ovis for Windows' Update for a server under the old id installs the newest release even when
  the PC sets an older `OVIS_REF`, and an update that fails starts the server that ran before it
  again, with or without herdr running. A server that runs without the update supervisor, such as
  one just started whose supervisor has not reported yet, is no longer offered Update, and the
  version check waits once more for a server slow to answer and takes a token set only in the
  environment.

### Changed
- install.sh refuses a release whose PTY host does not match the SHA-256 and size its signed
  ovis-server.json names, and leaves the install as it was, instead of installing the server
  without the host.

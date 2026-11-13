### Changed
- An install from source now updates to the release's compiled server: the update downloads the binary
  and the client, checks them against the release's signed manifest, and switches over without
  changing the checkout or the app's state. A release that fails a check is not installed, and one whose
  files changed after it was installed is not run.

### Fixed
- Stopping Ovis while an installed update was still starting no longer drops that update, so the next
  start runs it again instead of the source checkout.
- The installers judge an install lock by its holder's start time too, so a reused process id no
  longer keeps a stale lock for ten minutes, and a release a running server was started from is kept
  until that server stops.

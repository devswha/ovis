### Changed
- An install from source now updates to the release's compiled server: the update downloads the binary
  and the client, checks them against the release's signed manifest, and switches over without
  changing the checkout or the app's state. A release that fails a check is not installed, and one whose
  files changed after it was installed is not run.
- An install still started by the launcher of Ovis 0.2.0 installs no further update by itself, and its
  Settings now say so. To move on, update its folder and restart Ovis:
  `git -C <the folder Ovis was installed in> pull --ff-only origin main` (for the herdr plugin:
  `herdr plugin update devswha.ovis`), then herdr's Stop Ovis and Start Ovis (or stop it and run
  `bun run start` in that folder). From then on it updates itself again.

### Fixed
- Stopping Ovis while an installed update was still starting no longer drops that update, so the next
  start runs it again instead of the source checkout.
- The installers judge an install lock by its holder's start time too, so a reused process id no
  longer keeps a stale lock for ten minutes, and a release a running server was started from is kept
  until that server stops.

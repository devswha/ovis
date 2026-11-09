### Fixed
- Connect SSH PCs running herdr-core through their own verified Ovis server, with a choice beside
  running herdr sessions and a runtime label on the PC. A stopped chosen Ovis asks the owner to start
  Ovis or choose a new herdr; PCs with no chosen runtime and no running sessions start herdr as before.
  An Ovis there that runs but cannot answer right now stays a choice instead of a new herdr being
  started, running herdr sessions are offered beside an older Ovis that does not list them, the
  bridge token never appears in a command on that PC, and the owner can list sessions on an Ovis
  without an access token from a paired device or their Tailscale login.

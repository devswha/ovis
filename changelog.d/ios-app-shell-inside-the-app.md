### Changed
- The iPhone and iPad app carries the hosted shell (Connect a PC, My PCs and every relay PC's page)
  and serves it from the app, with no network: My PCs opens at once offline, and an update to those
  screens comes with the app. Its pages moved to an address of the app's own, so after this update
  the app asks you to sign in once more, and a PC paired without an account needs pairing again;
  PCs opened at an address, over Tailscale or over SSH stay as they are.

### Maintenance
- `bun run build:web` puts the shell into the iOS build too (the same `app/bundled-shell` the
  Android build takes). `OVIS_APP_SHELL=hosted`, the default with `OVIS_APP_URL`, loads it from the
  network as before, for a preview app; the Xcode build refuses to archive that as `sh.ovis.app`.

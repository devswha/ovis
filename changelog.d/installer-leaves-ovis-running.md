### Changed
- The one-line installer now ends with Ovis running on a PC where herdr was not running (just
  installed, or stopped): it starts herdr's server headless, and the app with it, from a user
  service that starts herdr again at login, `ovis-herdr` on Linux and the Mac app's
  `sh.ovis.herdr-server` LaunchAgent on macOS. On Linux it turns on lingering when that needs no
  password, so herdr also starts at boot and keeps running after a logout. The service never stops
  herdr, a herdr that already runs is left as it is, and the guide's Uninstall removes the service.
  Its last lines say what runs, `ovis status` to see it and `ovis stop` to stop it.

### Added
- `curl -fsSL https://ovis.sh/install.sh | sh -s -- --add --account <id>` (or
  `OVIS_ADD_ACCOUNT=<id>`) adds a new server to your Ovis account with no terminal, as a script or a
  coding agent runs it: the installer runs `ovis add --account <id>` and exits non-zero when the PC
  was not added.

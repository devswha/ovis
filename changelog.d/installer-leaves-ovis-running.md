### Changed
- The one-line installer now ends with Ovis running on a PC where herdr was not running (just
  installed, or stopped): it starts herdr's server headless, and the app with it. On a PC used
  without a desktop it also sets up what starts herdr again: on Linux the user service `ovis-herdr`,
  only where lingering is on or can be turned on without a password, so herdr starts at boot and
  keeps running after a logout; on macOS the Mac app's `sh.ovis.herdr-server` LaunchAgent. In a
  desktop's session, without lingering, or with `--no-service` (`OVIS_NO_SERVICE=1`) it starts herdr
  once and sets up nothing, and it removes a service an earlier run set up once lingering is off. The service never stops herdr, a herdr that already runs is left as it
  is, and the guide's Uninstall removes the service. Its last lines say what runs, what starts it
  again, `ovis status` to see it and `ovis stop` to stop it.

### Added
- `curl -fsSL https://ovis.sh/install.sh | sh -s -- --add --account <id>` (or
  `OVIS_ADD_ACCOUNT=<id>`) adds a new server to your Ovis account with no terminal, as a script or a
  coding agent runs it: the installer runs `ovis add --account <id>` and exits non-zero when the PC
  was not added.

### Changed
- The Windows installer (`irm https://ovis.sh/install.ps1 | iex`) now ends with Ovis running on a PC
  where herdr was not running: it starts herdr's server with no window, and the app with it, in your
  signed-in desktop, also when it runs over SSH or from a coding agent's command, and sets herdr to
  start at your sign-in, the same Startup entry (`Ovis`) the Ovis app for Windows sets. It needs no
  administrator and sets up no Windows service. `-NoService` (`OVIS_NO_SERVICE=1`) starts herdr once
  and sets up no sign-in start. Over SSH with nobody signed in at the PC it starts nothing unless
  given `-Headless` (`OVIS_HEADLESS=1`), which starts herdr without a desktop. A herdr that already
  runs is left as it is.

### Added
- `& ([scriptblock]::Create((irm https://ovis.sh/install.ps1))) -Add -Account <id>` (or
  `OVIS_ADD_ACCOUNT=<id>` before `irm https://ovis.sh/install.ps1 | iex`) adds a Windows PC to your
  Ovis account with no terminal, as a script or a coding agent runs it: the installer runs
  `ovis add --account <id>` and fails when the PC was not added. `-Add` alone runs `ovis add` at a
  terminal.

### Added
- The installer puts an `ovis` command in `~/.local/bin` (Linux and macOS): `ovis add` adds the PC to
  your Ovis account from its terminal, `ovis pair` shows a pairing code and `ovis status` says whether
  the app runs. It finds the installed Ovis each time it runs, so updates need no new command, and
  on a plugin first installed before `ovis add` existed it runs the release that Settings → Updates
  installed. An `ovis` of your own, there or elsewhere on your PATH, is never replaced or hidden.
- `curl -fsSL https://ovis.sh/install.sh | sh -s -- --add` (or `OVIS_ADD=1`) ends the install by adding
  the PC to your account at the terminal; without a terminal to answer at, or while the app is not
  running yet, the installer prints the command to run. Its last lines now name `ovis add`, and say to set `OVIS_TOKEN` first on a PC other
  people log in to.

### Fixed
- On Windows, `scripts/plugin.ps1` passes a command's flags on (`plugin.ps1 link --code`) instead of
  dropping them.

### Added
- The installer puts an `ovis` command in `~/.local/bin` (Linux and macOS): `ovis add` adds the PC to
  your Ovis account from its terminal, `ovis pair` shows a pairing code and `ovis status` says whether
  the app runs. It finds the installed Ovis each time it runs, so updates need no new command, and an
  `ovis` of your own that is already there is left alone.
- `curl -fsSL https://ovis.sh/install.sh | sh -s -- --add` (or `OVIS_ADD=1`) ends the install by adding
  the PC to your account at the terminal; without a terminal to answer at, the installer prints the
  command to run. Its last lines now name `ovis add`, and say to set `OVIS_TOKEN` first on a PC other
  people log in to.

### Fixed
- On Windows, `scripts/plugin.ps1` passes a command's flags on (`plugin.ps1 link --code`) instead of
  dropping them.

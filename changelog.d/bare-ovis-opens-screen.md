### Changed
- `ovis` with no command, typed at a terminal on a PC with herdr-core, opens the terminal screen
  as `ovis tui` does (`ovis --session NAME` too). From a script, a pipe or a PC without herdr-core,
  plain `ovis` prints exactly what `ovis status` prints, with the same exit code.

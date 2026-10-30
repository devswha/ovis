### Added
- The agent picker of New workspace, New tab and New worktree ends with "Add another agent…": it shows
  the agents the PC does not have yet as the setup guide's tiles, installs the one you tap right
  there, then picks it.
- Settings → Agent integrations lists what the PC open there has, with versions, and the agents it
  can install as the same tiles; herdr's integrations stay below. "Open setup guide" at its top opens
  the first-run guide again.
### Fixed
- Opening the setup guide again from Settings no longer turns plan usage back on.
- An agent whose installer adds its folder to the login shell's PATH is offered in the agent picker
  once that PATH has it: the server reads it again for the install, and the dialog waits for up to
  a minute before saying it is not offered yet.

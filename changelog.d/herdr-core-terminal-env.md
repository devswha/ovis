### Fixed
- On herdr-core, terminals Ovis opens (the move from herdr's included) start in your login shell's
  environment, in colour, whatever process started the core: a core a coding agent's shell or a
  service started no longer turns colour off in every pane (Claude Code drew without highlights)
  or leaves out the sign-in tokens your profile exports.

### Changed
- The move to herdr-core says before it starts that each pane opens a new shell from your login
  profile, so variables set by hand in a pane stay behind.

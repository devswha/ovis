### Fixed
- An agent you reach only through a zsh or bash alias of its name (an old Claude Code install's
  `alias claude=~/.claude/local/claude`) is now offered and starts: Ovis reads where the alias points
  without running it, and on herdr-core starts that file with the chosen options.

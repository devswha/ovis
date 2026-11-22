### Changed
- A Claude Code that Ovis starts on this PC sends its Bash approvals to Ovis through Claude Code's
  own permission hook: the approval card shows the whole command, however the pane wraps it, and
  the card's Yes or No goes to Claude as the hook's answer instead of keys. Its other options, and
  a Claude started outside Ovis, still answer with keys; the terminal's own dialog stays usable.

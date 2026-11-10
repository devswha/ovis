### Fixed
- An Antigravity pane no longer shows another process's conversation, or the greeting of a new
  one, when its agent exits and that process number is reused while Ovis looks the conversation
  up: the pane's process is asked of herdr again after its locks are read, and the answer stands
  only when it is still the same process.

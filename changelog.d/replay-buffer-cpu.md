### Changed
- The server uses about half the CPU it did while several terminals print busily: the replay kept
  for a late joiner no longer re-encodes its whole tail on every chunk of output.

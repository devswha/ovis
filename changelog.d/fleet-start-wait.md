### Added
- Fleet: `ovis wait <machine> <terminal> --until idle,blocked,done [--timeout <seconds>]` waits for a terminal's
  shown state on a fleet machine and exits 0, 124 when the timeout passes first, or 3 when the program ended first.

### Fixed
- Two Ovis servers that find a dead holder of a herdr session's move lock can no longer both move it: the
  lock is now one the kernel alone arbitrates (an abstract socket on Linux, flock on macOS), with nothing
  removed to take it. A refused move no longer advises deleting the lock socket.

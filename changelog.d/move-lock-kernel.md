### Fixed
- Two Ovis servers that find a dead holder of a herdr session's move lock can no longer both move it: the
  lock is now one the kernel alone arbitrates (flock on a file in the session's folder, or an abstract
  socket on Linux where no C library can be loaded), with nothing removed to take it. A refused move no
  longer advises deleting the lock socket.

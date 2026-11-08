### Added
- Experimental, off by default (Settings → Experimental → PCs → Start a replaced server again): an
  install over SSH that replaces a server started by hand, and then fails or is cancelled before
  anything was installed or launched in its place, starts that server again as it was (the same
  program, arguments, folder and environment, its token included) on Linux. It is not started again
  once a replacement may be on its way, when another server holds its address or the session's
  socket, or where no faithful copy of it can be made (macOS among them); the job then says so. When
  off, a failed replacement leaves that server stopped, as before.

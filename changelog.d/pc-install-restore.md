### Fixed
- An install over SSH that replaces a server started by hand, and then fails or is cancelled before
  anything was installed or launched in its place, starts that server again as it was (the same
  program, arguments, folder and environment, its token included) on Linux, instead of leaving the PC
  without Ovis. It is not started again once a replacement may be on its way, when another server
  already holds its address, or where no faithful copy of it can be made (macOS among them); the job
  then says so.

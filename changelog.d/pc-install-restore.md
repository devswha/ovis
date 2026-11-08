### Fixed
- An install over SSH that replaces a server started by hand and then fails or is cancelled starts
  that server again as it was (the same command, folder and environment, its token included) on
  Linux, instead of leaving the PC without Ovis.

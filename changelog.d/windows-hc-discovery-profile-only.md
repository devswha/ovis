### Fixed
- On Windows, Ovis no longer runs an `hc` it finds on the PATH outside your profile folder (such as
  `C:\tools`, which every account on the PC can write) while it looks for herdr-core. Set
  `OVIS_HC_BIN` to use an `hc` kept elsewhere.

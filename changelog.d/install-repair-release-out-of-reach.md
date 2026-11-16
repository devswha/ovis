### Fixed
- On Windows, `install.ps1` run again with `OVIS_REF` over a branch no longer stops Ovis to rebuild
  it while the release cannot be reached and the release's binary kept in the checkout does not run
  for its version without it: if that build failed too (offline), herdr could not start Ovis again
  until the release was back. It says so, and nothing is stopped or changed. The commands it prints
  to build the checkout work when pasted for a path with an apostrophe (`C:\Users\O'Brien\...`), and
  the steps after a build during which the checkout moved to another version are one command per
  line.

### Fixed
- On Windows, installing a branch or a commit with `install.ps1` (`OVIS_REF`) builds it from its own
  sources, as `install.sh` does, instead of failing with "Cannot find module" while herdr runs. Running
  it again with `OVIS_REF` naming that branch or commit builds a branch an earlier install left on the
  release's binary from source; a build that fails or is cut off is built again by the next run, and
  `OVIS_REF` naming another branch or commit than the installed one says so and changes nothing.

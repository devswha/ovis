### Fixed
- On Windows, installing a branch or a commit with `install.ps1` (`OVIS_REF`) builds it from its own
  sources, as `install.sh` does, instead of failing with "Cannot find module" while herdr runs.

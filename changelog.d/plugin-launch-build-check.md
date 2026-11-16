### Changed
- The herdr plugin's launcher no longer starts a checkout that runs from source without a finished
  build (no packages, no built client, or a build that did not finish), unless an earlier start or
  build step already chose the sources for this version: it says what is missing and the command
  that builds it. A finished build of another version or commit still starts, with a notice that
  names both and the command that rebuilds it.

### Fixed
- The herdr plugin's stop and status actions run the checkout's own stop and status whenever the
  release's compiled server cannot be had, also while the release cannot be reached, so an Ovis
  running from that checkout can still be stopped.

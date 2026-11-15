### Changed
- install.sh takes the latest release of an https mirror (`OVIS_RELEASES_URL`) from the mirror's `latest` file. On a
  mirror, a run without `OVIS_REF` (and a fleet machine's run again) no longer installs a release older than the one
  installed, and a release without its signed `ovis-server.json` is refused instead of installed from source. GitHub's
  own address behaves as before.

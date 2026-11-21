### Maintenance
- CI: a pull request that changes the desktop app runs the app's unit tests, its type check and one
  build (Linux x64) in one job instead of five builds. The five builds run every day on main, at a
  release, and for a pull request that changes the build workflow itself.

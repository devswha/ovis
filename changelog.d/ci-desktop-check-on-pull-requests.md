### Maintenance
- CI: a pull request that changes the desktop app runs the app's unit tests, its type check and one
  build (Linux x64) on the self-hosted runners instead of five builds on GitHub's. The five builds run
  every day on main, at a release, and for a pull request that changes the build workflow itself.

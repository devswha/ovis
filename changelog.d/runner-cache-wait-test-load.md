### Maintenance
- The self-hosted runner launcher's tests of a hung first cache refresh no longer fail on a loaded
  host: they wait up to 30 s for the refresh to hang and for the launcher to end instead of Bun's
  5 s test timeout, no runner starts before the refresh has hung, and only the stop on SIGTERM
  keeps a tight bound (4 s) (#2261).

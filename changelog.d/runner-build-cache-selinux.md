### Maintenance
- Self-hosted CI runner: under SELinux (an EL host such as the rented server), `run.sh --build-cache`
  labels the cache and the slots' outboxes `container_file_t` when it starts, so jobs can read the
  cache and hand in their builds; before, every hand-in failed with "Permission denied" and the
  cache stayed empty. A host where the labelling fails runs without the build cache and says so.
  Every launcher on a runner host must be replaced by the new `run.sh` and restarted.

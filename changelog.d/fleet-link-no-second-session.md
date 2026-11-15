### Fixed
- A fleet machine no longer opens a direct session beside the relay session it has just signed in
  on. The controller quarantined such a machine at the end of its 10 s switch window and every
  launch on it failed. This happened most often right after the owner confirmed a machine, and on
  a busy controller.

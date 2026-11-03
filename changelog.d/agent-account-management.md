### Fixed
- Agent accounts can be removed from Ovis with confirmation without signing out their CLIs or deleting
  credentials. Removal survives restarts; completing a browser sign-in restores only that account.
- A failed browser re-login no longer appears to have finished successfully just because other
  accounts remain signed in.

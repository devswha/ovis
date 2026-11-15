### Fixed
- The machine profile and the fleet bridge take a herdr-core socket only when its whole path is the
  account's: every folder and link on the way belongs to the account or root, no folder is writable
  by another account, and the socket is the account's own and not a link. They connect to the real
  path that check reached, so a link changed later redirects nothing. A check that refuses, or a
  core that is gone, closes the open connection at once and serves nothing of that core until a
  check passes again. `OVIS_HC_ENV` no longer redirects their connections.

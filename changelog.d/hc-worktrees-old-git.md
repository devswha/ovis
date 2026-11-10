### Fixed
- With herdr-core, New worktree, Open worktree… and Delete worktree checkout… work on a PC whose
  git is older than 2.36, such as Ubuntu 22.04's git 2.34: each failed there with git's
  `unknown switch` usage text
  ([#3478](https://github.com/devswha/ovis/issues/3478), reported by @datacas).

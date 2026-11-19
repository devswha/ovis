### Fixed
- On a herdr-core server, a repository's workspace whose shell went into one of its worktrees stays
  the repository's row after Ovis restarts or updates. It was drawn as that worktree, and Delete
  worktree checkout… on it deleted the other workspace's checkout.
- On a herdr-core server, Delete worktree checkout… is refused while another workspace is open on
  that checkout, instead of leaving that workspace in a deleted folder.
- On a herdr-core server, a workspace in a folder where git answers slowly (a network folder, a very
  large repository) no longer slows every sidebar refresh by 2 seconds, and nests under its
  repository as soon as git answers.

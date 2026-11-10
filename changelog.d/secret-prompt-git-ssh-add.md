### Fixed
- A queued or inserted message is no longer typed into a password asked by `git` over HTTPS
  (`Password for 'https://you@host':`), a key passphrase asked by `ssh-add` or `ssh-keygen`
  (`Enter passphrase for /home/you/.ssh/id_ed25519:`) or the password of an SSH host given as an
  IPv6 address: it waits, as it already did at `sudo`'s and `ssh`'s prompts. The same holds for a
  key whose path has `y/n` in it (`/home/andy/notes/key`), which was taken for a yes/no question.

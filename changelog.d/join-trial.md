### Added
- A trial way to add a Linux machine to an Ovis account by one pasted line, under the fleet preview
  (`scripts/join/`, not shipped by any release or installer): the line fetches `join.sh` and runs it
  only if its SHA-256 is the one the line names; `join.sh` checks every file of its kit against the
  kit's `SHA256SUMS` before it uses it, asks before it changes anything, installs a machine profile
  server (`OVIS_PROFILE=machine`, `OVIS_PREVIEW=fleet`) for the user who runs it into
  `~/.local/share/ovis-trial` with one systemd user unit, and runs `add` for it. It never uses root
  or sudo, and its printed undo line removes everything it made.

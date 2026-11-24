#!/bin/sh
# The App target's "Carry the shell" phase, after its resources are copied and before the app is signed: puts the shell
# `bun run build:web` packed into app/bundled-shell (app/scripts/bundled-shell.ts: shell/ and shell-policy.json) into the
# app as `bundled-shell`, where ShellHost.swift reads it, in a build that serves the shell itself (OVIS_APP_SHELL
# `bundled`); and takes out one an earlier build of the same folder left, so a build that loads the shell from the
# network carries none. That folder is absent in such a build, which is why the project does not reference it.
# check-hosted-origin.sh has already failed a build whose folder is not what OVIS_APP_SHELL says.
# Usage: carry-shell.sh <OVIS_APP_SHELL> <app/bundled-shell> <the built app's resources folder>
rm -rf "$3/bundled-shell"
if [ "$1" = "bundled" ]; then
  cp -R "$2" "$3/bundled-shell" || { echo "error: could not copy $2 into the app"; exit 1; }
fi

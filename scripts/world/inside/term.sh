#!/bin/sh
# Runs a command line on a machine's own terminal (a pty from script(1), 120x60), detached from whoever started it,
# with the machine's server environment, in the checkout. The screen is recorded to ~/term-<label>.out; a line written
# to ~/term-<label>.in is typed into it. Usage (inside a machine container): WORLD_TERM_CMD=<command line> sh term.sh <label>
# (machines.ts hands the command line over in docker exec's environment, so it is on no command line of the PC).
set -eu
label=$1; shift
in="$HOME/term-$label.in"; out="$HOME/term-$label.out"
rm -f "$in" "$out"; mkfifo "$in"
# the fifo's write end stays open, so the terminal's input never ends on its own
tail -f /dev/null > "$in" &
holder=$!
# the command line travels in the environment and runs through eval, so it is no process's argument in the machine
# either (ps shows `sh -c eval "$WORLD_TERM_CMD"`); script(1) gets no shell quoting of ours to break
: "${WORLD_TERM_CMD:?term.sh needs WORLD_TERM_CMD}"
export WORLD_TERM_CMD
script -qfec 'stty rows 60 cols 120; eval "$(bun /opt/world/inside/machine.ts env)"; cd "${WORLD_REPO:-/opt/ovis}"; exec sh -c '\''eval "$WORLD_TERM_CMD"'\''' "$out" < "$in" > /dev/null 2>&1 || true
echo "[term.sh: exited]" >> "$out"
kill "$holder" 2>/dev/null || true

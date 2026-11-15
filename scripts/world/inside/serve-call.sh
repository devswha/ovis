#!/bin/sh
# One call to an Ovis server a machine runs: through the unix socket <state folder>/serve.sock when the server has
# one, over TCP at <tcp origin> otherwise. Either way the URL is <tcp origin><route>, so the server sees the same Host
# (and an Origin header matching it) on both. Health is not called through here: it is read over TCP. stdin and every
# curl argument go to curl as they are (a `--config -` header, `-H @file`, a body).
# A serve.sock that nothing answers on fails loudly, with no fallback to TCP.
#   sh serve-call.sh <state folder> <tcp origin> <route> [curl arguments ...]
set -eu
[ $# -ge 3 ] || { echo "usage: serve-call.sh <state folder> <tcp origin> <route> [curl arguments ...]" >&2; exit 2; }
state=$1; origin=$2; route=$3; shift 3
case $route in /*) ;; *) echo "serve-call.sh: a route starts with /: $route" >&2; exit 2 ;; esac
sock="$state/serve.sock"
[ -S "$sock" ] || exec curl "$@" "$origin$route"
code=0
curl --unix-socket "$sock" "$@" "$origin$route" || code=$?
# 7: curl could not connect, which through a unix socket means no server holds it
[ "$code" -eq 7 ] && echo "serve-call.sh: $sock exists but nothing answers on it (curl exit 7); not falling back to TCP" >&2
exit "$code"

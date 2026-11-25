#!/usr/bin/env bash
# Reads a pull request's changed paths, one a line, and prints server=false when every one of them is the client's
# own (src/, public/, index.html) or a changelog fragment, server=true otherwise. The jobs it gates (herdr-core live
# contract, Rust PTY host, Native macOS session identity) build crates/ and run bun tests of server/, shared/, tui/
# and scripts/, none of which loads a file of those paths, and none of them builds the client: Fast checks,
# Integration tests and the Browser regression jobs keep testing the client. Any other path keeps the jobs, and
# so does a path this script cannot read; scripts/ci-server-reach.test.ts fails when a file those jobs' tests
# load is left out.
set -euo pipefail

client='^(src|public|changelog\.d)/.|^index\.html$'

seen=0
while IFS= read -r path || [ -n "$path" ]; do
  [ -n "$path" ] || continue
  seen=1
  if [[ $path =~ $client ]]; then continue; fi
  echo "server=true"; exit 0
done
if [ "$seen" = 1 ]; then echo "server=false"; else echo "server=true"; fi

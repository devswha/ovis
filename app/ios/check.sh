#!/bin/sh
# The iOS app's own checks, which no CI job runs: on a Mac with Xcode, before an upload (app/store/ios.md) and after a
# change under app/ios. The decisions the app only carries out are in three Swift packages (`swift test`): which screen
# opens and what a page may ask (OvisHomeCore: the routes and policies of the shell inside the app, the bridge's gate),
# SSH (OvisSshCore) and push (OvisPushCore); two files of the App target have checks of their own.
# Usage: sh app/ios/check.sh
set -e
ios=$(cd "$(dirname "$0")" && pwd)
for package in OvisHomeCore OvisSshCore OvisPushCore; do
  echo "== swift test: $package"
  (cd "$ios/$package" && swift test 2>&1 | tail -3)
done
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
echo "== ScopePath"
swiftc "$ios/App/App/ScopePath.swift" "$ios/ScopePathCheck/main.swift" -o "$out/scope" && "$out/scope" | tail -1
echo "== OpeningWatch"
swiftc "$ios/App/App/OpeningWatch.swift" "$ios/OpeningWatchCheck/main.swift" -o "$out/watch" && "$out/watch" | tail -1
echo "the iOS app's checks passed"

#!/usr/bin/env bash
# Reads a pull request's changed paths, one a line, and prints browser=false when none of them can reach the
# Browser regression jobs, browser=true otherwise. Those jobs build the client and start the server, the relay
# shell, the demo and the desktop harness, so only what none of that loads is left out: documentation, unit
# tests (Fast checks and Integration tests run them), the terminal client, the two workers, the phone and
# native apps' own folders, the installers, the runner launcher, and every workflow but ci.yml. A path this
# list does not name keeps the jobs: a new folder runs them until it is added here.
set -euo pipefail

docs='^docs/|\.(md|txt)$|^LICENSE$'
apart='^(tui|crates/ovis-tui|push-relay|telemetry|ovis-site|app/(android|ios|mac|windows|store|assets)|evidence|\.claude|scripts/self-hosted-runner)/|^(\.coderabbit\.yaml|\.gitattributes|\.gitignore|install\.sh|install\.ps1)$'
tests='^(server|src|shared|scripts|app|relay)/.*\.test\.tsx?$'
workflows='^\.github/'
ci='^\.github/(workflows/ci\.yml$|actions/)'

paths=$(grep -v '^$' || true)
if [ -z "$paths" ]; then echo "browser=true"; exit 0; fi
if grep -q '^server/fixtures/' <<<"$paths"; then echo "browser=true"; exit 0; fi
reaching=$(grep -vE "$docs" <<<"$paths" | grep -vE "$apart" | grep -vE "$tests" | { grep -vE "$workflows" || true; } || true)
ci_changes=$(grep -E "$ci" <<<"$paths" || true)
if [ -n "$reaching" ] || [ -n "$ci_changes" ]; then echo "browser=true"; else echo "browser=false"; fi

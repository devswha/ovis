#!/usr/bin/env bash
# Mac runner heartbeat (README "Mac runner"): while the runner named $MAC_RUNNER_NAME is online, sets
# the repository variable CI_MAC_RUNNER_SEEN to the current epoch seconds, which
# scripts/ci-mac-runner-route.sh requires to be fresh before it sends a job to the Mac. Listing
# runners needs a token with administration access, which the workflow token lacks, so this runs
# outside Actions (a systemd user timer on the maintainer PC) with the maintainer's `gh`. An offline
# runner or a failed call writes nothing: the value ages and the route goes hosted.
set -euo pipefail

repo="${REPO:-devswha/ovis}"
name="${MAC_RUNNER_NAME:-eamac-ovis-mac}"

status=$(gh api --paginate "repos/$repo/actions/runners?per_page=100" |
  jq -r --arg name "$name" '.runners[] | select(.name == $name) | .status')
if [[ "$status" != online ]]; then
  echo "runner $name is ${status:-not registered}: heartbeat not written" >&2
  exit 0
fi
gh variable set CI_MAC_RUNNER_SEEN --repo "$repo" --body "$(date +%s)"

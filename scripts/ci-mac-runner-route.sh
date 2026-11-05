#!/usr/bin/env bash
# Picks the runner for the macOS jobs (ci.yml's Native macOS session identity, remote-bundles.yml's
# macos-15 bundle) and prints `macos=<json>` for $GITHUB_OUTPUT: the maintainer's Mac runner
# (scripts/self-hosted-runner/README.md "Mac runner", label self-hosted-ovis-mac) while it looks
# online and free, GitHub's macos-15 otherwise.
#
# Only a same-repository pull request and a push to main may go to the Mac; a fork pull request,
# a tag, a dispatch or a release run always gets macos-15. The workflow token cannot list runners,
# so "online" comes from the repository variable CI_MAC_RUNNER_SEEN: the epoch seconds at which
# scripts/self-hosted-runner/mac-heartbeat.sh, run every minute with an admin token, last saw the
# runner online. Unset or older than MAC_SEEN_SECONDS (default 300) keeps the job hosted, so a job
# is never sent to a Mac that is already offline. The Actions API then guards the rest: a job that
# has waited for that label longer than MAC_STALE_MINUTES (default 10) means the Mac is stuck, and
# MAC_MAX_JOBS (default 2) unfinished jobs on it means it is busy; either keeps the job hosted, as
# does an API failure. The
# repository variable CI_MAC_SELF_HOSTED_LABELS set to "macos-15" keeps every macOS job hosted.
# This script runs from the checked-out revision, which a fork pull request controls; the runner
# itself refuses fork code (scripts/self-hosted-runner/job-started.sh).
set -euo pipefail

hosted='"macos-15"'
mac_labels='["self-hosted","self-hosted-ovis-mac"]'
event="${EVENT_NAME:-}"
configured="${CONFIGURED_LABELS:-}"
stale_minutes="${MAC_STALE_MINUTES:-10}"
max_jobs="${MAC_MAX_JOBS:-2}"
seen_seconds="${MAC_SEEN_SECONDS:-300}"
seen="${RUNNER_SEEN:-}"

hosted_because() {
  echo "Runner: macos-15 ($1)" >&2
  echo "macos=$hosted"
  exit 0
}

# Prints "<unfinished> <stale>": the unfinished jobs of queued or running workflow runs that ask for
# the Mac's label, and how many of them have been queued longer than $stale_minutes; fails when the
# API does.
mac_jobs() {
  local ids id jobs counts unfinished=0 stale=0 now
  now="${ROUTE_NOW:-$(date +%s)}"
  ids=$(for status in in_progress queued; do
    gh api --paginate "repos/$REPOSITORY/actions/runs?status=$status&per_page=100" | jq '.workflow_runs[].id' || exit 1
  done) || return 1
  for id in $ids; do
    jobs=$(gh api --paginate "repos/$REPOSITORY/actions/runs/$id/jobs?filter=latest&per_page=100") || return 1
    counts=$(jq -s -e -r --argjson now "$now" --argjson stale "$((stale_minutes * 60))" '
      [.[].jobs[] | select(.status != "completed")
        | select([.labels[] | ascii_downcase] | index("self-hosted-ovis-mac") != null)]
      | "\(length) \([.[] | select(.status == "queued" and ($now - (.created_at | fromdateiso8601)) > $stale)] | length)"' <<<"$jobs") || return 1
    unfinished=$((unfinished + ${counts% *}))
    stale=$((stale + ${counts#* }))
  done
  echo "$unfinished $stale"
}

if [[ ("$event" == "pull_request" || "$event" == "pull_request_target") && "${HEAD_REPO:-}" != "${REPOSITORY:-}" ]]; then
  hosted_because "pull request from fork ${HEAD_REPO:-unknown}"
fi
if [[ -n "${configured//[[:space:]]/}" ]]; then
  [[ "${configured//[[:space:]]/}" == "$hosted" ]] ||
    { echo "::error::repository variable CI_MAC_SELF_HOSTED_LABELS must be \"macos-15\" or unset, got: $configured" >&2; exit 1; }
  hosted_because "from repository variable CI_MAC_SELF_HOSTED_LABELS"
fi
if ! [[ "$event" == pull_request || ("$event" == push && "${REF:-}" == refs/heads/main) ]]; then
  hosted_because "${event:-unknown event} ${REF:-}"
fi
for value in "$stale_minutes" "$max_jobs" "$seen_seconds"; do
  [[ "$value" =~ ^[0-9]{1,4}$ ]] || { echo "::error::MAC_STALE_MINUTES, MAC_MAX_JOBS and MAC_SEEN_SECONDS must be whole numbers, got: $value" >&2; exit 1; }
done
stale_minutes=$((10#$stale_minutes))
max_jobs=$((10#$max_jobs))
seen_seconds=$((10#$seen_seconds))

seen="${seen//[[:space:]]/}"
if ! [[ "$seen" =~ ^[0-9]{1,12}$ ]]; then
  hosted_because "Mac runner heartbeat CI_MAC_RUNNER_SEEN unset or not a number"
fi
age=$(( ${ROUTE_NOW:-$(date +%s)} - 10#$seen ))
if (( age > seen_seconds || age < -60 )); then
  hosted_because "Mac runner last seen online ${age}s ago"
fi

if ! counts=$(mac_jobs); then
  echo "::warning::could not count the Mac runner's jobs; using macos-15" >&2
  hosted_because "Actions API failed"
fi
unfinished=${counts% *}
stale=${counts#* }
if (( stale > 0 )); then
  hosted_because "a job has waited over $stale_minutes minutes for the Mac runner: offline?"
elif (( unfinished >= max_jobs )); then
  hosted_because "$unfinished jobs already on the Mac runner"
fi
echo "Runner: self-hosted $mac_labels ($unfinished jobs on the Mac runner)" >&2
echo "macos=$mac_labels"

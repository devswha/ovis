#!/usr/bin/env bash
# Rust runners' heartbeat (README "The Rust PTY host job"): while any runner carrying the label
# self-hosted-ovis-rust is online, sets the repository variable CI_RUST_RUNNER_SEEN to the current epoch
# seconds, which scripts/ci-runner-route.sh requires to be fresh before it sends the Rust PTY host job to
# those runners. Listing runners needs a token with administration access, which the workflow token lacks,
# so this runs outside Actions (a systemd user timer on the maintainer PC, every minute) with the
# maintainer's `gh`. No such runner online, or a failed call, writes nothing: the value ages and the
# route goes hosted.
#
# A run routed in the minutes before the value aged still waits for runners that are gone, and GitHub
# never moves a queued job. So once no Rust runner has been seen for longer than the route allows, each CI
# run of this repository (a push or a pull request, before its MAX_ATTEMPT-th attempt) whose Rust PTY host
# job is still queued on that label is cancelled and, unless its pull request or branch has moved on to
# another commit, run again in full: its Detect changes then sends the job hosted. A run is recorded in
# STATE_DIR before it is cancelled and kept there until it has been run again or left for good, so a lost
# answer or a slow cancel is followed up by a later pass. A run given up on ends the pass nonzero, which the
# timer's unit shows as failed.
set -euo pipefail

repo="${REPO:-devswha/ovis}"
label="${RUST_RUNNER_LABEL:-self-hosted-ovis-rust}"
job_name="Rust PTY host"
workflow=".github/workflows/ci.yml"
# scripts/ci-runner-route.sh's rust_seen_limit, and a minute more so a re-run's route surely sees it stale
seen_limit="${RUST_SEEN_LIMIT:-300}"
grace=60
max_attempt="${MAX_ATTEMPT:-3}"
max_rerun_passes=30
now="${HEARTBEAT_NOW:-$(date +%s)}"
state="${STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ovis-rust-heartbeat}"
mkdir -p "$state"
failed=0

# Each record ("<event> <pull request number or branch> <head sha> <attempt> <passes>") is written before its
# run is cancelled, so a cancel whose answer was lost is still followed up: a run not yet completed is asked to
# cancel again, one on a later attempt than recorded was already run again, and a completed one is run again
# unless its pull request or branch has moved on to another commit. An answer that cannot be had keeps the record.
rerun_pending() {
  local file id event key sha attempt tries view status current head
  for file in "$state"/run-*; do
    [[ -e "$file" ]] || continue
    id=${file##*/run-}
    read -r event key sha attempt tries <"$file" || { rm -f "$file"; continue; }
    view=$(gh run view "$id" --repo "$repo" --json status,attempt --jq '"\(.status) \(.attempt)"') || view=""
    read -r status current <<<"$view"
    if [[ "$current" =~ ^[0-9]+$ ]] && (( current > attempt )); then
      echo "run $id is on attempt $current already: nothing to run again" >&2
      rm -f "$file"
      continue
    fi
    if [[ -n "$status" && "$status" != completed ]]; then
      gh run cancel "$id" --repo "$repo" >/dev/null 2>&1 || true
    elif [[ "$status" == completed ]]; then
      if [[ "$event" == pull_request ]]; then
        head=$(gh api "repos/$repo/pulls/$key" --jq .head.sha) || head=""
      else
        head=$(gh api "repos/$repo/branches/$key" --jq .commit.sha) || head=""
      fi
      if [[ "$head" =~ ^[0-9a-f]{40}$ && "$head" != "$sha" ]]; then
        echo "run $id is for $sha, and its $event has moved on to $head: not running it again" >&2
        rm -f "$file"
        continue
      fi
      if [[ "$head" == "$sha" ]] && gh run rerun "$id" --repo "$repo"; then
        echo "run $id runs again" >&2
        rm -f "$file"
        continue
      fi
    fi
    tries=$((tries + 1))
    if (( tries >= max_rerun_passes )); then
      echo "::error::run $id was cancelled for its queued Rust PTY host job and could not be run again: re-run it by hand" >&2
      rm -f "$file"
      failed=1
    else
      echo "$event $key $sha $attempt $tries" >"$file"
    fi
  done
}

online=$(gh api --paginate "repos/$repo/actions/runners?per_page=100" |
  jq -s --arg label "$label" '[.[].runners[] | select(.status == "online" and any(.labels[]; (.name | ascii_downcase) == $label))] | length')
if [[ "$online" != 0 ]]; then
  gh variable set CI_RUST_RUNNER_SEEN --repo "$repo" --body "$now"
  rerun_pending
  exit "$failed"
fi
echo "no runner labelled $label is online: heartbeat not written" >&2

# Only a value GitHub answered for counts: a failed read proves no outage. A variable that does not exist does.
errors=$(mktemp)
if seen=$(gh api "repos/$repo/actions/variables/CI_RUST_RUNNER_SEEN" --jq .value 2>"$errors"); then :
elif grep -q 'HTTP 404' "$errors"; then seen=""
else cat "$errors" >&2; rm -f "$errors"; exit 1
fi
rm -f "$errors"
if [[ "$seen" =~ ^[0-9]{1,12}$ ]] && (( now - 10#$seen <= seen_limit + grace )); then
  rerun_pending
  exit "$failed"
fi

for status in queued in_progress; do
  gh api --paginate "repos/$repo/actions/runs?status=$status&per_page=100" |
    jq -r --arg repo "$repo" --arg workflow "$workflow" --argjson max "$max_attempt" '.workflow_runs[]
      | select(.head_repository.full_name == $repo and .path == $workflow and (.event == "push" or .event == "pull_request") and .run_attempt < $max)
      | "\(.id) \(.event) \(if .event == "pull_request" then (.pull_requests[0].number // "-") else .head_branch end) \(.head_sha) \(.run_attempt)"'
done | sort -u >"$state/.candidates"
while read -r id event key sha attempt; do
  [[ -e "$state/run-$id" ]] && continue
  [[ "$key" != - ]] || { echo "run $id names no pull request: left alone" >&2; continue; }
  queued=$(gh api --paginate "repos/$repo/actions/runs/$id/jobs?filter=latest&per_page=100" |
    jq -s --arg label "$label" --arg name "$job_name" '[.[].jobs[] | select(.name == $name and .status == "queued" and any(.labels[]; ascii_downcase == $label))] | length')
  [[ "$queued" != 0 ]] || continue
  echo "run $id: its Rust PTY host job waits for runners labelled $label, none online: cancelling it" >&2
  echo "$event $key $sha $attempt 0" >"$state/run-$id"
  gh run cancel "$id" --repo "$repo" || echo "run $id: no answer to its cancel yet; asked again next pass" >&2
done <"$state/.candidates"
rm -f "$state/.candidates"
rerun_pending
exit "$failed"

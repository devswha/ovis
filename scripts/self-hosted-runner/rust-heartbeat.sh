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
# job is still queued on that label is cancelled and, unless a newer CI run of its branch exists, run again
# in full: its Detect changes then sends the job hosted. A cancelled run is kept in STATE_DIR until its
# re-run is accepted, so a cancel that takes longer than this pass is re-run by a later one. A failure
# ends this pass nonzero, which the timer's unit shows as failed.
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

rerun_pending() {
  local file id branch event tries status newer
  for file in "$state"/run-*; do
    [[ -e "$file" ]] || continue
    id=${file##*/run-}
    read -r branch event tries <"$file" || { rm -f "$file"; continue; }
    status=$(gh run view "$id" --repo "$repo" --json status --jq .status) || status=""
    if [[ "$status" == completed ]]; then
      # a newer CI run of the branch already covers it; re-running the old commit would only displace that one
      newer=$(gh api "repos/$repo/actions/workflows/ci.yml/runs?branch=$branch&event=$event&per_page=1" --jq '.workflow_runs[0].id // empty') || newer=""
      if [[ -n "$newer" && "$newer" != "$id" ]]; then
        echo "run $id is superseded by run $newer: not running it again" >&2
        rm -f "$file"
        continue
      fi
      if gh run rerun "$id" --repo "$repo"; then
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
      echo "$branch $event $tries" >"$file"
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
      | "\(.id) \(.head_branch) \(.event)"'
done | sort -u >"$state/.candidates"
while read -r id branch event; do
  [[ -e "$state/run-$id" ]] && continue
  queued=$(gh api --paginate "repos/$repo/actions/runs/$id/jobs?filter=latest&per_page=100" |
    jq -s --arg label "$label" --arg name "$job_name" '[.[].jobs[] | select(.name == $name and .status == "queued" and any(.labels[]; ascii_downcase == $label))] | length')
  [[ "$queued" != 0 ]] || continue
  echo "run $id: its Rust PTY host job waits for runners labelled $label, none online: cancelling it" >&2
  if gh run cancel "$id" --repo "$repo"; then
    echo "$branch $event 0" >"$state/run-$id"
  else
    echo "::error::run $id could not be cancelled" >&2
    failed=1
  fi
done <"$state/.candidates"
rm -f "$state/.candidates"
rerun_pending
exit "$failed"

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
# never moves a queued job. So once no Rust runner has been seen for longer than the route allows, each run
# of this repository with a Rust job still queued is cancelled and run again in full: its Detect changes
# then sends the job hosted. A run already on its MAX_ATTEMPT-th attempt is left alone.
set -euo pipefail

repo="${REPO:-devswha/ovis}"
label="${RUST_RUNNER_LABEL:-self-hosted-ovis-rust}"
# scripts/ci-runner-route.sh's rust_seen_limit, and a minute more so a re-run's route surely sees it stale
seen_limit="${RUST_SEEN_LIMIT:-300}"
grace=60
max_attempt="${MAX_ATTEMPT:-3}"
now="${HEARTBEAT_NOW:-$(date +%s)}"

online=$(gh api --paginate "repos/$repo/actions/runners?per_page=100" |
  jq -s --arg label "$label" '[.[].runners[] | select(.status == "online" and any(.labels[]; .name == $label))] | length')
if [[ "$online" != 0 ]]; then
  gh variable set CI_RUST_RUNNER_SEEN --repo "$repo" --body "$now"
  exit 0
fi
echo "no runner labelled $label is online: heartbeat not written" >&2

seen=$(gh variable get CI_RUST_RUNNER_SEEN --repo "$repo" 2>/dev/null || true)
if [[ "$seen" =~ ^[0-9]{1,12}$ ]] && (( now - 10#$seen <= seen_limit + grace )); then
  exit 0
fi

for status in queued in_progress; do
  gh api --paginate "repos/$repo/actions/runs?status=$status&per_page=100" |
    jq -r --arg repo "$repo" --argjson max "$max_attempt" \
      '.workflow_runs[] | select(.head_repository.full_name == $repo and .run_attempt < $max) | .id'
done | sort -u | while read -r id; do
  queued=$(gh api --paginate "repos/$repo/actions/runs/$id/jobs?filter=latest&per_page=100" |
    jq -s --arg label "$label" '[.[].jobs[] | select(.status == "queued" and any(.labels[]; ascii_downcase == $label))] | length')
  [[ "$queued" != 0 ]] || continue
  echo "run $id waits for runners labelled $label, none online: cancelling it and running it again" >&2
  gh run cancel "$id" --repo "$repo" || continue
  for _ in $(seq 1 24); do
    [[ "$(gh run view "$id" --repo "$repo" --json status --jq .status)" == completed ]] && break
    sleep 5
  done
  gh run rerun "$id" --repo "$repo" || echo "run $id could not be run again" >&2
done

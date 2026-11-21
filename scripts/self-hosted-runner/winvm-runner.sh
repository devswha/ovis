#!/usr/bin/env bash
# winvm-runner.sh [--once]: winvm's runner for ci.yml's Native Windows install (README "Windows runner (winvm)").
# Runs on the maintainer's PC, beside the `winvm` command, as user unit ovis-winvm-runner; one copy at a time (a lock
# file). Each round, one job:
#   1. takes the winvm lease and keeps it while it runs: a lane that holds the VM keeps the runner off (CI then takes
#      windows-latest), and a lane that wants the VM stops this unit first;
#   2. once a query of the VM says no other repository's runner there is in a job, `winvm reset` and `winvm start`:
#      every job starts from the snapshot. Without that answer it resets nothing and tries again later;
#   3. copies the newest actions/runner package and this folder's winvm-*.ps1 into the VM, and registers one ephemeral
#      runner (labels self-hosted, self-hosted-ovis-win) in the VM's desktop session through Invoke-InSession, as the
#      Windows checks need; the registration token goes over ssh's stdin into a file the VM script deletes;
#   4. while that runner listens and no other runner in the VM is in a job, writes the Unix time into the repository
#      variable CI_WINVM_READY every minute, which ci-runner-route.sh reads; a job's start sets it to 0.
# An idle runner is recycled after 100 minutes (Invoke-InSession ends its task after two hours). A stop waits for a job
# in progress; an idle runner first clears the mark and waits for a job a route sent just before (a route's Detect
# changes job ends within five minutes), then is deleted, which GitHub refuses while it is in a job. A job still
# queued for winvm's label after a round gets another round, also at a stop. Then the VM is reset and the lease
# released; when that cannot be done the lease stays held and the script fails, so a lane sees it.
# --once: one round (and any for jobs left queued), then the same cleanup as a stop.
set -uo pipefail
REPO=${OVIS_WINVM_REPO:-devswha/ovis}
NAME=ovis-winvm
LABEL=self-hosted-ovis-win
LEASE=ci-winvm-runner
VAR=CI_WINVM_READY
HERE=$(cd "$(dirname "$0")" && pwd)
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/winvm-runner
VM_DIR='C:\ProgramData\winvm\ovis-runner'
IDLE_LIMIT=6000
DRAIN=330
once=0
[ "${1:-}" = --once ] && once=1
mkdir -p "$CACHE"
exec 9>"$CACHE/launcher.lock"
flock -n 9 || { echo "winvm-runner.sh: another copy runs (the unit ovis-winvm-runner?)" >&2; exit 1; }
RUN=$(mktemp -d "$CACHE/run.XXXXXX")
log() { echo "$(date -Is) $*"; }
mark() { gh variable set "$VAR" --repo "$REPO" --body "$1" >/dev/null 2>&1 || log "could not set $VAR to $1"; }
vm() { ssh -o BatchMode=yes -o ConnectTimeout=10 winvm "$@" 2>/dev/null; }
stopping() { [ -e "$RUN/stop" ]; }
pause() { local i; for ((i = 0; i < $1; i++)); do stopping && return 1; sleep 1; done; }
holds_lease() { winvm status | grep -q "^lease: $LEASE "; }

# the newest actions/runner for Windows x64 in the cache; prints its version
runner_package() {
  local tag version file
  tag=$(gh api repos/actions/runner/releases/latest --jq .tag_name) || return 1
  version=${tag#v}
  file=$CACHE/actions-runner-win-x64-$version.zip
  if [ ! -f "$file" ]; then
    curl -fsSL -o "$file.part" "https://github.com/actions/runner/releases/download/$tag/actions-runner-win-x64-$version.zip" || return 1
    mv "$file.part" "$file"
    find "$CACHE" -name 'actions-runner-win-x64-*.zip' ! -name "${file##*/}" -delete
  fi
  echo "$version"
}

# Runner.Worker processes in the VM (other repositories' runners kept in the snapshot); prints nothing when the VM
# does not answer. With "foreign", only those that are not this script's runner.
vm_workers() {
  local filter=''
  [ "${1:-}" = foreign ] && filter=" | Where-Object Path -notlike 'C:\\actions-runners\\ovis-win\\*'"
  vm "@(Get-Process Runner.Worker -ErrorAction SilentlyContinue$filter).Count" | tr -d '[:space:]'
}

# A reset now would kill a job of another runner in the VM. wait_other_jobs <seconds> [stop]: 0 once the VM is off or
# a query says no runner there is in a job; 1 after <seconds> without that answer (or at a stop, with "stop").
wait_other_jobs() {
  local state count waited=0
  state=$(winvm status | head -1)
  [ "$state" = "shut off" ] && return 0
  while :; do
    if [ "$state" = running ]; then
      count=$(vm_workers)
      [ "$count" = 0 ] && return 0
    fi
    if (( waited % 300 == 0 )); then log "winvm is ${state:-unknown}, ${count:-no answer} job(s) in it; not resetting yet"; fi
    if (( waited >= $1 )) || { [ "${2:-}" = stop ] && stopping; }; then return 1; fi
    sleep 30; waited=$((waited + 30))
    state=$(winvm status | head -1)
    [ "$state" = "shut off" ] && return 0
  done
}

# how many jobs that name winvm's label wait for a runner
queued_jobs() {
  local ids id total=0 n
  ids=$(for status in queued in_progress; do
    gh api --paginate "repos/$REPO/actions/runs?status=$status&per_page=100" --jq '.workflow_runs[].id' || exit 1
  done) || return 1
  for id in $ids; do
    n=$(gh api --paginate "repos/$REPO/actions/runs/$id/jobs?filter=latest&per_page=100" \
      --jq "[.jobs[] | select(.status == \"queued\" and (.labels | index(\"$LABEL\")))] | length" | awk '{s += $1} END {print s + 0}') || return 1
    total=$((total + n))
  done
  echo "$total"
}
runner_id() { gh api --paginate "repos/$REPO/actions/runners" --jq ".runners[] | select(.name == \"$NAME\") | .id"; }

# While the runner listens: the mark every minute (0 while another runner in the VM is in a job), the lease renewed.
# An idle runner is recycled and a stop drains it: the mark cleared, a wait for a job a route sent before, then the
# registration deleted, which GitHub refuses for a runner in a job (that job then goes on).
heartbeat() {
  local ssh_pid=$1 since=$SECONDS id
  while kill -0 "$ssh_pid" 2>/dev/null; do
    if [ -e "$RUN/listening" ] && [ ! -e "$RUN/job" ]; then
      if stopping || (( SECONDS - since > IDLE_LIMIT )); then
        mark 0
        log "no new job routes here now; waiting ${DRAIN}s for one a route sent before"
        sleep "$DRAIN"
        if [ ! -e "$RUN/job" ] && id=$(runner_id) && [ -n "$id" ] && gh api -X DELETE "repos/$REPO/actions/runners/$id" >/dev/null 2>&1; then
          log "no job came; runner $NAME deleted"
          vm "Get-Process Runner.Listener -ErrorAction SilentlyContinue | Where-Object Path -like 'C:\\actions-runners\\ovis-win\\*' | Stop-Process -Force"
          kill "$ssh_pid" 2>/dev/null
        else
          log "runner $NAME is in a job (or could not be deleted); it ends after that job"
        fi
        return
      fi
      if [ "$(vm_workers foreign)" = 0 ]; then mark "$(date +%s)"; else mark 0; fi
      # a job that started meanwhile: its own 0 may have come first
      [ -e "$RUN/job" ] && mark 0
      winvm lease "$LEASE" >/dev/null
    fi
    sleep 60
  done
}

round() {
  local version token ssh_pid beat_pid busy desktop=0
  until busy=$(winvm lease "$LEASE"); do
    log "$busy"
    (( once )) && return 0
    pause 60 || return 0
  done
  version=$(runner_package) || { log "could not fetch the actions/runner package"; return 1; }
  if ! wait_other_jobs 3600 stop; then
    stopping || log "no answer that winvm is free of jobs; not resetting it, trying again later"
    return 1
  fi
  winvm reset >/dev/null && winvm start >/dev/null || { log "winvm reset/start failed"; return 1; }
  for _ in $(seq 100); do
    if vm "if (Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object UserName -like '*\\devswha') { 'UP' }" | grep -q UP; then desktop=1; break; fi
    sleep 3
  done
  (( desktop )) || { log "winvm's desktop session did not come up"; return 1; }
  vm "New-Item -ItemType Directory -Force -Path '$VM_DIR' | Out-Null" || { log "ssh winvm failed"; return 1; }
  scp -q -o BatchMode=yes "$CACHE/actions-runner-win-x64-$version.zip" "$HERE/winvm-runner.ps1" "$HERE/winvm-job-started.ps1" \
    "winvm:${VM_DIR//\\//}/" 2>/dev/null || { log "copying into winvm failed"; return 1; }
  token=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token) || { log "no registration token"; return 1; }
  printf '%s\n' "$token" | vm "pwsh -NoProfile -Command \"[Console]::In.ReadLine() | Set-Content -NoNewline -LiteralPath '$VM_DIR\\token'\"" \
    || { log "could not hand the token over"; return 1; }
  unset token
  rm -f "$RUN/listening" "$RUN/job"
  : >"$RUN/out"
  ssh -o BatchMode=yes winvm "pwsh -File C:\\ProgramData\\winvm\\Invoke-InSession.ps1 -Command '& $VM_DIR\\winvm-runner.ps1 -Version $version -Repository $REPO -Name $NAME'" \
    >"$RUN/out" 2>&1 </dev/null &
  ssh_pid=$!
  heartbeat "$ssh_pid" &
  beat_pid=$!
  while IFS= read -r line; do
    echo "winvm| $line"
    case $line in
      *"Listening for Jobs"*)
        touch "$RUN/listening"
        if ! stopping && [ "$(vm_workers foreign)" = 0 ]; then mark "$(date +%s)"; fi
        log "runner $NAME listens (runner $version)" ;;
      *"Running job:"*) touch "$RUN/job"; mark 0 ;;
    esac
  done < <(tail -n +1 -f --pid="$ssh_pid" "$RUN/out")
  wait "$ssh_pid"
  log "runner $NAME ended ($?)"
  kill "$beat_pid" 2>/dev/null
  wait "$beat_pid" 2>/dev/null
  mark 0
}

# Leaves the VM as a lane expects it: reset to the snapshot and running, no runner of this script registered, the lease
# free. Without a proven-free VM (another repository's job still running after 10 minutes, so the stop stays inside the
# unit's TimeoutStopSec) or a successful reset, it keeps the lease and fails.
cleanup() {
  local id ok=0
  mark 0
  if holds_lease; then
    if wait_other_jobs 600 && winvm reset >/dev/null && winvm start >/dev/null; then
      winvm release >/dev/null
    else
      ok=1
      log "winvm was not reset; the lease stays with $LEASE. Once no job runs in it: winvm reset && winvm start && winvm release"
    fi
  fi
  id=$(runner_id) && for i in $id; do gh api -X DELETE "repos/$REPO/actions/runners/$i" >/dev/null; done
  rm -rf "$RUN"
  log "stopped"
  return "$ok"
}

# a stop never kills a job: it drains a listening runner (heartbeat) and waits for one in a job
trap 'touch "$RUN/stop"; log "stopping"' TERM INT
extra=0
while :; do
  round || pause 60
  (( once )) && touch "$RUN/stop"
  if stopping; then
    # a job routed here before the mark was cleared waits for this label alone: serve it (a few rounds at most; a
    # round while stopping offers no mark and drains its runner at once)
    if (( extra < 3 )) && holds_lease && n=$(queued_jobs) && (( n > 0 )); then
      extra=$((extra + 1))
      log "$n job(s) still queued for $LABEL; one more round"
      continue
    fi
    break
  fi
done
cleanup

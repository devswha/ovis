#!/usr/bin/env bash
# Runners on another host that holds no GitHub credential (README "Just-in-time runners on another host"). This runs on
# the maintainer's PC, with the maintainer's gh login, and keeps --count runners on that host. For each runner start:
#   1. it opens an ssh session that runs REMOTE_COMMAND --jit-slot N there (run.sh, which sets the slot up and prints
#      READY);
#   2. only then it has GitHub make ONE just-in-time runner configuration (name <prefix>N, labels self-hosted and
#      --labels, work folder /w), and writes it as one line to that session's stdin; run.sh hands it straight to the
#      runner container. GitHub fixes the runner's name and labels in it, and it serves one runner and one job;
#   3. it keeps that stdin open while the runner may run: its end (this launcher stopped, the session lost) stops the
#      runner there;
#   4. once the session ends (the job is done, or anything failed), it deletes the runner GitHub made for that start by
#      its id, if it is still registered, and starts the slot again.
# Nothing is made before the host is ready and nothing is kept on it: when this launcher stops, or this PC is off, no
# runner starts there. With --heartbeat it also writes runner-heartbeat.sh's heartbeat once a minute.
#
# Usage: remote-runners.sh --host SSH_HOST --repo OWNER/NAME --name-prefix PREFIX --labels LABEL[,LABEL...]
#          [--count N] [--heartbeat VARIABLE] [--ready-wait SECONDS] [--once] -- REMOTE_COMMAND...
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST=""
REPO=""
NAME_PREFIX=""
LABELS=""
COUNT=1
HEARTBEAT=""
# the host's set-up before READY: its first cache refresh may take run.sh's --cache-wait (120 s by default)
READY_WAIT=300
ONCE=0

usage() {
  sed -n '16,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host needs a value}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --name-prefix) NAME_PREFIX="${2:?--name-prefix needs a value}"; shift 2 ;;
    --labels) LABELS="${2:?--labels needs a value}"; shift 2 ;;
    --count) COUNT="${2:?--count needs a value}"; shift 2 ;;
    --heartbeat) HEARTBEAT="${2:?--heartbeat needs a value}"; shift 2 ;;
    --ready-wait) READY_WAIT="${2:?--ready-wait needs a value}"; shift 2 ;;
    --once) ONCE=1; shift ;;
    --) shift; break ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
REMOTE_COMMAND=("$@")

# What goes into an ssh command line or a runner's registration: refused unless plain
fail_usage() { echo "$1" >&2; exit 2; }
[[ "$HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]] || fail_usage "--host must be an ssh host name"
[[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || fail_usage "--repo must be OWNER/NAME"
[[ "$NAME_PREFIX" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail_usage "--name-prefix must be letters, digits, '.', '_' or '-'"
[[ "$LABELS" =~ ^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$ ]] || fail_usage "--labels must be a comma-separated list of labels"
[[ "$COUNT" =~ ^[1-9][0-9]?$ ]] || fail_usage "--count must be a whole number from 1 to 99"
[[ "$READY_WAIT" =~ ^[1-9][0-9]{0,3}$ ]] || fail_usage "--ready-wait must be a whole number of seconds"
[[ -z "$HEARTBEAT" || "$HEARTBEAT" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail_usage "--heartbeat must be a variable name"
[ "${#REMOTE_COMMAND[@]}" -gt 0 ] || fail_usage "the command to run on the host comes after --"
IFS=, read -r -a LABEL_LIST <<<"$LABELS"
for label in "${LABEL_LIST[@]}"; do
  [ "${label,,}" != self-hosted ] || fail_usage "--labels names the host's own labels; self-hosted is always added"
done
# the host's command, quoted for the remote shell; --jit-slot N goes after it
printf -v REMOTE '%q ' "${REMOTE_COMMAND[@]}"
LABEL_ARGS=(-f "labels[]=self-hosted")
for label in "${LABEL_LIST[@]}"; do LABEL_ARGS+=(-f "labels[]=$label"); done

# Deletes the runner registered under exactly $1 while it is offline: one an earlier start of this slot left (this PC
# went off before it could delete it), which keeps GitHub from making another of that name. An online one is left alone.
clear_stale() {
  local listing id
  listing="$(gh api --paginate "repos/$REPO/actions/runners?per_page=100")" || return 0
  for id in $(jq -r --arg name "$1" '.runners[]? | select(.name == $name and .status == "offline") | .id' <<<"$listing" 2>/dev/null); do
    [[ "$id" =~ ^[0-9]+$ ]] || continue
    echo "[$1] deleting runner $id of this slot's name, left offline by an earlier start" >&2
    gh api -X DELETE "repos/$REPO/actions/runners/$id" >/dev/null 2>&1 || true
  done
}

# The runner GitHub made for a start, by its id: gone already (404) once it ran its job.
delete_runner() {
  [ -n "$1" ] || return 0
  gh api -X DELETE "repos/$REPO/actions/runners/$1" >/dev/null 2>&1 || true
}

# A pause a stop signal ends at once: bash runs a trap only between commands, and a foreground sleep is one.
pause() {
  sleep "$1" &
  NAPPER="$!"
  wait "$NAPPER" || true
  NAPPER=""
}

slot_loop() {
  local slot="$1" name="${NAME_PREFIX}$1" delay=30 line ready json config status from_host to_host
  REMOTE_PID="" RUNNER_ID="" NAPPER=""
  # a stop ends only what this loop started, by the pids bash gave them: its ssh session, then the runner GitHub made
  trap 'if [ -n "$NAPPER" ]; then kill "$NAPPER" 2>/dev/null || true; fi
    if [ -n "$REMOTE_PID" ]; then kill -TERM "$REMOTE_PID" 2>/dev/null || true; wait "$REMOTE_PID" 2>/dev/null || true; fi
    delete_runner "$RUNNER_ID"; exit 143' TERM
  # a session that ended before its configuration was written must not end this loop with it
  trap '' PIPE
  while true; do
    ready=0 RUNNER_ID="" status=0
    coproc REMOTE_SESSION { exec ssh -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=10 "$HOST" "${REMOTE}--jit-slot $slot"; }
    REMOTE_PID="$REMOTE_SESSION_PID"
    from_host="${REMOTE_SESSION[0]}" to_host="${REMOTE_SESSION[1]}"
    while IFS= read -r -t "$READY_WAIT" line <&"$from_host"; do
      if [ "$line" = READY ]; then ready=1; break; fi
      printf '[%s] %s\n' "$name" "$line" >&2
    done
    if [ "$ready" = 1 ]; then
      if json="$(gh api -X POST "repos/$REPO/actions/runners/generate-jitconfig" -f "name=$name" -F runner_group_id=1 "${LABEL_ARGS[@]}" -f work_folder=/w)" &&
        RUNNER_ID="$(jq -er '.runner.id | select(type == "number")' <<<"$json")" &&
        config="$(jq -er '.encoded_jit_config | select(type == "string" and test("^[A-Za-z0-9+/]+=*$"))' <<<"$json")"; then
        json=""
        echo "[$name] runner $RUNNER_ID made for this start; its configuration goes to the host" >&2
        printf '%s\n' "$config" >&"$to_host" || echo "[$name] the host's session ended before its configuration was written" >&2
        config=""
      else
        json="" config=""
        echo "[$name] GitHub made no just-in-time configuration" >&2
        clear_stale "$name"
        # the host reads the end of its stdin as no configuration, and stops
        exec {to_host}>&-
      fi
      while IFS= read -r line <&"$from_host"; do printf '[%s] %s\n' "$name" "$line" >&2; done
    else
      echo "[$name] the host did not say READY within ${READY_WAIT}s" >&2
      kill -TERM "$REMOTE_PID" 2>/dev/null || true
    fi
    wait "$REMOTE_PID" || status=$?
    REMOTE_PID=""
    # the runner GitHub made for this start, if it never took its job
    delete_runner "$RUNNER_ID"
    if [ -n "$RUNNER_ID" ] && [ "$status" = 0 ]; then
      delay=30
      [ "$ONCE" = 1 ] && return 0
      RUNNER_ID=""
      continue
    fi
    RUNNER_ID=""
    echo "[$name] this start failed (session status $status); retrying in ${delay}s" >&2
    [ "$ONCE" = 1 ] && return 1
    pause "$delay"
    delay=$(( delay * 2 > 600 ? 600 : delay * 2 ))
  done
}

# Once a minute: the hosts' runners are online, written for scripts/ci-runner-route.sh (runner-heartbeat.sh).
heartbeat_loop() {
  NAPPER=""
  trap 'if [ -n "$NAPPER" ]; then kill "$NAPPER" 2>/dev/null || true; fi; exit 143' TERM
  while true; do
    bash "$SCRIPT_DIR/runner-heartbeat.sh" "$NAME_PREFIX" "${LABEL_LIST[0]}" "$HEARTBEAT" "$COUNT" || true
    pause 60
  done
}

PIDS=()
cleaned=0
cleanup() {
  [ "$cleaned" = 1 ] && return
  cleaned=1
  trap '' INT TERM
  # each slot loop ends its own session and deletes its own runner: only the processes this launcher started
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for slot in $(seq 1 "$COUNT"); do
  slot_loop "$slot" &
  PIDS+=("$!")
done
if [ -n "$HEARTBEAT" ] && [ "$ONCE" = 0 ]; then
  heartbeat_loop &
  PIDS+=("$!")
fi

if [ "$ONCE" = 1 ]; then
  rc=0
  for pid in "${PIDS[@]}"; do
    wait "$pid" || rc=$?
  done
  exit "$rc"
fi
# the loops run until a signal arrives; wait is interrupted by the traps
wait

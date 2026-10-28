#!/usr/bin/env bash
# Host launcher: keeps N ephemeral runner containers alive, one job per container.
#
# Usage: scripts/self-hosted-runner/run.sh [--repo OWNER/NAME] [--count N] [--labels self-hosted-ovis]
#          [--reserved N] [--reserved-labels self-hosted-ovis-main] [--env-file FILE] [--build] [--once]
#          [--cache-dir DIR | --no-cache]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="herdr-ci-runner:local"

REPO=""
COUNT=1
LABELS="self-hosted-ovis"
RESERVED=0
RESERVED_LABELS="self-hosted-ovis-main"
ENV_FILE=""
BUILD=0
ONCE=0
CACHE=1
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ovis-ci-runner"

usage() {
  sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --count) COUNT="${2:?--count needs a value}"; shift 2 ;;
    --labels) LABELS="${2:?--labels needs a value}"; shift 2 ;;
    --reserved) RESERVED="${2:?--reserved needs a value}"; shift 2 ;;
    --reserved-labels) RESERVED_LABELS="${2:?--reserved-labels needs a value}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file needs a value}"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --once) ONCE=1; shift ;;
    --cache-dir) CACHE_DIR="${2:?--cache-dir needs a value}"; shift 2 ;;
    --no-cache) CACHE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$COUNT" in ''|*[!0-9]*|0) echo "--count must be a positive integer" >&2; exit 2 ;; esac
# The first --reserved slots of --count register with --reserved-labels instead of --labels, so jobs
# that ask for those labels (ci.yml's pushes to main, CI_MAIN_SELF_HOSTED_LABELS) find a runner that
# pull request jobs never take. They stay in this launcher's network namespace: same check.ts slots.
# at most four digits: a longer number could wrap around in shell arithmetic and pass as a small one
case "$RESERVED" in ''|*[!0-9]*|?????*) echo "--reserved must be a whole number up to --count" >&2; exit 2 ;; esac
if [ "$((10#$RESERVED))" -gt "$((10#$COUNT))" ]; then echo "--reserved must not exceed --count" >&2; exit 2; fi
# What this host can take (CHECK_HOST_* in scripts/check.ts), for every runner container: read now,
# so a missing file stops the launcher instead of every container failing to start.
ENV_ARGS=()
if [ -n "$ENV_FILE" ]; then
  # a path starting with - (even "-" itself, which grep reads as stdin after --) is the file of that name
  case "$ENV_FILE" in -*) ENV_FILE="./$ENV_FILE" ;; esac
  [ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ] || { echo "--env-file: cannot read $ENV_FILE" >&2; exit 2; }
  # Only CHECK_HOST_* numbers: docker copies a bare NAME line from this launcher's own environment
  # (GH_TOKEN, say) into every container, where any job could read it. A refused line is named by its
  # number only: its value may be a credential, and stderr ends up in the journal.
  status=0
  # -a: a NUL byte would make grep call the file binary and name no line; -- : a path may start with -
  bad="$(grep -anvE -e '^[[:space:]]*(#.*)?$|^CHECK_HOST_(MAX_RUNS|TEST_SHARDS|BROWSER_WORKERS|UNIT_WORKERS)=[0-9]+$' -- "$ENV_FILE")" || status=$?
  case "$status" in
    0) echo "--env-file: $ENV_FILE may hold only CHECK_HOST_*=<number> lines; refused line(s): $(printf '%s\n' "$bad" | cut -d: -f1 | paste -sd, -)" >&2
       exit 2 ;;
    1) ;; # every line is allowed
    *) echo "--env-file: could not read $ENV_FILE to check it" >&2; exit 2 ;;
  esac
  ENV_ARGS=(--env-file "$ENV_FILE")
fi

if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi
HOST="$(hostname -s)"
PREFIX="herdr-ci-${HOST}-"
# Every runner joins this container's network namespace, so the runners of this PC share one
# loopback: scripts/check.ts's slots (listening loopback ports) then bound the herdr-backed lanes
# of all of them together, as they bound the runs of one PC. Not the host's network: a job still
# cannot reach the host's own loopback services.
NETNS="${PREFIX}net"

if [ "$BUILD" = 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" "$SCRIPT_DIR"
fi

# Host caches (README "Host caches"): a bare mirror of the repository's branches and tags, and Bun's
# install cache for the default branch's bun.lock. Only this launcher writes them: the mirror from
# GitHub, the Bun cache from the downloads Bun checks against that lockfile. Every runner container
# gets them read-only at /cache, so no job can change what a later one checks out or installs.
MIRROR=""
BUN_CACHES=""
CACHE_CONTAINER="${PREFIX}cache"
if [ "$CACHE" = 1 ]; then
  (umask 022 && mkdir -p "$CACHE_DIR")
  CACHE_DIR="$(cd "$CACHE_DIR" && pwd -P)"
  MIRROR="$CACHE_DIR/git/repo.git"
  BUN_CACHES="$CACHE_DIR/bun"
fi

refresh_mirror() {
  if [ ! -d "$MIRROR/objects" ]; then
    mkdir -p "$CACHE_DIR/git" &&
      git -c init.defaultBranch=main init -q --bare "$MIRROR" &&
      git -C "$MIRROR" config remote.origin.url "https://github.com/$REPO.git" &&
      git -C "$MIRROR" config remote.origin.fetch '+refs/heads/*:refs/heads/*' &&
      git -C "$MIRROR" config --add remote.origin.fetch '+refs/tags/*:refs/tags/*' || return 1
  fi
  # no pull request refs: only this repository's own branches and tags
  GIT_TERMINAL_PROMPT=0 git -C "$MIRROR" fetch --quiet --prune --no-write-fetch-head origin || return 1
  # HEAD names the default branch, whose bun.lock the Bun cache follows
  if ! git -C "$MIRROR" rev-parse --verify -q HEAD >/dev/null; then
    local head
    head="$(GIT_TERMINAL_PROMPT=0 git -C "$MIRROR" ls-remote --symref origin HEAD |
      sed -n 's|^ref: \(refs/heads/[^[:space:]]*\)[[:space:]]*HEAD$|\1|p')"
    [ -n "$head" ] && git -C "$MIRROR" symbolic-ref HEAD "$head"
  fi
}

# One directory per bun.lock (named after its blob), and `current` pointing at the default branch's.
refresh_bun_cache() {
  local lock commit version tmp failed old dir
  lock="$(git -C "$MIRROR" rev-parse --verify -q 'HEAD:bun.lock')" || return 0
  commit="$(git -C "$MIRROR" rev-parse --verify -q 'HEAD^{commit}')" || return 1
  version="$BUN_CACHES/$lock"
  failed="$BUN_CACHES/.failed-$lock"
  mkdir -p "$BUN_CACHES" || return 1
  if [ ! -d "$version" ]; then
    # a build that failed is retried after 30 minutes, not every refresh: each try downloads it all
    [ -n "$(find "$failed" -mmin -30 2>/dev/null)" ] && return 1
    tmp="$(mktemp -d "$BUN_CACHES/.new-XXXXXX")" || return 1
    docker rm -f "$CACHE_CONTAINER" >/dev/null 2>&1 || true
    # The runner's hardening, the host user's files, no package scripts, and only what the lockfile
    # pins: --frozen-lockfile refuses to resolve anything else and Bun checks every download's
    # integrity against it. Not in the runners' network namespace: their check.ts slots are theirs.
    if ! timeout 900 docker run --rm \
      --name "$CACHE_CONTAINER" \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      --pids-limit 8192 \
      --user "$(id -u):$(id -g)" \
      -e HOME=/tmp \
      -e BUN_INSTALL_CACHE_DIR=/cache/bun \
      -e COMMIT="$commit" \
      -v "$MIRROR:/cache/git/repo.git:ro" \
      -v "$tmp:/cache/bun" \
      --entrypoint bash \
      "$IMAGE" -c 'set -e
        git clone -q --shared --no-checkout /cache/git/repo.git /tmp/src
        cd /tmp/src
        git checkout -q --detach "$COMMIT"
        bun install --frozen-lockfile --ignore-scripts' </dev/null >/dev/null; then
      docker rm -f "$CACHE_CONTAINER" >/dev/null 2>&1 || true
      rm -rf "$tmp"
      touch "$failed"
      return 1
    fi
    rm -f "$failed"
    # mktemp's 0700 would keep the runner's own user out
    chmod 0755 "$tmp"
    # another launcher may have finished the same lockfile first
    mv -T "$tmp" "$version" 2>/dev/null || rm -rf "$tmp"
  fi
  old="$(readlink "$BUN_CACHES/current" 2>/dev/null || true)"
  if [ "$old" != "$lock" ]; then
    # its mtime now says when it was replaced
    if [ -n "$old" ] && [ -d "$BUN_CACHES/$old" ]; then touch "$BUN_CACHES/$old"; fi
    ln -sfn "$lock" "$BUN_CACHES/.current-new" && mv -T "$BUN_CACHES/.current-new" "$BUN_CACHES/current"
  fi
  # A replaced version stays an hour, so a job copying it when it was replaced finishes first.
  for dir in "$BUN_CACHES"/* "$BUN_CACHES"/.new-*; do
    [ -d "$dir" ] && [ ! -L "$dir" ] && [ "${dir##*/}" != "$lock" ] || continue
    if [ -n "$(find "$dir" -maxdepth 0 -mmin +60)" ]; then rm -rf "$dir"; fi
  done
}

# git and Docker write with the umask: the runner containers read the caches as another user.
refresh_caches() (
  umask 022
  if ! refresh_mirror; then
    echo "[cache] could not refresh the git mirror $MIRROR from github.com/$REPO" >&2
  fi
  if [ -d "$MIRROR/objects" ] && ! refresh_bun_cache; then
    echo "[cache] could not build the Bun cache in $BUN_CACHES for the default branch's bun.lock" >&2
  fi
  return 0
)

cache_loop() {
  while true; do
    # a schedule, not a wait: one small fetch a minute keeps the mirror near GitHub
    sleep 60
    refresh_caches
  done
}

# Set when each runner starts, so a cache that appeared since is used.
cache_args() {
  CACHE_ARGS=()
  [ "$CACHE" = 1 ] || return 0
  CACHE_ARGS=(-v "$CACHE_DIR:/cache:ro")
  # actions/checkout and every other git command of the job read objects from the mirror first and
  # fetch only what it lacks; an object is named by its hash, so the head checked out is the same
  if [ -d "$MIRROR/objects" ]; then
    CACHE_ARGS+=(-e GIT_ALTERNATE_OBJECT_DIRECTORIES=/cache/git/repo.git/objects)
  fi
}

start_netns() {
  local running
  running="$(docker inspect -f '{{.State.Running}}' "$NETNS" 2>/dev/null || true)"
  [ "$running" = true ] && return
  # only a stopped one is in the way; a missing one leaves nothing to remove
  if [ "$running" = false ]; then docker rm "$NETNS" >/dev/null 2>&1 || true; fi
  docker run -d --rm \
    --name "$NETNS" \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    --entrypoint sleep \
    "$IMAGE" infinity >/dev/null ||
    # two slot loops restarting it at once: the other one's start wins, and a runner that still
    # finds no namespace fails to start, and its loop tries again
    echo "[$NETNS] could not start the shared network namespace container" >&2
}

slot_loop() {
  local slot="$1" name token container_status labels="$LABELS"
  name="${PREFIX}${slot}"
  if [ "$slot" -le "$((10#$RESERVED))" ]; then labels="$RESERVED_LABELS"; fi
  delay=30
  while true; do
    if ! token="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)"; then
      echo "[$name] could not fetch a registration token; retrying in ${delay}s" >&2
      [ "$ONCE" = 1 ] && return 1
      sleep "$delay"
      # every slot asks, and GitHub limits these POSTs per hour: a fixed 30 s keeps the account
      # over that limit for as long as it lasts, so back off to 10 minutes
      delay=$(( delay * 2 > 600 ? 600 : delay * 2 ))
      continue
    fi
    delay=30
    # No docker socket, no host mount but the read-only caches, no privileges. tini is already the entrypoint.
    # The token goes in on stdin (entrypoint.sh), so it is never in the container's environment.
    # a runner started after the namespace container went away would have no network
    start_netns
    cache_args
    if printf '%s\n' "$token" | docker run --rm -i \
      --name "$name" \
      --network "container:$NETNS" \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      --pids-limit 8192 \
      --shm-size 2g \
      -e RUNNER_URL="https://github.com/$REPO" \
      -e RUNNER_NAME="$name" \
      -e RUNNER_LABELS="$labels" \
      ${CACHE_ARGS[@]+"${CACHE_ARGS[@]}"} \
      ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
      "$IMAGE"; then
      container_status=0
    else
      container_status=$?
      echo "[$name] container exited with status $container_status" >&2
    fi
    token=""
    [ "$ONCE" = 1 ] && return "$container_status"
    sleep 2
  done
}

PIDS=()
cleaned=0
cleanup() {
  [ "$cleaned" = 1 ] && return
  cleaned=1
  trap '' INT TERM
  echo "stopping runner slots..." >&2
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  for slot in $(seq 1 "$COUNT"); do
    docker stop -t 30 "${PREFIX}${slot}" >/dev/null 2>&1 || true
  done
  wait 2>/dev/null || true
  docker stop -t 5 "$CACHE_CONTAINER" >/dev/null 2>&1 || true
  docker stop -t 5 "$NETNS" >/dev/null 2>&1 || true
  # Remove any runner of this host that is still registered.
  ids="$(gh api "repos/$REPO/actions/runners" --paginate \
    --jq ".runners[] | select(.name | startswith(\"$PREFIX\")) | .id" 2>/dev/null || true)"
  for id in $ids; do
    gh api -X DELETE "repos/$REPO/actions/runners/$id" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# before the first runner, so its job finds them
if [ "$CACHE" = 1 ]; then
  refresh_caches
  if [ "$ONCE" != 1 ]; then
    cache_loop &
    PIDS+=("$!")
  fi
fi

start_netns
for slot in $(seq 1 "$COUNT"); do
  slot_loop "$slot" &
  PIDS+=("$!")
done

if [ "$ONCE" = 1 ]; then
  rc=0
  for pid in "${PIDS[@]}"; do
    wait "$pid" || rc=$?
  done
  exit "$rc"
fi

# Slot loops run until a signal arrives; `wait` is interrupted by the traps.
wait

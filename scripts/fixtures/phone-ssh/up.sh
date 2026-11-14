#!/bin/bash
# Build and start the disposable phone-ssh fixture container (see claude-standin.py for the agent).
#   ssh -p 2290 fixture@127.0.0.1   password: phone-ssh-test-only   (host loopback only)
#   Ovis inside listens on the container's 127.0.0.1:7317: reach it with ssh -L.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
name=ovis-phone-ssh-fixture
image=ovis-phone-ssh-fixture:local
work=$HOME/.cache/ovis-tmp/phone-ssh
ctx=$work/ctx
mkdir -p "$work/tmp" "$ctx/bin"
export TMPDIR=$work/tmp

if [ ! -f "$repo/dist/index.html" ]; then
  echo "up: dist/ missing, running bun run build"
  (cd "$repo" && bun run build)
fi

# the host's `herdr` may be a guard wrapper script around the real binary
herdr_bin=$(command -v herdr)
[ -x "$(dirname "$herdr_bin")/herdr-real" ] && herdr_bin=$(dirname "$herdr_bin")/herdr-real
install -m 755 "$herdr_bin" "$ctx/bin/herdr"
install -m 755 "$(readlink -f "$(command -v bun)")" "$ctx/bin/bun"
install -m 644 "$here/Dockerfile" "$here/sshd_config" "$here/claude-standin.py" "$here/entrypoint.sh" "$here/start-fixture.sh" "$ctx/"
rsync -a --delete \
  --exclude=/.git --exclude=/app --exclude=/docs --exclude=/evidence --exclude=/site --exclude=/ovis-site \
  --exclude=/crates --exclude=/scripts/fixtures/phone-ssh --exclude=node_modules/.cache \
  "$repo/" "$ctx/ovis/"

cpuset=()
docker build --help 2>/dev/null | grep -q -- --cpuset-cpus && cpuset=(--cpuset-cpus 80-95)
docker build "${cpuset[@]}" -t "$image" "$ctx"

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --init --name "$name" -p 127.0.0.1:2290:22 "$image" >/dev/null

for _ in $(seq 600); do
  logs=$(docker logs "$name" 2>&1 || true)
  if grep -q "start-fixture: herdr, stand-in claude" <<<"$logs"; then
    echo "$logs" | grep "start-fixture:"
    docker ps --filter "name=^${name}$" --format '{{.Names}}  {{.Status}}  {{.Ports}}'
    exit 0
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != "true" ]; then break; fi
  sleep 0.1
done
echo "up: fixture did not come up; container logs:" >&2
docker logs "$name" >&2 || true
exit 1

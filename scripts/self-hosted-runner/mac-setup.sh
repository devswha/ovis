#!/usr/bin/env bash
# Sets up the Mac runner (README "Mac runner") on the Mac itself, as its own user. Installs the fork
# guard (job-started.sh) and its .env before the runner is registered or started, so the runner never
# takes a job without it. Run from a checkout of this repository, with a registration token:
#
#   REGISTRATION_TOKEN=<token> bash scripts/self-hosted-runner/mac-setup.sh
#
# Rerun after changing job-started.sh: it copies the hook again and restarts the service.
set -euo pipefail

version=2.338.2
sha256=25a065af409ffa317ab4d5a3b614dd15fc9c40f2172bc1b35a1b1258e919a388
dir="${RUNNER_DIR:-$HOME/actions-runner-ovis}"
repo="${REPO:-devswha/ovis}"
name="${RUNNER_NAME:-eamac-ovis-mac}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ "$(uname -s)/$(uname -m)" == Darwin/arm64 ]] || { echo "mac-setup.sh runs on an Apple Silicon Mac" >&2; exit 2; }
mkdir -p "$dir/hooks" "$dir/tools"
cd "$dir"

if [[ ! -x ./config.sh ]]; then
  curl -fsSL -o runner.tgz "https://github.com/actions/runner/releases/download/v$version/actions-runner-osx-arm64-$version.tar.gz"
  echo "$sha256  runner.tgz" | shasum -a 256 -c
  tar xzf runner.tgz
  rm runner.tgz
fi

# a minimal Rust toolchain of the runner's own, for remote-bundles.yml's PTY host build
export RUSTUP_HOME="$dir/tools/rustup" CARGO_HOME="$dir/tools/cargo"
if [[ ! -x "$CARGO_HOME/bin/rustup" ]]; then
  init="$(mktemp)"
  curl -fsSL -o "$init" https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init
  echo "$(curl -fsSL https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init.sha256 | awk '{print $1}')  $init" | shasum -a 256 -c
  chmod +x "$init"
  "$init" -y --no-modify-path --profile minimal
  rm "$init"
fi

install -m 755 "$here/job-started.sh" hooks/job-started.sh
cat > .env <<ENV
LANG=en_US.UTF-8
ACTIONS_RUNNER_HOOK_JOB_STARTED=$dir/hooks/job-started.sh
RUSTUP_HOME=$RUSTUP_HOME
CARGO_HOME=$CARGO_HOME
ENV
echo "$CARGO_HOME/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" > .path

if [[ ! -f .runner ]]; then
  ./config.sh --unattended --url "https://github.com/$repo" --token "${REGISTRATION_TOKEN:?REGISTRATION_TOKEN is required to register}" \
    --name "$name" --labels self-hosted-ovis-mac --work _work --replace
fi
[[ -f .service ]] || ./svc.sh install
./svc.sh stop >/dev/null 2>&1 || true
./svc.sh start

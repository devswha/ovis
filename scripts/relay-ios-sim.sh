#!/usr/bin/env bash
# The iOS app paired through the Ovis relay in the iOS Simulator on the test MacBook Air (`ssh eamac`,
# never the MacBook Pro): todo 21's scenario as a script. Run on this PC from a checkout:
#
#   bash scripts/relay-ios-sim.sh [evidence-dir]
#
# This PC: dist-shell/ served as Pages serves it (scripts/pages-static.ts), the Bun relay
# (relay/bun.ts) and a PC (createServer on the isolated herdr test session, a mkdtemp state dir),
# all on 127.0.0.1, with `tailscale serve` giving the shell and the relay HTTPS/WSS addresses on
# two free ports for this run only. The PC's relay is that wss: address, as in production: no seam.
#
# eamac: a fresh clone in /tmp from a git bundle of HEAD (nothing is pushed), the app built with
# OVIS_APP_URL naming this run's shell and signed to run locally (CODE_SIGN_IDENTITY=-: an unsigned
# build cannot store the relay device key, WebKit's IndexedDB put of a CryptoKey fails with
# DataCloneError), its own new Simulator, and WebDriverAgent built in that clone to paste the
# pairing link on the connect screen, tap Open, then Pair, and wait for the PC's workspace.
#
# Everything is undone on exit: the Simulator deleted, the /tmp clone removed, the serve entries
# turned off (and checked gone), the local servers stopped.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
evidence="${1:-${UI_EVIDENCE_DIR:-}}"
[ -n "$evidence" ] && mkdir -p "$evidence"
run="$(mktemp -d)"
host="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
serve_ports=()
stack_pid=""
remote=""

say() { printf '[relay-ios-sim] %s\n' "$*"; }

cleanup() {
  local code=$?
  set +e
  if [ -n "$remote" ]; then
    ssh -o BatchMode=yes eamac "bash -s -- $(printf '%q' "$remote")" <<'EOF'
r="$1"
[ -f "$r/wda.pid" ] && kill "$(cat "$r/wda.pid")" 2>/dev/null
[ -f "$r/udid" ] && { xcrun simctl shutdown "$(cat "$r/udid")" 2>/dev/null; xcrun simctl delete "$(cat "$r/udid")"; }
rm -rf "$r"
test ! -e "$r" && echo "eamac: $r removed"
EOF
  fi
  if [ -n "$stack_pid" ]; then kill "$stack_pid" 2>/dev/null; wait "$stack_pid" 2>/dev/null; say "local stack stopped"; fi
  for port in "${serve_ports[@]}"; do tailscale serve --https="$port" off >/dev/null 2>&1; done
  local left
  left="$(tailscale serve status --json | jq -r '.TCP // {} | keys[]')"
  for port in "${serve_ports[@]}"; do
    if grep -qx "$port" <<<"$left"; then say "serve port $port is still on"; code=1; else say "tailscale serve :$port off"; fi
  done
  [ -n "$evidence" ] && [ -f "$run/stack.log" ] && cp "$run/stack.log" "$evidence/task-23-ios-stack.log"
  rm -rf "$run"
  exit "$code"
}
trap cleanup EXIT

local_port() { bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop(true);'; }
serve_port() {
  local taken port
  taken="$(tailscale serve status --json | jq -r '.TCP // {} | keys[]')"
  for port in $(seq 18930 18999); do
    if ! grep -qx "$port" <<<"$taken" && [[ ! " ${serve_ports[*]} " == *" $port "* ]]; then echo "$port"; return; fi
  done
  return 1
}

[ -f "$repo/dist-shell/index.html" ] || (cd "$repo" && bun run build:shell)
shell_local="$(local_port)"
relay_local="$(local_port)"
shell_https="$(serve_port)"; serve_ports+=("$shell_https")
relay_https="$(serve_port)"; serve_ports+=("$relay_https")
app_url="https://$host:$shell_https"
relay_url="wss://$host:$relay_https"
tailscale serve --bg --https="$shell_https" "http://127.0.0.1:$shell_local" >/dev/null
tailscale serve --bg --https="$relay_https" "http://127.0.0.1:$relay_local" >/dev/null
say "shell $app_url -> 127.0.0.1:$shell_local; relay $relay_url -> 127.0.0.1:$relay_local"

cat >"$run/stack.ts" <<'EOF'
const repo = process.env["REPO"]!;
await import(`${repo}/scripts/test-herdr.ts`);
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { startBunRelay } = await import(`${repo}/relay/bun.ts`) as typeof import("../relay/bun.ts");
const { servePagesSite } = await import(`${repo}/scripts/pages-static.ts`) as typeof import("./pages-static.ts");
const { createServer } = await import(`${repo}/server/index.ts`) as typeof import("../server/index.ts");
const { RelayService } = await import(`${repo}/server/relay/service.ts`) as typeof import("../server/relay/service.ts");
const { workspaceClose, workspaceCreate } = await import(`${repo}/server/herdr/client.ts`) as typeof import("../server/herdr/client.ts");
const relay = startBunRelay({ hostname: "127.0.0.1", port: Number(process.env["RELAY_LOCAL"]) });
const site = servePagesSite(join(repo, "dist-shell"), Number(process.env["SHELL_LOCAL"]));
const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-ios-sim-"));
const workspace = await workspaceCreate({ cwd: stateDir, label: "relay-ios-sim" });
const synced = Promise.withResolvers<void>();
const service = new RelayService({ stateDir, relay: process.env["RELAY_URL"]!, app: process.env["APP_URL"]!, connect: (url) => {
  const socket = new WebSocket(url);
  socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve(); });
  return socket;
} });
const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, relay: service });
const base = `http://127.0.0.1:${app.port}`;
const post = (path: string) => fetch(`${base}/api/relay${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
const devices = app.context.services.devices;
const pairRelay = devices.pairRelay.bind(devices);
devices.pairRelay = (...args) => { const paired = pairRelay(...args); if (paired) console.log(`PAIRED ${paired.device.id}`); return paired; };
let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await service.shutdown(); app.stop(); await relay.stop(); site.stop(true);
  await workspaceClose(workspace.workspace.workspace_id).catch(() => undefined);
  rmSync(stateDir, { recursive: true, force: true });
  console.log("STOPPED");
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
const started = await post("/start");
if (started.status !== 200) throw new Error(`relay start: ${started.status} ${await started.text()}`);
await Promise.race([synced.promise, Bun.sleep(30_000).then(() => { throw new Error("the PC did not sync with the relay through tailscale serve"); })]);
console.log(`SYNCED ${process.env["RELAY_URL"]}`);
console.log(`OFFER ${(await (await post("/offer")).json() as { url: string }).url}`);
await new Promise(() => {});
EOF
REPO="$repo" SHELL_LOCAL="$shell_local" RELAY_LOCAL="$relay_local" APP_URL="$app_url" RELAY_URL="$relay_url" \
  bun "$run/stack.ts" >"$run/stack.log" 2>&1 &
stack_pid=$!
timeout 120 bash -c "until grep -q '^OFFER ' '$run/stack.log'; do kill -0 $stack_pid || exit 1; sleep 0.2; done" \
  || { cat "$run/stack.log"; say "the local stack did not come up"; exit 1; }
offer="$(grep -m1 '^OFFER ' "$run/stack.log" | cut -d' ' -f2)"
case "$offer" in "$app_url"/s/*'#offer='*) ;; *) say "the offer is not on this run's shell: $offer"; exit 1;; esac
say "PC synced with the relay; offer ${offer%%#*}#offer=…"

git -C "$repo" bundle create "$run/ovis.bundle" HEAD >/dev/null 2>&1
remote="$(ssh -o BatchMode=yes eamac 'mktemp -d /tmp/ovis-relay-ios.XXXXXX')"
scp -q "$run/ovis.bundle" "eamac:$remote/ovis.bundle"
say "eamac: fresh clone in $remote"

ssh -o BatchMode=yes eamac "bash -s -- $(printf '%q ' "$remote" "$app_url" "$offer")" <<'EOF'
set -euo pipefail
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
r="$1"; app_url="$2"; offer="$3"
cd "$r"
git -c advice.detachedHead=false clone -q ovis.bundle ovis
cd ovis
bun install --frozen-lockfile >/dev/null
(cd app && bun install --frozen-lockfile >/dev/null && OVIS_APP_URL="$app_url" bun run build:web >/dev/null && npx cap sync ios >/dev/null)
grep -q "APP_ORIGIN = \"$app_url\"" app/ios/App/App/public/shell.js
udid="$(xcrun simctl create "ovis-relay-ios-$(basename "$r")" "iPhone 18 Pro" com.apple.CoreSimulator.SimRuntime.iOS-27-0)"
echo "$udid" >"$r/udid"
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" >/dev/null
echo "eamac: Simulator $udid booted"
xcodebuild -quiet -project app/ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
  -destination "id=$udid" -derivedDataPath "$r/dd" CODE_SIGN_IDENTITY=- build >"$r/build.log" 2>&1 || { tail -40 "$r/build.log"; exit 1; }
xcrun simctl install "$udid" "$r/dd/Build/Products/Debug-iphonesimulator/App.app"
codesign -dv "$r/dd/Build/Products/Debug-iphonesimulator/App.app" 2>&1 | grep -E '^Signature=' || true
echo "eamac: app built signed to run locally and installed"

git clone -q --depth 1 https://github.com/appium/WebDriverAgent "$r/wda"
port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
TEST_RUNNER_USE_PORT="$port" xcodebuild -project "$r/wda/WebDriverAgent.xcodeproj" -scheme WebDriverAgentRunner \
  -destination "id=$udid" -derivedDataPath "$r/wdadd" test >"$r/wda.log" 2>&1 &
echo $! >"$r/wda.pid"
wda="http://127.0.0.1:$port"
deadline=$((SECONDS + 900))
until curl -sf "$wda/status" >/dev/null; do
  [ $SECONDS -lt $deadline ] || { tail -40 "$r/wda.log"; echo "WebDriverAgent did not start"; exit 1; }
  kill -0 "$(cat "$r/wda.pid")" || { tail -40 "$r/wda.log"; exit 1; }
  sleep 2
done
echo "eamac: WebDriverAgent on $wda"

json() { curl -sf -H 'content-type: application/json' "$@"; }
answer="$(curl -s -H 'content-type: application/json' -X POST "$wda/session" -d '{"capabilities":{"alwaysMatch":{"bundleId":"sh.ovis.app","arguments":["-AppleLanguages","(en)","-AppleLocale","en_US"]}}}')"
session="$(python3 -c 'import json,sys; d = json.loads(sys.argv[1]); print(d.get("sessionId") or d["value"]["sessionId"])' "$answer")" || { echo "no WebDriverAgent session: $answer"; exit 1; }
find() { json -X POST "$wda/session/$session/element" -d "$1" | python3 -c 'import json,sys; v=json.load(sys.stdin)["value"]; print(v.get("ELEMENT") or v.get("element-6066-11e4-a52e-4f735466ecf0") or "")' 2>/dev/null || true; }
# the page's elements appear in the accessibility tree once the web view drew them: bounded, not timed
wait_for() {
  local query="$1" what="$2" until=$((SECONDS + 120)) element=""
  while [ -z "$element" ]; do
    if [ $SECONDS -ge $until ]; then
      echo "not within 120 s: $what; on screen:" >&2
      curl -s "$wda/source?format=description" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"][:6000])' >&2 || true
      exit 1
    fi
    element="$(find "$query")"
    [ -n "$element" ] || sleep 1
  done
  echo "$element"
}
field="$(wait_for '{"using":"class chain","value":"**/XCUIElementTypeTextField"}' "the connect screen's address field")"
json -X POST "$wda/session/$session/element/$field/click" -d '{}' >/dev/null
json -X POST "$wda/session/$session/element/$field/value" -d "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$offer")" >/dev/null
open="$(wait_for '{"using":"predicate string","value":"type == \"XCUIElementTypeButton\" AND label IN {\"Open\", \"열기\"}"}' "the Open button")"
json -X POST "$wda/session/$session/element/$open/click" -d '{}' >/dev/null
wait_for '{"using":"predicate string","value":"label BEGINSWITH \"Pair with\" OR label ENDSWITH \"페어링할까요?\""}' "the hosted shell's pairing question" >/dev/null
xcrun simctl io "$udid" screenshot "$r/ios-confirm.png" >/dev/null
echo "eamac: the app opened the pairing link on its connect screen: the shell asks to pair"
pair="$(wait_for '{"using":"predicate string","value":"type == \"XCUIElementTypeButton\" AND label IN {\"Pair\", \"페어링\"}"}' "the Pair button")"
json -X POST "$wda/session/$session/element/$pair/click" -d '{}' >/dev/null
drawer="$(wait_for '{"using":"predicate string","value":"type == \"XCUIElementTypeButton\" AND label == \"Open workspace list\""}' "the app over the relay")"
json -X POST "$wda/session/$session/element/$drawer/click" -d '{}' >/dev/null
wait_for '{"using":"predicate string","value":"label CONTAINS \"relay-ios-sim\""}' "the PC's relay-ios-sim workspace in the app" >/dev/null
xcrun simctl io "$udid" screenshot "$r/ios-app.png" >/dev/null
echo "eamac: paired through the relay; the app lists the PC's relay-ios-sim workspace"
json -X DELETE "$wda/session/$session" >/dev/null || true
EOF

grep -q '^PAIRED ' "$run/stack.log" || { say "the PC enrolled no relay device"; exit 1; }
say "PC enrolled $(grep -m1 '^PAIRED ' "$run/stack.log" | cut -d' ' -f2) through the relay"
if [ -n "$evidence" ]; then
  scp -q "eamac:$remote/ios-confirm.png" "$evidence/task-23-ios-confirm.png"
  scp -q "eamac:$remote/ios-app.png" "$evidence/task-23-ios-app.png"
fi
say "PASS relay iOS Simulator"

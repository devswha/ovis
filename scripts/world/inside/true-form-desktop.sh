#!/bin/sh
# The true-form-desktop stand-in's steps (B5), in the order a long-lived install comes up (the default session before
# Ovis, the test sessions after it, the update waited for by the running process), run as the machine's user (standins.ts:
# seven letters, ovisusr by default) on a :systemd machine. Usage (inside the machine): sh true-form-desktop.sh <step>,
# with WORLD_PLUGIN_ID (herdr's id of the plugin, from the repository's herdr-plugin.toml) and WORLD_INSIDE set, as
# machines.ts runs it; standins.ts says which steps a form runs.
#   units          the user manager made "degraded" by one failed unrelated unit (ydotool, as on a long-lived desktop)
#   prepare        the machine's Ovis 0.4.22 checkout COPIED to where herdr installs a GitHub plugin (owned by the
#                  machine's user, so git and the updater work), its origin a copy of the tag mirror (v0.1.0 .. v0.5.1), herdr's record of the plugin,
#                  the plugin's env file (127.0.0.1:7317, a test token) and, for 0.5.1, bun's package cache
#   herdr-default  the default herdr 0.9.5 server only: its startup hook is the one that starts Ovis, on its socket
#   agents         three agents in the default session: a claude on its card, a claude working, a codex idle
#   ovis           waits for the machine's Ovis, started by herdr's own startup hook, on 127.0.0.1:7317
#   settings-install  0.5.1 form: 0.5.1 installed as a user does it, from Settings (OVIS_AUTO_UPDATE stays unset):
#                  ask the updater to check, wait for its offer, POST /api/updates/install with the offered revision
#   update-wait    0.5.1 form: waits (5 min at most) until the process listening on 7317 runs from a release-* folder
#                  of version 0.5.1 and current.json names it; then the release gets the 0.5.1 terminal host program
#   leftover-update  0.5.1 form: a second update folder, 135360771fa3e7bd/ (left by an install of another checkout
#                  path or port; which one cannot be derived from its name), as a leftover: current.json, two releases
#                  (hard-linked copies of the running one) and supervisor.lock.guard, nothing running from it
#   direct         0.5.1 form: direct connections turned on as Settings does (POST /api/relay/direct), kept in
#                  ~/.config/ovis/relay/direct.json by the server itself
#   sessions       the five test sessions' herdr servers from ~/test-sessions/bin (after Ovis, so it stays on the default)
#   sessions-dead  those five servers killed: their folders stay with socket files nobody listens on (as a kill leaves them)
#   core           herdr-core 0.1.17's default core on the runtime folder, beside classic herdr, with four plain shells
#   demo           an earlier demo's leftovers and its user unit ovis-demo-link (only with :demo)
set -eu
PLUGIN_ID=${WORLD_PLUGIN_ID:?the id of the plugin in herdr, which machines.ts reads from herdr-plugin.toml}
INST="$HOME/.config/herdr/plugins/github-installations/$PLUGIN_ID-aa47ee43150f/119016-0"
CO="$INST/checkout"
ENVFILE="$HOME/.config/herdr/plugins/config/$PLUGIN_ID/env"
SESSIONS="ovis-test ovis-test-settings-terminal-keys ovis-test-stk-a ovis-test-stk-b ovis-test-merge-pass-3142"
sock() { if [ -z "$1" ]; then echo "$HOME/.config/herdr/herdr.sock"; else echo "$HOME/.config/herdr/sessions/$1/herdr.sock"; fi; }
ping() { python3 -c 'import socket,sys,json
s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sys.argv[1])
s.sendall((json.dumps({"id":"p","method":"ping","params":{}})+"\n").encode()); print(s.recv(4096).decode().strip())' "$1"; }
# bounded: `what` must answer within 30 s (300 tries 0.1 s apart)
until_ok() { what=$1; shift; i=0; until "$@" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 300 ] && { echo "no answer: $what" >&2; exit 1; }; sleep 0.1; done; }
health() { curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:7317/api/health || true; }
token() { sed -n 's/^OVIS_TOKEN=//p' "$ENVFILE"; }
# the machine's Ovis API with its token: the header goes to curl on stdin (--config -), never on a command line;
# through the Ovis state folder's serve.sock if its server has one, on 127.0.0.1:7317 otherwise (serve-call.sh, in WORLD_INSIDE, which
# machines.ts passes; this script's own folder when run by hand)
# usage: api METHOD PATH BODY [more curl arguments]; an empty BODY sends none
api() { method=$1; path=$2; body=$3; shift 3
  printf 'header = "authorization: Bearer %s"\n' "$(token)" | sh "${WORLD_INSIDE:-$(dirname "$0")}/serve-call.sh" "$HOME/.config/ovis" http://127.0.0.1:7317 "$path" \
    -s -m 10 --config - -X "$method" -H 'origin: http://127.0.0.1:7317' -H 'x-herdr-update: 1' ${body:+-H 'content-type: application/json' -d "$body"} "$@"; }
version() { sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -1; }
serve() {
  bin=$1; session=$2
  if [ -z "$session" ]; then (cd "$HOME" && setsid nohup "$bin" server >"$HOME/herdr-default.log" 2>&1 </dev/null &)
  else (cd "$HOME" && setsid nohup "$bin" --session "$session" server >"$HOME/herdr-$session.log" 2>&1 </dev/null &); fi
  until_ok "${session:-default}" ping "$(sock "$session")"
}
chain() { for p in $(pgrep -u "$(id -u)" bun); do c=$(readlink "/proc/$p/cwd"); printf '%s %s version=%s cwd=%s|' "$p" "$(tr '\0' ' ' < "/proc/$p/cmdline" | sed 's/.*\(server\/[a-z]*\.ts\).*/\1/')" "$(version "$c")" "$c"; done; }

case "$1" in
units)
  systemd-run --user --unit=ydotool /bin/false >/dev/null 2>&1 || true
  i=0; until [ "$(systemctl --user is-system-running 2>&1)" = degraded ] || [ $i -gt 100 ]; do sleep 0.2; i=$((i+1)); done
  echo "user manager: $(systemctl --user is-system-running 2>&1); linger: $(loginctl show-user "$(id -un)" -p Linger --value)" ;;
prepare)
  [ -f /opt/ovis-0.4.22/herdr-plugin.toml ] || { echo "the machine's Ovis 0.4.22 is not mounted at /opt/ovis-0.4.22" >&2; exit 1; }
  mkdir -p "$INST"; touch "$INST/.in-use"
  cp -a /opt/ovis-0.4.22 "$CO"
  cp -a /opt/od-mirror.git "$HOME/od-mirror.git"
  git -C "$CO" remote set-url origin "file://$HOME/od-mirror.git"
  git -C "$CO" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
  if [ -d /opt/od-bun-cache ]; then mkdir -p "$HOME/.bun/install"; cp -a /opt/od-bun-cache "$HOME/.bun/install/cache"; fi
  python3 - "$CO" "$HOME/.config/herdr/plugins.json" <<'EOF'
import json, sys, tomllib
co, out = sys.argv[1], sys.argv[2]
m = tomllib.load(open(f"{co}/herdr-plugin.toml", "rb"))
entry = {"plugin_id": m["id"], **{k: m[k] for k in ("name", "version", "min_herdr_version", "description", "platforms") if k in m},
         "manifest_path": f"{co}/herdr-plugin.toml", "plugin_root": co, "enabled": True,
         "build": m.get("build", []), "startup": m.get("startup", []), "actions": m.get("actions", []), "panes": m.get("panes", []),
         "source": {"kind": "github", "owner": m["id"].split(".", 1)[0], "repo": m["id"].split(".", 1)[1], "requested_ref": "v0.4.22",
                    "resolved_commit": "a4ff0c942716602c43362f05c8511984e2bcae44", "managed_path": co.rsplit("/checkout", 1)[0]}}
json.dump([entry], open(out, "w"), indent=2)
print("plugins.json:", entry["plugin_id"], entry["version"], entry["plugin_root"])
EOF
  mkdir -p "$(dirname "$ENVFILE")"
  ( umask 077; printf 'HOST=127.0.0.1\nPORT=7317\nOVIS_TOKEN=%s\n' "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$ENVFILE" )
  echo "checkout: HEAD $(git -C "$CO" rev-parse --short HEAD), $(git -C "$CO" describe --tags --exact-match 2>&1), owner $(stat -c %U "$CO"), origin $(git -C "$CO" remote get-url origin)"
  echo "plugin env: $ENVFILE (HOST, PORT 7317, a test token); bun cache: $([ -d "$HOME/.bun/install/cache" ] && echo copied || echo none)" ;;
herdr-default)
  mkdir -p "$HOME/.local/bin" "$HOME/test-sessions/bin"
  cp /opt/world-bin/herdr "$HOME/.local/bin/herdr"; cp /opt/world-bin/herdr "$HOME/test-sessions/bin/herdr"
  chmod 755 "$HOME/.local/bin/herdr" "$HOME/test-sessions/bin/herdr"
  serve "$HOME/.local/bin/herdr" ""
  echo "default: $(ping "$(sock "")")" ;;
agents)
  bun /opt/world/inside/machine.ts agent >/dev/null
  bun /opt/world/inside/machine.ts agent-as working claude working >/dev/null
  bun /opt/world/inside/machine.ts agent-as idle codex idle >/dev/null
  "$HOME/.local/bin/herdr" pane list ;;
ovis)
  i=0; while [ "$(health)" != 200 ]; do i=$((i+1)); [ $i -gt 600 ] && { echo "the machine's Ovis did not answer on 127.0.0.1:7317 within 60 s" >&2; exit 1; }; sleep 0.1; done
  # health over TCP, as everywhere: it stays open there; the token on curl's stdin
  echo "the machine's Ovis: $(printf 'header = "authorization: Bearer %s"\n' "$(token)" | curl -s -m 3 --config - http://127.0.0.1:7317/api/health | head -c 300)"
  echo "its chain: $(chain)" ;;
settings-install)
  api POST /api/updates/check '{}' > /dev/null
  i=0; rev=""
  while [ -z "$rev" ]; do
    rev=$(api GET /api/updates '' | python3 -c 'import json,sys
s=json.load(sys.stdin); r=s.get("latest_revision") or ""
print(r if s.get("revision_bound_install") is True and r and r != s.get("current_revision") else "")' 2>/dev/null || true)
    i=$((i+1)); [ $i -gt 180 ] && { echo "no update on offer within 180 s: $(api GET /api/updates '' | head -c 400)" >&2; exit 1; }
    [ -z "$rev" ] && sleep 1
  done
  answer=$(api POST /api/updates/install "{\"expected_revision\":\"$rev\"}" -w ' [%{http_code}]' || true)
  echo "Settings, install the update on offer ($rev): $(echo "$answer" | tail -c 160); OVIS_AUTO_UPDATE in the env file: $(grep -c '^OVIS_AUTO_UPDATE=' "$ENVFILE" || true)" ;;
update-wait)
  start=$(date +%s)
  while :; do
    pid=$(ss -Hltnp 'sport = :7317' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1); cwd=""; ver=""
    [ -n "$pid" ] && cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) && ver=$(version "$cwd")
    # settled, not the updater's trial start: updates/<hash>/current.json names the running release, and it answers
    case "$cwd" in */release-*)
      [ "$ver" = 0.5.1 ] && grep -q "$(basename "$cwd")" "$(dirname "$cwd")/current.json" 2>/dev/null && [ "$(health)" = 200 ] && break;;
    esac
    if [ $(( $(date +%s) - start )) -ge 300 ]; then
      echo "no 0.5.1 server after 300 s: the listener on 7317 is pid=${pid:-none} cwd=${cwd:-none} version=${ver:-none}; $(chain)" >&2
      exit 1
    fi
    sleep 1
  done
  mkdir -p "$cwd/bin"; cp /opt/od-pty-host/* "$cwd/bin/"
  echo "0.5.1 installed by 0.4.22's updater after $(( $(date +%s) - start )) s: server pid $pid in $cwd; terminal host program copied into its bin/"
  echo "its chain: $(chain)" ;;
leftover-update)
  pid=$(ss -Hltnp 'sport = :7317' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1); cwd=$(readlink "/proc/$pid/cwd")
  L="$HOME/.config/ovis/updates/135360771fa3e7bd"; mkdir -p "$L"
  for n in 1 2; do r=$(mktemp -d "$L/release-XXXXXX"); rmdir "$r"; cp -al "$cwd" "$r"; done
  python3 - "$(dirname "$cwd")/current.json" "$L/current.json" "$(ls -d "$L"/release-* | tail -1)" <<'EOF'
import json, sys
current = json.load(open(sys.argv[1])); current["directory"] = sys.argv[3]
json.dump(current, open(sys.argv[2], "w"))
EOF
  : > "$L/supervisor.lock.guard"
  echo "leftover update folder (a leftover folder of an earlier install): $(ls "$L" | tr '\n' ' ')" ;;
direct)
  answer=$(api POST /api/relay/direct '{"on":true}' -w ' [%{http_code}]' || true)
  saved=$(cat "$HOME/.config/ovis/relay/direct.json" 2>&1 || true)
  echo "Settings, direct on: $(echo "$answer" | tail -c 300); relay/direct.json: $saved"
  case "$saved" in *'"on":true'*|*'"on": true'*) ;; *) echo "direct is not on: $answer" >&2; exit 1 ;; esac ;;
sessions)
  for s in $SESSIONS; do serve "$HOME/test-sessions/bin/herdr" "$s"; done
  for s in "" $SESSIONS; do echo "${s:-default}: $(ping "$(sock "$s")" | head -c 80)"; done
  echo "the machine's Ovis still answers: $(health)" ;;
sessions-dead)
  for s in $SESSIONS; do pkill -KILL -u "$(id -u)" -f -- "--session $s server" || true; done
  i=0; while [ "$(pgrep -u "$(id -u)" -x herdr | wc -l)" -gt 1 ]; do i=$((i+1)); [ $i -gt 100 ] && { echo "the test sessions' servers did not end" >&2; exit 1; }; sleep 0.1; done
  for s in $SESSIONS; do
    d="$HOME/.config/herdr/sessions/$s"
    echo "$s: $(ls "$d" | tr '\n' ' ')| herdr.sock $(python3 -c 'import socket,sys
s=socket.socket(socket.AF_UNIX)
try: s.connect(sys.argv[1]); print("ANSWERS")
except OSError as e: print("refused:", e.strerror)' "$d/herdr.sock")"
  done
  echo "herdr servers left: $(pgrep -u "$(id -u)" -x herdr | wc -l) (the default); the machine's Ovis: $(health)" ;;
core)
  cp /opt/od-bin/herdr-core-0.1.17 "$HOME/.local/bin/herdr-core"; chmod 755 "$HOME/.local/bin/herdr-core"
  env -u HC_SOCKET -u HC_SESSION "$HOME/.local/bin/herdr-core" server start >/dev/null 2>&1 || true
  until_ok "herdr-core" env -u HC_SOCKET -u HC_SESSION "$HOME/.local/bin/herdr-core" server status --json
  # the default core holds four plain shells
  for n in 1 2 3 4; do (cd "$HOME" && env -u HC_SOCKET -u HC_SESSION "$HOME/.local/bin/herdr-core" run --bg --no-parent --name "shell-$n" -- bash >/dev/null 2>&1); done
  echo "herdr-core: $(env -u HC_SOCKET -u HC_SESSION "$HOME/.local/bin/herdr-core" server status --json 2>&1 | tail -1 | head -c 160); terminals: $(env -u HC_SOCKET -u HC_SESSION "$HOME/.local/bin/herdr-core" ls --json 2>/dev/null | python3 -c 'import json,sys; t=json.load(sys.stdin); t=t.get("terminals", t) if isinstance(t, dict) else t; print(len(t))')" ;;
demo)
  D="$HOME/.local/share/ovis-demo-link"
  mkdir -p "$D/state" "$HOME/demo-join" "$HOME/demo-scratch"
  printf '{"state":"connected","path":"relay","since":1794647640}\n' > "$D/state/status.json"
  printf '#!/bin/sh\nexec sleep infinity\n' > "$D/ovis-link"; chmod 755 "$D/ovis-link"
  printf 'demo scratch notes, 38 bytes long ok\n' > "$HOME/demo-scratch/notes.txt"
  systemd-run --user --unit=ovis-demo-link "$D/ovis-link" run --state "$D/state" >/dev/null
  echo "ovis-demo-link: $(systemctl --user is-active ovis-demo-link)" ;;
*) echo "unknown step $1" >&2; exit 2 ;;
esac

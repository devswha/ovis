/**
 * The proof of the machine primitives the stand-in and the acceptance script asked for (run by proof.ts as
 * `machine`): a machine's own user and hostname, mounts under its home, a systemd user unit, the stand-in tailscale,
 * the stand-in agent's controls and a server from a start-line file (B6). Each claim with a case that breaks it.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describePreset, PLUGIN_ID, PRESET_NAME, presetMachine, standinUser, TRUE_FORM, type Preset } from "./standins.ts";

/** The stand-in's user (seven letters, ovisusr unless OVIS_STANDIN_USER names another) and its home. */
const USER = standinUser(process.env);
const HOME = `/home/${USER}`;
import { startWorld } from "./world.ts";

type Verdict = (claim: string, expected: "PASS" | "FAIL", ok: boolean, detail: string) => void;

export async function machineProof(verdict: Verdict, scratchRoot: string, prefix: string): Promise<void> {
  const files = join(scratchRoot, `${prefix}-machine-files`);
  const repo = join(files, "checkout");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", repo]);
  const startLine = join(files, "server.env");
  writeFileSync(startLine, `PORT=17699\nHOST=127.0.0.1\nOVIS_STATE_DIR=${HOME}/.local/share/ovis-trial/state\nOVIS_TELEMETRY=0\n`);
  chmodSync(startLine, 0o600);
  const badLine = join(files, "bad.env");
  writeFileSync(badLine, "PORT=17698\nexport HOST=127.0.0.1\n");
  const mount = `${repo}:${HOME}/.config/herdr/plugins/github-installations/x/0/checkout`;
  await using world = await startWorld({ name: `${prefix}ma`, scratchRoot, machines: [
    { name: "od", engine: "herdr", start: "all", systemd: true, user: USER, hostname: PRESET_NAME, mounts: [mount] },
    { name: "m2", engine: "herdr", start: "none", mounts: [`${repo}:/home/runner/checkout`] },
  ] });
  const od = world.machine("od");
  const m2 = world.machine("m2");
  const shell = async (machine: typeof od, line: string) => { const ran = await machine.exec(["sh", "-c", line]); return (ran.out + ran.err).trim(); };
  const who = await shell(od, 'echo "$(id -un) $(id -u) $(id -g) $HOME $(hostname)"');
  const mine = `${process.getuid?.()} ${process.getgid?.()}`;
  verdict(`the machine's own user and hostname (${USER}, this PC's uid and gid ${mine}, ${HOME}, ${PRESET_NAME})`, "PASS", who === `${USER} ${mine} ${HOME} ${PRESET_NAME}`, who);
  const owners = await shell(od, "stat -c '%U %n' ~/.config ~/.config/herdr/plugins/github-installations/x/0");
  verdict("folders docker made for a mount under the home belong to the machine's user", "PASS", owners.split("\n").every((line) => line.startsWith(`${USER} `)), owners.replace(/\n/g, " | "));
  const git = await shell(od, "git -C ~/.config/herdr/plugins/github-installations/x/0/checkout status --short --branch 2>&1 | head -1");
  verdict("git accepts a checkout mounted from this PC on a machine whose user has this PC's uid", "PASS", git.startsWith("##"), git);
  const gitRunner = await shell(m2, "git -C ~/checkout status 2>&1 | head -1");
  verdict("git on the same mount on a machine of user runner (uid 1001)", "FAIL", !/dubious ownership/.test(gitRunner), gitRunner);
  await od.unit("od-probe", ["sleep", "300"]);
  const active = await shell(od, "systemctl --user is-active od-probe");
  await od.stopUnit("od-probe");
  const stopped = await shell(od, "systemctl --user is-active od-probe; true");
  verdict("a process as a user unit of the machine's user manager, then stopped", "PASS", active === "active" && stopped !== "active", `${active} -> ${stopped}`);
  await od.fakeTailscale("owner@example.test");
  const status = await shell(od, "tailscale status --json");
  verdict("the stand-in tailscale names its fixed owner", "PASS", status.includes('"LoginName":"owner@example.test"'), status.slice(0, 120));
  const up = await od.exec(["tailscale", "up"]);
  verdict("the stand-in tailscale doing anything but status --json", "FAIL", up.code === 0, `exit ${up.code}: ${up.err.trim()}`);
  const agent = od.standIn();
  await agent.freeze();
  const frozen = await agent.frozen();
  await agent.thaw();
  verdict("the stand-in agent freezes and thaws", "PASS", frozen && !(await agent.frozen()), `frozen ${frozen}`);
  const asked = await agent.asks();
  await agent.ask();
  const askedAfter = await agent.asks();
  verdict("the stand-in agent puts its question up again on ask()", "PASS", askedAfter === asked + 1, `asks ${asked} -> ${askedAfter}`);
  await od.serverStartFrom(startLine);
  const health = (await od.exec(["curl", "-s", "-m", "3", "http://127.0.0.1:17699/api/health"])).out;
  const env = await shell(od, "for p in $(pgrep -x bun); do if tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qx PORT=17699; then tr '\\0' '\\n' < /proc/$p/environ | grep -E '^(PORT|OVIS_STATE_DIR|HOME)=' | sort; break; fi; done");
  verdict("B6: a server started from exactly a start-line file answers on its PORT, with its state folder", "PASS", health.includes('"ok":true') && env.includes("PORT=17699") && env.includes(`OVIS_STATE_DIR=${HOME}/.local/share/ovis-trial/state`), env.replace(/\n/g, " "));
  const bad = await od.serverStartFrom(badLine).then(() => "started", (error: unknown) => (error as Error).message.slice(0, 160));
  const refused = await shell(od, "tail -3 ~/server.log");
  verdict("B6: a start-line file with a line that is not NAME=value", "FAIL", bad === "started", `${bad} | ${refused.replace(/\n/g, " ")}`);
  await agent.finish();
  let gone = false;
  for (const deadline = Date.now() + 5000; !gone && Date.now() < deadline;) { gone = !(await agent.alive()); if (!gone) await Bun.sleep(100); }
  // a terminal's command line is no process's argument in the machine (term.sh runs it through eval): what a caller
  // types there, a token say, is not in any ps output; a process started with it as an argument is the case that shows
  const marker = `world-marker-${crypto.randomUUID()}`;
  await od.terminal("argcheck", `sleep 120 # ${marker}`);
  const listed = async () => (await od.exec(["ps", "-eo", "args"])).out.split("\n").filter((line) => line.includes(marker));
  // and a user unit's environment (EnvironmentFile, not --setenv): the unit has it, no command line carries it
  await od.unit("od-envprobe", ["sleep", "120"], { WORLD_MARK: marker });
  // systemd-run returns once the unit runs: its process's environment is there to read
  const unitGot = await shell(od, 'tr "\\0" "\\n" < /proc/$(systemctl --user show -p MainPID --value od-envprobe)/environ | sed -n "s/^WORLD_MARK=//p"');
  verdict("a terminal's command line and a user unit's environment (each with a marker) are in no process's arguments in the machine", "PASS",
    (await listed()).length === 0 && /sleep 120/.test(await shell(od, "ps -eo args")) && unitGot === marker, `${(await listed()).join(" | ") || "none carries it"}; the unit read ${unitGot === marker ? "the marker" : JSON.stringify(unitGot.slice(0, 60))}`);
  await od.background("argmark", ["sh", "-c", `sleep 120 # ${marker}`]);
  verdict("the same check on a process started with the marker as its argument", "FAIL", (await listed()).length === 0, (await listed()).join(" | ").slice(0, 160) || "none carries it");
  verdict("the stand-in agent ends on finish()", "PASS", gone, "");
}

/** What the true-form-desktop machine runs, read from inside it: one line per fact, `name value`. */
const OD_FACTS = String.raw`
v() { sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -1; }
echo "who $(id -un) $(hostname) $(systemctl --user is-system-running)"
pid=$(ss -Hltnp 'sport = :7317' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1); cwd=$(readlink /proc/$pid/cwd)
echo "server $(v "$cwd") $cwd"
for p in $(pgrep -u "$(id -u)" -f 'server/managed\.ts'); do echo "launcher $(v "$(readlink /proc/$p/cwd)") $(readlink /proc/$p/cwd)"; done
echo "pty-host $([ -x "$cwd/bin/ovis-pty-sidecar" ] && echo present || echo absent)"
echo "revision $(git -C "$cwd" rev-parse --short=8 HEAD)"
echo "health-direct $(printf 'header = "authorization: Bearer %s"\n' "$(sed -n 's/^OVIS_TOKEN=//p' ~/.config/herdr/plugins/config/${PLUGIN_ID}/env)" | curl -s -m 3 --config - http://127.0.0.1:7317/api/health | python3 -c 'import json,sys; h=json.load(sys.stdin); print(json.dumps((h.get("relay") or {}).get("direct"), separators=(",", ":")))')"
echo "direct-file $(tr -d ' \n' < ~/.config/ovis/relay/direct.json 2>/dev/null || echo none)"
echo "listen $(ss -Hltnp | grep '"bun"' | awk '{print $4}' | sort | tr '\n' ' ')"
echo "herdr $(pgrep -u "$(id -u)" -x herdr | wc -l) $(readlink /proc/$(pgrep -u "$(id -u)" -xo herdr)/exe)"
for s in ovis-test ovis-test-settings-terminal-keys ovis-test-stk-a ovis-test-stk-b ovis-test-merge-pass-3142; do
  echo "session $s $(python3 -c 'import os,socket,stat,sys
p=sys.argv[1]
if not os.path.exists(p) or not stat.S_ISSOCK(os.stat(p).st_mode): print("no-socket"); sys.exit()
s=socket.socket(socket.AF_UNIX)
try: s.connect(p); print("live")
except OSError: print("stale")' ~/.config/herdr/sessions/$s/herdr.sock)"
done
echo "agents $(~/.local/bin/herdr pane list | python3 -c 'import json,sys; print(" ".join(sorted(p["agent"]+"/"+p["agent_status"] for p in json.load(sys.stdin)["result"]["panes"])))')"
echo "core $(~/.local/bin/herdr-core --version) $(pgrep -u "$(id -u)" -f 'herdr-core serve' | wc -l)"
echo "demo $(systemctl --user is-active ovis-demo-link)"
echo "autoupdate $(grep -c '^OVIS_AUTO_UPDATE=' ~/.config/herdr/plugins/config/${PLUGIN_ID}/env) $(for p in $(pgrep -u "$(id -u)" -f 'server/(managed|supervisor|index)\.ts'); do tr '\0' '\n' < /proc/$p/environ | grep -c '^OVIS_AUTO_UPDATE='; done | tr '\n' ' ')"
echo "core-terminals $(env -u HC_SOCKET -u HC_SESSION ~/.local/bin/herdr-core ls --json 2>/dev/null | python3 -c 'import json,sys; t=json.load(sys.stdin); t=t.get("terminals", t) if isinstance(t, dict) else t; print(len(t))')"
`;

/**
 * B5: the true-form-desktop preset in its three forms, each read from inside its machine. The TRUE form (the default): the machine's
 * 0.4.22 launcher with a 0.5.1 server its updater installed, direct on, the default session live and the five test
 * session folders dead with stale sockets. The 0.4.22-only variant and the six-live variant (with the demo's unit) are
 * the cases built to break the true form's checks.
 */
export async function presetProof(verdict: Verdict, scratchRoot: string, prefix: string, artifacts: string): Promise<void> {
  const forms: readonly [string, Preset][] = [["t", TRUE_FORM], ["o", { ...TRUE_FORM, version: "0.4.22" }], ["l", { ...TRUE_FORM, sessions: "live", demo: true }]];
  for (const [tag, preset] of forms) {
    const { spec, herdrBin } = presetMachine("od", preset, artifacts, USER);
    const name = describePreset(preset);
    await using world = await startWorld({ name: `${prefix}od${tag}`, scratchRoot, herdrBin, memory: "4g", machines: [spec] });
    const od = world.machine("od");
    const ran = await od.exec(["sh", "-c", OD_FACTS]);
    // `session <name> <state>` is keyed by its first two words, every other line by its first
    const facts = new Map(ran.out.trim().split("\n").map((line) => {
      const words = line.split(" ");
      const key = words[0] === "session" ? words.slice(0, 2).join(" ") : words[0]!;
      return [key, line.slice(key.length + 1)] as const;
    }));
    const fact = (key: string) => facts.get(key) ?? "";
    const sessions = [...facts.entries()].filter(([key]) => key.startsWith("session ")).map(([key, value]) => `${key.slice(8)} ${value}`);
    const label = preset === TRUE_FORM ? "the TRUE form" : preset.version === "0.4.22" ? "the 0.4.22-only variant" : "the six-live variant";
    verdict(`${PRESET_NAME}, ${label}: the preset prints which form it is`, "PASS", (od.description.preset !== undefined && describePreset(od.description.preset) === name) && (preset === TRUE_FORM) === name.includes("TRUE form"), name);
    verdict(`${PRESET_NAME}, ${label}: user ${USER}, hostname ${PRESET_NAME}, user manager degraded by ydotool`, "PASS", fact("who") === `${USER} ${PRESET_NAME} degraded`, fact("who"));
    const server051 = new RegExp(`^0\\.5\\.1 ${HOME}/\\.config/ovis/updates/[0-9a-f]{16}/release-[A-Za-z0-9]{6}$`).test(fact("server")) && /^0\.4\.22 .*\/119016-0\/checkout$/.test(fact("launcher"))
      && fact("revision").startsWith("c9901775") && fact("pty-host") === "present";
    verdict(`${PRESET_NAME}, ${label}: the machine's 0.4.22 launcher runs a 0.5.1 server (revision c9901775) that its updater installed, with the terminal host program`, preset.version === "0.5.1" ? "PASS" : "FAIL", server051,
      `launcher ${fact("launcher")}; server ${fact("server")}; revision ${fact("revision")}; pty host ${fact("pty-host")}`);
    if (preset.version === "0.4.22") verdict(`${PRESET_NAME}, ${label}: Ovis 0.4.22 all the way down (revision a4ff0c94)`, "PASS", fact("revision").startsWith("a4ff0c94") && fact("server").startsWith("0.4.22 ") && fact("launcher").startsWith("0.4.22 "), `${fact("server")}; ${fact("revision")}`);
    if (preset.version === "0.5.1") verdict(`${PRESET_NAME}, ${label}: direct connections on (relay/direct.json written by the server, health says on)`, "PASS", fact("direct-file") === '{"on":true}' && fact("health-direct").startsWith('{"on":true'), `relay/direct.json ${fact("direct-file")}; health ${fact("health-direct")}`);
    verdict(`${PRESET_NAME}, ${label}: the machine's Ovis listens on 127.0.0.1:7317`, "PASS", fact("listen").split(" ").includes("127.0.0.1:7317"), fact("listen"));
    const dead = fact("herdr") === `1 ${HOME}/.local/bin/herdr` && sessions.length === 5 && sessions.every((line) => line.endsWith(" stale"));
    verdict(`${PRESET_NAME}, ${label}: the default herdr session live (from ~/.local/bin), the five test session folders dead with stale sockets`, preset.sessions === "dead" ? "PASS" : "FAIL", dead, `herdr servers ${fact("herdr")}; ${sessions.join(", ")}`);
    // the states are herdr's reading now: the stand-in "working" claude reads blocked once a 0.5.1 server watches its screen
    verdict(`${PRESET_NAME}, ${label}: three agents in the default session (two claude, one codex)`, "PASS", fact("agents").replace(/\/[a-z]+/g, "") === "claude claude codex", fact("agents"));
    verdict(`${PRESET_NAME}, ${label}: herdr-core 0.1.17's default core beside`, "PASS", /^hc 0\.1\.17 [1-9]/.test(fact("core")), fact("core"));
    verdict(`${PRESET_NAME}, ${label}: the demo's unit ovis-demo-link is active`, preset.demo ? "PASS" : "FAIL", fact("demo") === "active", fact("demo"));
    if (preset.version === "0.5.1") {
      const [file = "", ...processes] = fact("autoupdate").trim().split(/\s+/);
      verdict(`${PRESET_NAME}, ${label}: OVIS_AUTO_UPDATE unset in the plugin's env file and in the machine's three Ovis processes (installed from Settings)`, "PASS", file === "0" && processes.length === 3 && processes.every((count) => count === "0"), `env file ${file}; processes ${processes.join(" ")}`);
    }
    verdict(`${PRESET_NAME}, ${label}: herdr-core's default core holds four plain shells`, "PASS", fact("core-terminals") === "4", fact("core-terminals"));
    if (ran.code !== 0) verdict(`${PRESET_NAME}, ${label}: its facts were read`, "PASS", false, ran.err.trim().slice(-300));
  }
}

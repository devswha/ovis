/**
 * Puts Ricardo's own Ovis on the latest main: the server on the VPS that
 * https://vps.tailb4e5ae.ts.net:8443 fronts (this fork only, see AGENTS.md "This fork"). There Ovis
 * runs on herdr-core from this checkout, started by `scripts/plugin.ts start` under the systemd user
 * unit `ovis.service` (INSTALL.md describes the unit and its `~/.config/ovis/env`; no herdr is needed).
 *
 * On any other machine it runs itself on the VPS over SSH (a login shell, which has mise's
 * shims): it pulls origin/main there, fast-forward only, and runs this script with the same
 * arguments, streaming its output and exiting with its exit code. So it deploys origin/main, not
 * this checkout: commits that are not pushed to origin/main (and uncommitted changes) are not
 * deployed, and it warns when HEAD is not on origin/main. On the VPS itself it does not pull, but
 * stops, as the run from another machine does, before changing anything when the checkout is on
 * another branch, such as a PR under test there: that build would be replaced, and a pull could not
 * fast-forward it (scripts/deploy-helpers.ts, onMainSteps). Once on main it:
 *
 * 1. builds the client (`bun run build`);
 * 2. restarts `ovis.service` (`systemctl --user restart`), since a build under a running server only
 *    gets it the "Restart it there" banner;
 * 3. waits until the server runs HEAD, then checks from omarchy that the tailnet address serves the
 *    new bundle;
 * 4. updates the Ovis of every PC this server reaches over SSH (`~/.local/share/ovis/app`, install.sh's checkout)
 *    to the same commit and restarts it, since this Ovis refuses a PC whose Ovis is older, and those PCs only
 *    update themselves to a release tag;
 *    Each PC's source bundle identity (server/bundle-version.ts, what this server compares) is computed
 *    after its build and must equal this checkout's, or that PC is reported as not updated: the same
 *    commit can differ by files on disk, so a matching commit alone proves nothing;
 * 5. restarts the Ovis app on the Xiaomi over adb, since the Android app ignores a reload.
 *
 * It also sets OVIS_AUTO_UPDATE=1 in `~/.config/ovis/env`, which every start of the unit reads (this
 * one, and the one at login after a reboot): from then on the VPS's updater installs by itself every newer plain
 * `vX.Y.Z` tag its origin gets, such as the fork's calendar tags (`v2026.1101.1`, pushed by the
 * orchestrator's weekly job), and this script is only for putting a change there before it is tagged.
 *
 * Exits non-zero at the first step that fails, saying which; only a clean exit means deployed.
 * `bun scripts/deploy-vps.ts [--no-build]`. Overrides: OVIS_DEPLOY_URL, OVIS_DEPLOY_CHECK_HOST,
 * OVIS_DEPLOY_ADB_SERIAL, OVIS_DEPLOY_SSH (where to run it from another machine). Every OVIS_DEPLOY_*
 * set here goes along to the run on the VPS, except OVIS_DEPLOY_SSH.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { sourceBundleVersion } from "../server/bundle-version.ts";
import { onMainSteps, pullMainSteps, settingOf, withSetting } from "./deploy-helpers.ts";

const repo = join(import.meta.dir, "..");
const publicUrl = process.env.OVIS_DEPLOY_URL ?? "https://vps.tailb4e5ae.ts.net:8443/";
const checkHost = process.env.OVIS_DEPLOY_CHECK_HOST ?? "omarchy";
const adbSerial = process.env.OVIS_DEPLOY_ADB_SERIAL ?? "100.101.250.35:5555";
const androidApp = "sh.ovis.app";
const vpsHostname = "vps";
const vpsSsh = process.env.OVIS_DEPLOY_SSH ?? `ricardo@${vpsHostname}`;
const vpsRepo = "/home/ricardo/Projects/forks/ovis";
const service = "ovis.service";
/** the HERDR_PLUGIN_CONFIG_DIR the unit hands scripts/plugin.ts (install.sh core_dirs), whose `env` a start reads */
const settingsFile = join(homedir(), ".config", "ovis", "env");

function fail(message: string): never {
  console.error(`deploy-vps: ${message}`);
  process.exit(1);
}

function run(cmd: string[], options: { quiet?: boolean } = {}): { ok: boolean; code: number; out: string } {
  const result = Bun.spawnSync(cmd, { cwd: repo, stdout: options.quiet === false ? "inherit" : "pipe", stderr: options.quiet === false ? "inherit" : "pipe" });
  return { ok: result.exitCode === 0, code: result.exitCode ?? 1, out: `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`.trim() };
}

async function waitFor(what: string, ms: number, done: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await done()) return;
    await Bun.sleep(250);
  }
  fail(`timed out after ${ms / 1000}s waiting for ${what}`);
}

const bundleOf = (html: string) => html.match(/assets\/index-[^"]+\.js/)?.[0] ?? null;

const shellQuote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;

if (hostname() !== vpsHostname) {
  run(["git", "fetch", "--quiet", "origin", "main"]);
  if (!run(["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"]).ok) {
    console.warn("deploy-vps: warning: HEAD is not on origin/main, and only origin/main is deployed; push or merge it first if it should go out");
  }
  console.log(`deploy-vps: deploying origin/main through ${vpsSsh}, not this checkout`);
  const overrides = Object.entries(process.env).filter(([name]) => name.startsWith("OVIS_DEPLOY_") && name !== "OVIS_DEPLOY_SSH").map(([name, value]) => `${name}=${shellQuote(value ?? "")} `).join("");
  const steps = [...pullMainSteps(vpsRepo), ". scripts/bun-path.sh", `${overrides}bun scripts/deploy-vps.ts ${process.argv.slice(2).map(shellQuote).join(" ")}`];
  const remote = run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", vpsSsh, `bash -lc ${shellQuote(steps.join(" && "))}`], { quiet: false });
  process.exit(remote.code);
}

if (!run(["sh", "-c", onMainSteps(repo).join(" && ")], { quiet: false }).ok) process.exit(1);

const head = run(["git", "rev-parse", "HEAD"]).out;

if (!process.argv.includes("--no-build")) {
  console.log("deploy-vps: building the client");
  if (!run(["bun", "run", "build"], { quiet: false }).ok) fail("the build failed");
}

// What every PC must compute too, or this server refuses it: the identity of the files this checkout runs.
const identity = sourceBundleVersion(repo);
console.log(`deploy-vps: this checkout's bundle identity is ${identity}`);

if (!run(["systemctl", "--user", "cat", service]).ok) fail(`no ${service} user service here: install it first (INSTALL.md, the herdr-core setup, with this checkout as the app)`);
const before = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : "";
const after = withSetting(before, "OVIS_AUTO_UPDATE", "1");
if (after !== before) { writeFileSync(settingsFile, after, { mode: 0o600 }); console.log(`deploy-vps: set OVIS_AUTO_UPDATE=1 in ${settingsFile}`); }
// the port the unit starts the server on is the settings file's, not this shell's
const port = settingOf(after, "PORT") ?? "7317";

console.log(`deploy-vps: restarting ${service} (port ${port})`);
if (!run(["systemctl", "--user", "restart", service], { quiet: false }).ok) fail(`could not restart ${service}`);

const local = `http://127.0.0.1:${port}/`;
await waitFor(`the server to run ${head.slice(0, 8)}`, 90_000, async () => {
  try {
    const status = await (await fetch(`${local}api/updates`)).json() as { current_revision?: string; served_revision?: string | null };
    return status.current_revision === head && !status.served_revision;
  } catch { return false; }
});
const bundle = bundleOf(await (await fetch(local)).text());
if (!bundle) fail("the server answers without a client bundle");

const remote = run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", checkHost, `curl -s --max-time 20 ${publicUrl}`]);
if (!remote.ok) fail(`could not reach ${publicUrl} from ${checkHost}: ${remote.out.slice(0, 200)}`);
if (bundleOf(remote.out) !== bundle) fail(`${checkHost} gets ${bundleOf(remote.out) ?? "no bundle"} from ${publicUrl}, not ${bundle}`);
console.log(`deploy-vps: ${checkHost} gets ${bundle} at ${publicUrl}`);

// The PCs whose own Ovis this server bridges to: each must run this commit too, or this server refuses it.
const machines = await (await fetch(`${local}api/machines`)).json() as { machines?: { name: string; kind: string; target?: { destination?: string; own_ovis?: string } }[] };
const pcs = (machines.machines ?? []).filter((machine) => machine.kind === "ssh" && machine.target?.own_ovis && machine.target.destination);
const stale: string[] = [];
for (const pc of pcs) {
  console.log(`deploy-vps: updating ${pc.name}'s Ovis to ${head.slice(0, 8)}`);
  const steps = [
    ...pullMainSteps("$HOME/.local/share/ovis/app"),
    `test "$(git rev-parse HEAD)" = ${head} || { echo "deploy-vps: origin/main there is not ${head.slice(0, 8)}" >&2; exit 1; }`,
    ". scripts/bun-path.sh",
    "bun install --frozen-lockfile",
    "bun run build",
    // same function the servers compare; fail before restarting a PC this server would refuse anyway
    `id=$(bun -e 'import { sourceBundleVersion } from "./server/bundle-version.ts"; console.log(sourceBundleVersion(process.cwd()))') && { test "$id" = ${identity} || { echo "deploy-vps: its bundle identity is $id, not ${identity}" >&2; exit 1; }; }`,
    "if systemctl --user cat ovis.service >/dev/null 2>&1; then systemctl --user restart ovis.service; elif launchctl print gui/$(id -u)/sh.ovis.server >/dev/null 2>&1; then HERDR_PLUGIN_STATE_DIR=$HOME/.local/state/ovis HERDR_PLUGIN_CONFIG_DIR=$HOME/.config/ovis bun scripts/plugin.ts stop && launchctl kickstart -k gui/$(id -u)/sh.ovis.server; else echo 'deploy-vps: no ovis.service or sh.ovis.server there' >&2; exit 1; fi",
    `port=$(sed -n 's/^PORT=//p' "$HOME/.config/ovis/env" 2>/dev/null | tail -1); for i in $(seq 90); do curl -s -m 2 "http://127.0.0.1:\${port:-7317}/api/updates" | grep -q '"current_revision":"${head}"' && exit 0; sleep 1; done; echo 'deploy-vps: its server does not run the new commit after 90s' >&2; exit 1`,
  ];
  const done = run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", pc.target!.destination!, `bash -lc ${shellQuote(steps.join(" && "))}`]);
  if (done.ok) console.log(`deploy-vps: ${pc.name} runs ${head.slice(0, 8)}`);
  else { stale.push(pc.name); console.error(`deploy-vps: ${pc.name} was not updated: ${done.out.slice(-400)}`); }
}

const adbOnPath = run(["sh", "-c", "command -v adb"]).out;
const adb = adbOnPath || join(homedir(), "Android/Sdk/platform-tools/adb");
if (!existsSync(adb)) fail("no adb here: restart the Ovis app on the Xiaomi by hand (swipe it away, reopen it)");
if (run([adb, "-s", adbSerial, "get-state"]).out !== "device") run([adb, "connect", adbSerial]);
if (run([adb, "-s", adbSerial, "get-state"]).out !== "device") {
  fail(`the Xiaomi (${adbSerial}) is offline: the server is deployed, but ask Ricardo to swipe the Ovis app away and reopen it`);
}
run([adb, "-s", adbSerial, "shell", "am", "force-stop", androidApp]);
run([adb, "-s", adbSerial, "shell", "monkey", "-p", androidApp, "-c", "android.intent.category.LAUNCHER", "1"]);
await waitFor("the Ovis app to start on the Xiaomi", 15_000, () => run([adb, "-s", adbSerial, "shell", "pidof", androidApp]).ok);
if (stale.length) fail(`deployed ${head.slice(0, 8)} on the VPS and the Xiaomi, but not on ${stale.join(", ")}, which this server refuses until they run it too`);
console.log(`deploy-vps: deployed ${head.slice(0, 8)}; the Xiaomi app and ${pcs.length} PC(s) restarted. Desktop windows only need a reload.`);

/**
 * install.sh on a PC with systemd, run as a person or a coding agent runs it there over SSH. Requires Docker and network;
 * nothing on the host changes. An Ubuntu 24.04 container with systemd as PID 1, logind and polkit, as on a server, and an
 * account `alice` with no herdr, Bun or Node, logged in with `su -l` (a logind session, as SSH gives one). This checkout's
 * install.sh is piped into sh as `curl … | sh` would; it installs herdr and the latest release. Checked:
 *   1. a fresh PC: herdr installed and started from ovis-herdr.service, lingering turned on, Ovis answering;
 *   2. the session ends (a logout): herdr and Ovis run on;
 *   3. the line again: nothing changes (the unit, herdr's and Ovis's processes);
 *   4. a reboot: Ovis answers again, with nobody logged in;
 *   5. herdr stopped (installed, not running): the line starts it again;
 *   6. the guide's Uninstall: herdr runs on, nothing starts it at the next boot, and lingering is off again;
 *   7. the line after it (herdr installed, not running, no service yet): Ovis runs and starts at boot again;
 *   8. --add --account on a release whose add does not take --account: nothing is added, and the exit is non-zero.
 *
 *   bun scripts/install-service-docker.ts      KEEP=1 leaves the container behind
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const IMAGE = "ovis-install-systemd:local";
const DOCKERFILE = `FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session libpam-systemd polkitd curl ca-certificates git tar unzip xz-utils procps \\
  && rm -rf /var/lib/apt/lists/* && useradd -m -s /bin/bash alice \\
  && systemctl mask systemd-networkd.service systemd-resolved.service systemd-timesyncd.service getty@tty1.service console-getty.service
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/sbin/init"]
`;
const ROOT = join(import.meta.dir, "..");
const name = `ovis-install-sd-${process.pid}`;
const UNIT = "/home/alice/.config/systemd/user/ovis-herdr.service";
const HEALTH = "curl -sf --max-time 3 http://127.0.0.1:7317/api/health >/dev/null";

async function docker(args: string[], input?: string): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(["docker", ...args], { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: stdout + stderr };
}
const root = (script: string) => docker(["exec", "-i", name, "sh", "-c", script]);
/** as alice, in a login session of her own that ends with the command (logind's, as SSH gives one) */
const alice = (script: string) => docker(["exec", "-i", name, "su", "-l", "alice", "-c", script]);
const install = () => alice(`cat /opt/install.sh | sh 2>&1; echo "exit=$?"`);
const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  const result = await run();
  console.log(`${label}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return result;
};
async function until(what: string, script: string, seconds: number): Promise<void> {
  const waited = await root(`for i in $(seq 1 ${seconds}); do if ${script}; then exit 0; fi; sleep 1; done; exit 1`);
  assert.equal(waited.code, 0, `${what}: not within ${seconds} s`);
}
async function booted(): Promise<void> {
  const up = await root("timeout 60 sh -c 'while [ ! -S /run/systemd/private ]; do sleep 0.1; done' && s=$(timeout 120 systemctl is-system-running --wait); case $s in running | degraded) exit 0 ;; esac; echo $s; exit 1");
  assert.equal(up.code, 0, `systemd did not boot: ${up.out}`);
}
/** herdr's and Ovis's processes, by pid */
async function processes(): Promise<{ herdr: string[]; ovis: string[] }> {
  const lines = (await root("ps -u alice -o pid=,args=")).out.split("\n").map((line) => line.trim()).filter(Boolean);
  const pids = (match: RegExp) => lines.filter((line) => match.test(line)).map((line) => line.split(/\s+/)[0]!).sort();
  return { herdr: pids(/herdr server$/), ovis: pids(/ovis-server/) };
}
const lingers = async () => (await root("test -e /var/lib/systemd/linger/alice")).code === 0;

if ((await docker(["image", "inspect", IMAGE])).code !== 0) {
  await step(`image ${IMAGE}`, async () => {
    const built = await docker(["build", "-q", "-t", IMAGE, "-"], DOCKERFILE);
    assert.equal(built.code, 0, built.out);
  });
}
console.log(`install.sh in a systemd container (${name}): Ubuntu 24.04, logind and polkit, no herdr, Bun or Node`);
try {
  // systemd as PID 1 makes cgroups for the user manager and its units: under docker that takes --privileged, the
  // host's cgroup namespace and /sys/fs/cgroup mounted writable; systemd keeps to the cgroup docker gives the container
  const started = await docker(["run", "-d", "--name", name, "--label", "ovis-install-qa", "--cpuset-cpus", process.env["OVIS_HEAVY_CPUS"] ?? "112-127",
    "--privileged", "--cgroupns=host", "--tmpfs", "/run", "--tmpfs", "/run/lock", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw", IMAGE]);
  assert.equal(started.code, 0, started.out);
  await booted();
  assert.equal((await docker(["cp", join(ROOT, "install.sh"), `${name}:/opt/install.sh`])).code, 0);
  assert.equal((await root("chmod 644 /opt/install.sh")).code, 0);
  assert.equal(await lingers(), false);

  const fresh = await step("1. the line on a fresh PC: herdr, Ovis, the service, lingering", install);
  assert.match(fresh.out, /exit=0/, fresh.out.slice(-3000));
  assert.match(fresh.out, /installing herdr/, fresh.out.slice(-3000));
  assert.match(fresh.out, /Ovis: Ovis runs now at http:\/\/127\.0\.0\.1:7317, in herdr, which the user service ovis-herdr starts again whenever this PC starts, with nobody logged in \(systemctl --user status ovis-herdr\)/, fresh.out.slice(-3000));
  assert.match(fresh.out, /Ovis: lingering is on for alice now/, fresh.out.slice(-3000));
  assert.doesNotMatch(fresh.out, /not running yet|did not start/, fresh.out.slice(-3000));
  assert.equal(await lingers(), true);
  const unit = (await root(`cat ${UNIT}`)).out;
  assert.match(unit, /^KillMode=process$/m);
  assert.doesNotMatch(unit, /ExecStop/);
  const status = await alice("~/.local/bin/ovis status");
  assert.match(status.out, /^running http:\/\/127\.0\.0\.1:7317/m, status.out);

  await step("2. the session ended: herdr and Ovis run on", async () => {
    // logind's word for a user with no session whose manager lingering keeps: without it the manager, and herdr in it,
    // would stop UserStopDelaySec after the last session
    await until("alice has no session left", "[ \"$(loginctl show-user alice -p State --value)\" = lingering ]", 60);
    assert.equal((await root("systemctl is-active user@$(id -u alice).service")).out.trim(), "active");
    assert.equal((await root(HEALTH)).code, 0, "Ovis stopped with the session");
  });
  const before = await processes();
  assert.equal(before.herdr.length, 1, JSON.stringify(before));
  assert.ok(before.ovis.length > 0, JSON.stringify(before));
  // in the home folder, as from a login, not in systemd's /
  assert.equal((await root(`readlink /proc/${before.herdr[0]}/cwd`)).out.trim(), "/home/alice");

  await step("3. the line again: nothing changes", async () => {
    const unitBefore = (await root(`sha256sum ${UNIT}`)).out;
    const again = await install();
    assert.match(again.out, /exit=0/, again.out.slice(-3000));
    assert.match(again.out, /nothing to do|already installed/, again.out.slice(-3000));
    assert.match(again.out, /Ovis: Ovis runs now at http:\/\/127\.0\.0\.1:7317, and starts whenever herdr does/, again.out.slice(-3000));
    assert.equal((await root(`sha256sum ${UNIT}`)).out, unitBefore);
    assert.deepEqual(await processes(), before);
  });

  await step("4. a reboot: Ovis comes back with nobody logged in", async () => {
    assert.equal((await docker(["restart", "-t", "30", name])).code, 0);
    await booted();
    await until("Ovis answers after the reboot", HEALTH, 120);
    assert.equal((await processes()).herdr.length, 1);
  });

  await step("5. herdr stopped (installed, not running): the line starts it again", async () => {
    assert.equal((await alice("herdr server stop")).code, 0);
    await until("herdr stopped", "! su -l alice -c 'herdr status server --json' | grep -q '\"running\":true'", 30);
    const stopped = await processes();
    const again = await install();
    assert.match(again.out, /exit=0/, again.out.slice(-3000));
    assert.match(again.out, /in herdr, which the user service ovis-herdr starts again whenever this PC starts/, again.out.slice(-3000));
    await until("Ovis answers", HEALTH, 60);
    const now = await processes();
    assert.equal(now.herdr.length, 1);
    assert.notDeepEqual(now.herdr, stopped.herdr);
  });

  await step("6. the guide's Uninstall: herdr runs on, nothing starts it at the next boot, lingering off", async () => {
    const guide = readFileSync(join(ROOT, "docs", "guide.md"), "utf8");
    const block = guide.slice(guide.indexOf("### Uninstall"), guide.indexOf("## How Ovis fits with herdr"));
    const lines = block.slice(block.indexOf("```bash") + 7, block.indexOf("```", block.indexOf("```bash") + 7)).split("\n")
      .filter((line) => line.trim() && !line.trimStart().startsWith("#") && !line.includes("tailscale"));
    // in one session: run past it without lingering, logind would end herdr with the session, as before the install
    const removed = await alice(`${lines.join("\n")}\necho "exit=$?"; herdr status server --json`);
    assert.match(removed.out, /"running":true/, `the Uninstall stopped herdr:\n${removed.out}`);
    assert.equal(await lingers(), false);
    assert.equal((await root(`test -e ${UNIT}`)).code, 1);
    assert.notEqual((await root(HEALTH)).code, 0, "Ovis still answers");
    assert.equal((await docker(["restart", "-t", "30", name])).code, 0);
    await booted();
    // booted, with no lingering and nobody logged in: alice has no service manager, so nothing of hers starts
    assert.notEqual((await root("systemctl is-active user@$(id -u alice).service")).out.trim(), "active");
    assert.deepEqual(await processes(), { herdr: [], ovis: [] });
  });

  const back = await step("7. the line after the Uninstall (herdr installed, not running, no service): all of it again", install);
  assert.match(back.out, /exit=0/, back.out.slice(-3000));
  assert.doesNotMatch(back.out, /installing herdr/, back.out.slice(-3000));
  assert.match(back.out, /in herdr, which the user service ovis-herdr starts again whenever this PC starts/, back.out.slice(-3000));
  assert.equal(await lingers(), true);
  await until("Ovis answers", HEALTH, 60);

  await step("8. --add --account with no terminal, on a release whose add does not take --account: no add, a non-zero exit", async () => {
    const added = await alice(`cat /opt/install.sh | sh -s -- --add --account acct_000000000000 2>&1; echo "exit=$?"`);
    const release = /installed Ovis (\d+\.\d+\.\d+)|Ovis (\d+\.\d+\.\d+)/.exec(fresh.out);
    const version = (release?.[1] ?? release?.[2] ?? "0.0.0").split(".").map(Number);
    if (version[0]! > 0 || version[1]! > 5 || (version[1] === 5 && version[2]! >= 10)) {
      console.log(`  skipped: the release installed (${version.join(".")}) takes --account, and its add needs the account service`);
      return;
    }
    assert.match(added.out, /exit=1/, added.out.slice(-2000));
    assert.match(added.out, /this Ovis release does not check the account --account names, so the installer does not add this PC with it/, added.out.slice(-2000));
    // the add never started: it would have turned the relay on and shown the account sign-in page
    assert.doesNotMatch(added.out, /Turning on the Ovis relay|account\.ovis\.sh/, added.out.slice(-2000));
  });
  console.log(`\nA PC with systemd goes from one line to Ovis running, and stays so through a logout, a rerun and a reboot. install.sh said on the fresh PC:\n${
    fresh.out.split("\n").filter((line) => /^Ovis: /.test(line)).map((line) => `  ${line}`).join("\n")}`);
} finally {
  if (process.env["KEEP"] === "1") console.log(`container kept: docker exec -it ${name} su -l alice`);
  else await docker(["rm", "-f", name]);
}

/**
 * install.sh on a PC with systemd, run as a person or a coding agent runs it there over SSH. Requires Docker and network;
 * nothing on the host changes. Ubuntu 24.04 containers with systemd as PID 1, logind and polkit, as on a server, and an
 * account `alice` with no herdr, Bun or Node, logged in with `su -l` (a logind session, as SSH gives one). This checkout's
 * install.sh is piped into sh as `curl … | sh` would; it installs herdr and the latest release. Checked, on a server whose
 * polkit lets alice turn lingering on:
 *   1. a fresh PC: herdr installed and started from ovis-herdr.service, lingering turned on, Ovis answering;
 *   2. the session ends (a logout): herdr and Ovis run on;
 *   3. the line again: nothing changes (the unit, herdr's and Ovis's processes);
 *   4. a reboot: Ovis answers again, with nobody logged in;
 *   5. herdr stopped (installed, not running): the line starts it again;
 *   6. the guide's Uninstall: herdr runs on, nothing starts it at the next boot, and lingering is off again;
 *   7. the line after it (herdr installed, not running, no service yet): Ovis runs and starts at boot again;
 *   8. --add --account on a release whose add does not take --account: nothing is added, and the exit is non-zero;
 * on a server whose polkit refuses lingering:
 *   9. no unit; herdr started once, in the session's scope and not alice's service manager, outlives the logout, and
 *      nothing starts after a reboot;
 * and on one where alice may turn lingering on:
 *   10. in a desktop's session (XDG_SESSION_TYPE=wayland), and 11. with --no-service: no unit, lingering untouched.
 *
 *   bun scripts/install-service-docker.ts      KEEP=1 leaves the containers behind
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
/** an administrator's rule that leaves lingering to root, as on a PC whose polkit does not let a user turn it on */
const NO_LINGER = `polkit.addRule(function(action, subject) { if (action.id == "org.freedesktop.login1.set-self-linger") return polkit.Result.NO; });`;
const ROOT = join(import.meta.dir, "..");
const UNIT = "/home/alice/.config/systemd/user/ovis-herdr.service";
const HEALTH = "curl -sf --max-time 3 http://127.0.0.1:7317/api/health >/dev/null";

async function docker(args: string[], input?: string): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(["docker", ...args], { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: stdout + stderr };
}
const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  const result = await run();
  console.log(`${label}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return result;
};

/** a container of the image, booted, with this checkout's install.sh in /opt (a reboot empties /tmp) */
async function pc(label: string) {
  const name = `ovis-install-sd-${label}-${process.pid}`;
  const root = (script: string) => docker(["exec", "-i", name, "sh", "-c", script]);
  /** as alice, in a login session of her own that ends with the command (logind's, as SSH gives one) */
  const alice = (script: string) => docker(["exec", "-i", name, "su", "-l", "alice", "-c", script]);
  const install = (args = "", env = "") => alice(`${env}cat /opt/install.sh | sh -s -- ${args} 2>&1; echo "exit=$?"`);
  const until = async (what: string, script: string, seconds: number) => {
    const waited = await root(`for i in $(seq 1 ${seconds}); do if ${script}; then exit 0; fi; sleep 1; done; exit 1`);
    assert.equal(waited.code, 0, `${what}: not within ${seconds} s`);
  };
  const booted = async () => {
    const up = await root("timeout 60 sh -c 'while [ ! -S /run/systemd/private ]; do sleep 0.1; done' && s=$(timeout 120 systemctl is-system-running --wait); case $s in running | degraded) exit 0 ;; esac; echo $s; exit 1");
    assert.equal(up.code, 0, `systemd did not boot: ${up.out}`);
  };
  const reboot = async () => {
    assert.equal((await docker(["restart", "-t", "30", name])).code, 0);
    await booted();
  };
  /** herdr's and Ovis's processes, by pid */
  const processes = async () => {
    const lines = (await root("ps -u alice -o pid=,args=")).out.split("\n").map((line) => line.trim()).filter(Boolean);
    const pids = (match: RegExp) => lines.filter((line) => match.test(line)).map((line) => line.split(/\s+/)[0]!).sort();
    return { herdr: pids(/herdr server$/), ovis: pids(/ovis-server/) };
  };
  const lingers = async () => (await root("test -e /var/lib/systemd/linger/alice")).code === 0;
  /** alice logged out: no session of hers is open, and what she left running stays in a closing one (KillUserProcesses=no) */
  const loggedOut = () => until("alice's last session closed", "[ \"$(loginctl show-user alice -p State --value)\" = closing ]", 60);
  const remove = () => process.env["KEEP"] === "1" ? (console.log(`container kept: docker exec -it ${name} su -l alice`), Promise.resolve()) : docker(["rm", "-f", name]).then(() => {});
  // systemd as PID 1 makes cgroups for the user manager and its units: under docker that takes --privileged, the
  // host's cgroup namespace and /sys/fs/cgroup mounted writable; systemd keeps to the cgroup docker gives the container
  const started = await docker(["run", "-d", "--name", name, "--label", "ovis-install-qa", "--cpuset-cpus", process.env["OVIS_HEAVY_CPUS"] ?? "112-127",
    "--privileged", "--cgroupns=host", "--tmpfs", "/run", "--tmpfs", "/run/lock", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw", IMAGE]);
  assert.equal(started.code, 0, started.out);
  try {
    await booted();
    assert.equal((await docker(["cp", join(ROOT, "install.sh"), `${name}:/opt/install.sh`])).code, 0);
    assert.equal((await root("chmod 644 /opt/install.sh")).code, 0);
    assert.equal(await lingers(), false);
  } catch (error) {
    await remove();
    throw error;
  }
  return { name, root, alice, install, until, reboot, processes, lingers, loggedOut, remove };
}

if ((await docker(["image", "inspect", IMAGE])).code !== 0) {
  await step(`image ${IMAGE}`, async () => {
    const built = await docker(["build", "-q", "-t", IMAGE, "-"], DOCKERFILE);
    assert.equal(built.code, 0, built.out);
  });
}
console.log("install.sh in systemd containers: Ubuntu 24.04, logind and polkit, no herdr, Bun or Node");

const server = await pc("server");
let said = "";
try {
  const { root, alice, install, until, reboot, processes, lingers } = server;
  const fresh = await step("1. the line on a fresh PC: herdr, Ovis, the service, lingering", () => install());
  said = fresh.out;
  assert.match(fresh.out, /exit=0/, fresh.out.slice(-3000));
  assert.match(fresh.out, /installing herdr/, fresh.out.slice(-3000));
  assert.match(fresh.out, /Ovis: Ovis runs now at http:\/\/127\.0\.0\.1:7317, in herdr, which the user service ovis-herdr starts whenever this PC starts, with nobody logged in\n/, fresh.out.slice(-3000));
  assert.match(fresh.out, /Ovis: lingering is on for alice now/, fresh.out.slice(-3000));
  assert.doesNotMatch(fresh.out, /not running yet|did not start/, fresh.out.slice(-3000));
  assert.equal(await lingers(), true);
  const unit = (await root(`cat ${UNIT}`)).out;
  assert.match(unit, /^KillMode=process$/m);
  assert.match(unit, /^Environment="LC_CTYPE=C\.UTF-8"$/m);
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
  const herdrPid = before.herdr[0]!;
  // in the home folder, as from a login, not in systemd's /; a UTF-8 locale; the user's PATH first
  assert.equal((await root(`readlink /proc/${herdrPid}/cwd`)).out.trim(), "/home/alice");
  const environment = (await root(`tr '\\0' '\\n' </proc/${herdrPid}/environ`)).out;
  assert.match(environment, /^LC_CTYPE=C\.UTF-8$/m);
  assert.match(environment, /^PATH=\/usr\/local\/sbin:.*:\/home\/alice\/\.local\/bin:\/home\/alice\/\.bun\/bin$/m, environment);

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
    await reboot();
    await until("Ovis answers after the reboot", HEALTH, 120);
    assert.equal((await processes()).herdr.length, 1);
  });

  await step("5. herdr stopped (installed, not running): the line starts it again", async () => {
    assert.equal((await alice("herdr server stop")).code, 0);
    await until("herdr stopped", "! su -l alice -c 'herdr status server --json' | grep -q '\"running\":true'", 30);
    const stopped = await processes();
    const again = await install();
    assert.match(again.out, /exit=0/, again.out.slice(-3000));
    assert.match(again.out, /in herdr, which the user service ovis-herdr starts whenever this PC starts/, again.out.slice(-3000));
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
    // in one session: past its end, with lingering off, logind ends the manager and the herdr the service started in it
    const removed = await alice(`${lines.join("\n")}\necho "exit=$?"; herdr status server --json`);
    assert.match(removed.out, /"running":true/, `the Uninstall stopped herdr:\n${removed.out}`);
    assert.equal(await lingers(), false);
    assert.equal((await root(`test -e ${UNIT}`)).code, 1);
    assert.notEqual((await root(HEALTH)).code, 0, "Ovis still answers");
    await reboot();
    // booted, with no lingering and nobody logged in: alice has no service manager, so nothing of hers starts
    assert.notEqual((await root("systemctl is-active user@$(id -u alice).service")).out.trim(), "active");
    assert.deepEqual(await processes(), { herdr: [], ovis: [] });
  });

  const back = await step("7. the line after the Uninstall (herdr installed, not running, no service): all of it again", () => install());
  assert.match(back.out, /exit=0/, back.out.slice(-3000));
  assert.doesNotMatch(back.out, /installing herdr/, back.out.slice(-3000));
  assert.match(back.out, /in herdr, which the user service ovis-herdr starts whenever this PC starts/, back.out.slice(-3000));
  assert.equal(await lingers(), true);
  await until("Ovis answers", HEALTH, 60);

  await step("8. --add --account with no terminal, on a release whose add does not take --account: no add, a non-zero exit", async () => {
    const added = await install("--add --account acct_000000000000");
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
} finally {
  await server.remove();
}

const strict = await pc("no-linger");
try {
  const { root, install, until, reboot, processes, lingers, loggedOut } = strict;
  assert.equal((await root(`mkdir -p /etc/polkit-1/rules.d && printf '%s\\n' '${NO_LINGER}' >/etc/polkit-1/rules.d/00-no-self-linger.rules && systemctl restart polkit`)).code, 0);
  await step("9. lingering refused: no unit, and herdr started once outlives the logout", async () => {
    const fresh = await install();
    assert.match(fresh.out, /exit=0/, fresh.out.slice(-3000));
    assert.match(fresh.out, /in herdr, which was started in the background and keeps running after you log out\. Nothing starts it after a restart: lingering is off for alice, and turning it on needs an administrator \(sudo loginctl enable-linger alice\)/, fresh.out.slice(-3000));
    assert.equal(await lingers(), false);
    assert.equal((await root(`test -e ${UNIT}`)).code, 1);
    // herdr runs in the scope of the session it was started from, not in alice's service manager, which logind stops
    // once no session is left: a herdr in the manager would have ended with it (the finding this case is for)
    const running = await processes();
    assert.equal(running.herdr.length, 1);
    assert.match((await root(`cat /proc/${running.herdr[0]}/cgroup`)).out, /\/user-\d+\.slice\/session-[^/]+\.scope$/m);
    await loggedOut();
    assert.deepEqual((await processes()).herdr, running.herdr);
    await until("Ovis answers after the logout", HEALTH, 10);
    await reboot();
    assert.deepEqual(await processes(), { herdr: [], ovis: [] });
  });
} finally {
  await strict.remove();
}

const desk = await pc("desktop");
try {
  const { root, alice, install, until, lingers } = desk;
  await step("10. in a desktop's session: no unit, lingering untouched, herdr started once", async () => {
    const run = await install("", "export XDG_SESSION_TYPE=wayland; ");
    assert.match(run.out, /exit=0/, run.out.slice(-3000));
    assert.match(run.out, /in herdr, which was started for now: this is a desktop's session, so after a restart herdr starts when you open it, as before/, run.out.slice(-3000));
    assert.equal(await lingers(), false);
    assert.equal((await root(`test -e ${UNIT}`)).code, 1);
    await until("Ovis answers", HEALTH, 10);
  });
  await step("11. with --no-service: no unit, lingering untouched, herdr started once", async () => {
    assert.equal((await alice("herdr server stop")).code, 0);
    await until("herdr stopped", "! su -l alice -c 'herdr status server --json' | grep -q '\"running\":true'", 30);
    const run = await install("--no-service");
    assert.match(run.out, /exit=0/, run.out.slice(-3000));
    assert.match(run.out, /in herdr, which was started for now, with no service \(--no-service\)/, run.out.slice(-3000));
    assert.equal(await lingers(), false);
    assert.equal((await root(`test -e ${UNIT}`)).code, 1);
    await until("Ovis answers", HEALTH, 30);
  });
} finally {
  await desk.remove();
}

console.log(`\nOne line leaves Ovis running: on a server through a logout, a rerun and a reboot; where lingering is refused through a logout; in a desktop's session and with --no-service with nothing set up. install.sh said on the fresh server:\n${
  said.split("\n").filter((line) => /^Ovis: /.test(line)).map((line) => `  ${line}`).join("\n")}`);

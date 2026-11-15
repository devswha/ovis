/**
 * The world tool's proof (R12): every claim is checked twice, once where it must hold (expected PASS) and once on a
 * case built to break it (expected FAIL), so the check is shown able to tell. Needs docker: never part of `check fast`.
 *   bun scripts/world/proof.ts [--only signin,member,devices,realaccount,machine,preset,services,teardown,killpoints,startpoints,inflight,gcmarker,ttl,slot,slot60,sealed,two,clash,engines,addmachine] > proof.txt
 *   [--repeat N: every chosen part N times]   (OVIS_WORLD_EVIDENCE: where screenshots and recordings go)
 * Runs only inside a heavy slot, as every world does: ~/.ovis-toolchain/heavy-run.sh -- bun scripts/world/proof.ts
 * `services` starts M2's services on test ports, pinned to 0-55 like the real ones (never in the slot), for seconds.
 * `slot60` and one case of `addmachine` take slots of their own from heavy-run.sh (the real -t 60, another band): they
 * wait for a free slot, up to 15 minutes.
 * Exit 0 only when every check gave its expected verdict.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { alive, containers, docker, dockerInFlight, hostCpus, networks, processIdentity, readPins, run, unpinned } from "./docker.ts";
import { addresses, planFromArgs, cpuList, cpuSet } from "./plan.ts";
import { CONTROL_HEADER } from "./services.ts";
import { gc, leftovers } from "./teardown.ts";
import { devicesProof } from "./proof-devices.ts";
import { memberProof, realAccountProof, signInProof } from "./proof-signin.ts";
import { machineProof, presetProof } from "./proof-machine.ts";
import { DEFAULT_SCRATCH_ROOT, TOOL_DIR, World, attachWorld, inSlot, startWorld } from "./world.ts";

const scratchRoot = process.env["OVIS_WORLD_SCRATCH"] ?? DEFAULT_SCRATCH_ROOT;
/** this run's prefix for its world names: two proofs at once (yours and a reviewer's) never reach each other's worlds */
const P = `p${Math.floor(Math.random() * 0xfff).toString(16).padStart(3, "0")}`;
const CLI = join(TOOL_DIR, "cli.ts");
let wrong = 0;
const say = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const REAL_DOCKER = Bun.which("docker") ?? "docker";
/**
 * A `docker` first on PATH that writes each command line it is given to `log`, then runs docker: exactly what any
 * local user could read in that docker's /proc/<pid>/cmdline.
 */
function loggingDocker(): { path: string; log: string; lines: () => string[] } {
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, ".cmdlines-"));
  const log = join(dir, "cmdlines.log");
  writeFileSync(join(dir, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${REAL_DOCKER}' "$@"\n`);
  chmodSync(join(dir, "docker"), 0o755);
  return { path: dir, log, lines: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [] };
}

function verdict(claim: string, expected: "PASS" | "FAIL", ok: boolean, detail: string): void {
  const got = ok ? "PASS" : "FAIL";
  if (got !== expected) wrong++;
  say(`CHECK ${claim}: ${got} (expected ${expected}${got === expected ? "" : ", WRONG"}) ${detail}`);
}

async function until(ms: number, check: () => Promise<boolean>): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return Date.now() - started;
    await Bun.sleep(250);
  }
  return null;
}

/** `cli.ts up` as a separate owner process; resolves once it printed the world. */
async function ownerProcess(name: string, extra: readonly string[] = []): Promise<{ pid: number; reaper: () => Promise<number | null> }> {
  const child = Bun.spawn(["bun", CLI, "up", "--name", name, ...extra], { stdout: "pipe", stderr: "inherit", env: { ...process.env, OVIS_WORLD_SCRATCH: scratchRoot } });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  if (first.done) throw new Error(`up ${name} ended before it printed the world`);
  const reaper = async () => {
    const found = (await run(["pgrep", "-f", `scripts/world/reaper\\.ts ${name} `])).out.trim().split("\n")[0];
    return found ? Number(found) : null;
  };
  return { pid: child.pid, reaper };
}

const clean = async (name: string) => (await leftovers(name, join(scratchRoot, name))).length === 0;

async function teardownProof(): Promise<void> {
  const owner = await ownerProcess(`${P}k1`, ["--machine", "m1:herdr:bare"]);
  process.kill(owner.pid, "SIGKILL");
  const took = await until(30_000, () => clean(`${P}k1`));
  verdict("kill -9 the owner: nothing left within 30 s", "PASS", took !== null, took === null ? `left: ${(await leftovers(`${P}k1`, join(scratchRoot, `${P}k1`))).join("; ")}` : `clean after ${took} ms`);
  await using kept = await startWorld({ name: `${P}k2`, scratchRoot, machines: [{ name: "m1", engine: "herdr", start: "none" }] });
  const left = await leftovers(kept.name, kept.description.scratch);
  verdict("the nothing-left check on a world kept on purpose", "FAIL", left.length === 0, `it lists ${left.length}: ${left.slice(0, 4).join("; ")}`);
}

/** `promise`, or null when it has not settled within `ms`: raced once, so no read that was given up takes what comes later. */
async function bounded<T>(ms: number, promise: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

/** Where the kill-point check stops an owner in its own teardown, in the order the teardown passes them. */
const KILL_POINTS = {
  containers: "before it removes its containers",
  removing: "while docker removes its containers",
  network: "before it removes its network",
  scratch: "before it removes its scratch folder",
} as const;
type KillPoint = keyof typeof KILL_POINTS;

/**
 * `docker` for the owner under the kill-point check, first on its PATH. Once the check has armed it with the owner's
 * pid, the owner's own call that marks the point never returns: it says so in $OVIS_KILL_DIR/stopped (its pid) and
 * waits to be killed. Every other call, the reaper's too, is docker's. So the owner stands at an exact point of its
 * own teardown with no switch in the tool, and the same check runs on any version of the tool.
 */
const STOPPING_DOCKER = `#!/bin/sh
stop() { echo $$ > "$OVIS_KILL_DIR/stopping" && mv "$OVIS_KILL_DIR/stopping" "$OVIS_KILL_DIR/stopped" && exec sleep infinity; }
if [ "$(cat "$OVIS_KILL_DIR/armed" 2>/dev/null)" = "$PPID" ]; then
  case "$OVIS_KILL_POINT $1 $2" in
    "containers rm -f" | "network network rm") stop ;;
    "removing rm -f") "$OVIS_KILL_DOCKER" "$@" & stop ;;
    "scratch network rm") "$OVIS_KILL_DOCKER" "$@"; stop ;;
  esac
fi
exec "$OVIS_KILL_DOCKER" "$@"
`;

interface Killed { readonly ended: string; readonly reaper: string }

/**
 * One owner (`up` with two bare machines) given TERM, stopped at the point and KILLed there: how long its world took
 * to be gone, or what is left of it after 30 s, and what its reaper logged (a second name keeps the reaper's log
 * past the scratch folder it lies in).
 */
async function killedAt(name: string, point: KillPoint, dir: string, realDocker: string, reaperFirst = false): Promise<Killed> {
  const scratch = join(scratchRoot, name);
  for (const file of ["armed", "stopped"]) rmSync(join(dir, file), { force: true });
  const owner = Bun.spawn(["bun", CLI, "up", "--name", name, "--machine", "m1:herdr:bare", "--machine", "m2:herdr:bare"], { stdout: "pipe", stderr: "inherit",
    env: { ...process.env, OVIS_WORLD_SCRATCH: scratchRoot, PATH: `${dir}:${process.env["PATH"]}`, OVIS_KILL_POINT: point, OVIS_KILL_DIR: dir, OVIS_KILL_DOCKER: realDocker } });
  const first = await bounded(120_000, owner.stdout.getReader().read());
  if (first === null || first.done) { owner.kill("SIGKILL"); return { ended: "never printed its world", reaper: "" }; }
  if (reaperFirst) {
    const reaper = readFileSync(join(scratch, "reaper.pid"), "utf8").trim();
    process.kill(Number(reaper.split(":")[0]), "SIGKILL");
    await until(10_000, async () => !alive(reaper));
  }
  // the watch is there before the owner is armed and told to end, so its stop cannot come unseen
  const watcher = watch(dir);
  const stopped = new Promise<true>((resolve) => watcher.on("change", (_event, file) => { if (file === "stopped") resolve(true); }));
  writeFileSync(join(dir, "armed"), String(owner.pid));
  owner.kill("SIGTERM");
  const reached = await bounded(30_000, stopped);
  watcher.close();
  if (reached === null) { owner.kill("SIGKILL"); return { ended: "never stopped", reaper: "" }; }
  const kept = (file: string) => join(dir, `${name}.${file}`);
  for (const file of ["reaper.log", "reaper.err"]) if (existsSync(join(scratch, file))) linkSync(join(scratch, file), kept(file));
  owner.kill("SIGKILL");
  process.kill(Number(readFileSync(join(dir, "stopped"), "utf8")), "SIGKILL");
  const took = await until(30_000, () => clean(name));
  const ended = took === null ? `LEFT ${(await leftovers(name, scratch)).join(", ")}` : `${took}ms`;
  const logged = (file: string) => existsSync(kept(file)) ? readFileSync(kept(file), "utf8").split("\n").filter(Boolean) : [];
  const event = (line: string) => { try { return String((JSON.parse(line) as { event?: unknown }).event).slice(0, 200); } catch { return line.slice(0, 200); } };
  const failed = logged("reaper.err").find((line) => /^\w*[Ee]rror: /.test(line));
  const reaper = [...logged("reaper.log").map(event), ...(failed ? [`reaper.err: ${failed.slice(0, 300)}`] : [])].join(" > ");
  for (const file of ["reaper.log", "reaper.err"]) rmSync(kept(file), { force: true });
  return { ended, reaper };
}

const tally = (texts: readonly string[]) => [...new Set(texts)].map((text) => `${text} (x${texts.filter((other) => other === text).length})`).join("; ");

/**
 * The owner killed at exact points of its own teardown (a slot's KILL after its TERM), each point many times: the
 * world's reaper must finish what the owner left. The case built to break it is a world whose reaper was ended first.
 * OVIS_WORLD_KILL_REPEAT (default 10) is how many times per point.
 */
async function killPointsProof(): Promise<void> {
  const repeat = Number(process.env["OVIS_WORLD_KILL_REPEAT"] ?? 10);
  const realDocker = Bun.which("docker");
  if (realDocker === null) throw new Error("no docker on PATH");
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, ".killpoints-"));
  try {
    writeFileSync(join(dir, "docker"), STOPPING_DOCKER);
    chmodSync(join(dir, "docker"), 0o755);
    for (const point of Object.keys(KILL_POINTS) as KillPoint[]) {
      const killed: Killed[] = [];
      for (let n = 0; n < repeat; n++) killed.push(await killedAt(`${P}x${point[0]}${n}`, point, dir, realDocker));
      verdict(`KILL the owner ${KILL_POINTS[point]}, ${repeat} times: nothing left each time within 30 s`, "PASS", killed.every((one) => one.ended.endsWith("ms")),
        `${killed.map((one) => one.ended).join(" ")}; reapers logged: ${tally(killed.map((one) => one.reaper))}`);
    }
    const orphan = await killedAt(`${P}xz`, "scratch", dir, realDocker, true);
    verdict("the same KILL before the scratch folder goes, of a world whose reaper was ended first: nothing left within 30 s", "FAIL", orphan.ended.endsWith("ms"), orphan.ended);
    const removed = await gc([scratchRoot]);
    verdict("gc clears what that world left", "PASS", await clean(`${P}xz`), `gc removed ${removed.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function gcMarkerProof(): Promise<void> {
  const name = `${P}gc`;
  const foreign = join(scratchRoot, `${P}-not-a-world`);
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "keep.txt"), "a folder no world made\n");
  await docker(["network", "create", "--internal", "--label", `ovis.world=${name}`, "--label", "ovis.world.owner=1:1", "--label", "ovis.world.expires=1", "--label", `ovis.world.scratch=${foreign}`, `ovw-${name}-net`]);
  const removed = await gc([scratchRoot]);
  const networkGone = (await docker(["network", "ls", "-q", "--filter", `label=ovis.world=${name}`])) === "";
  verdict("gc of a dead world whose scratch label names a folder without that world's marker removes the folder", "FAIL", !existsSync(foreign), `gc removed ${removed.join(", ")}; folder kept: ${existsSync(foreign)}`);
  verdict("gc still removes that dead world's network", "PASS", networkGone, "");
  rmSync(foreign, { recursive: true, force: true });
  // an owner.json left empty (a full disk, a kill during its write) is said and skipped, never a stop for ls and gc
  const broken = join(scratchRoot, `${P}bad`);
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "owner.json"), "");
  const listed = await run(["env", `OVIS_WORLD_SCRATCH=${scratchRoot}`, "bun", CLI, "ls"]);
  const swept = await run(["env", `OVIS_WORLD_SCRATCH=${scratchRoot}`, "bun", CLI, "gc"]);
  // describe of a world that is not there: a refusal naming the file, also with --scratch-root
  const described = await run(["bun", CLI, "describe", `${P}none`, "--scratch-root", scratchRoot]);
  verdict("describe of a world with no world.json (--scratch-root given) answers with a stack trace", "FAIL", !(described.code === 2 && described.err.startsWith("refused: no world")),
    `exit ${described.code}: ${described.err.trim().split("\n")[0]?.slice(0, 200)}`);
  verdict("ls and gc with an empty owner.json in the scratch root go on, say it and keep the folder", "PASS", listed.code === 0 && swept.code === 0 && /skipped .*owner\.json/.test(listed.err) && existsSync(broken),
    `ls exit ${listed.code}, gc exit ${swept.code}: ${listed.err.trim().split("\n")[0]?.slice(0, 160)}`);
  rmSync(broken, { recursive: true, force: true });
}

async function ttlProof(): Promise<void> {
  const owner = await ownerProcess(`${P}t1`, ["--ttl", "60", "--machine", "m1:herdr:bare"]);
  const reaper = await owner.reaper();
  process.kill(owner.pid, "SIGKILL");
  if (reaper !== null) process.kill(reaper, "SIGKILL");
  const running = async () => (await docker(["ps", "-q", "--filter", `label=ovis.world=${P}t1`])).length > 0;
  verdict("kill -9 owner and reaper: containers still run before the deadline", "FAIL", !(await running()), `reaper pid ${reaper}`);
  const took = await until(90_000, async () => !(await running()));
  verdict("kill -9 owner and reaper: nothing runs after the TTL (60 s)", "PASS", took !== null, took === null ? "still running after 90 s" : `stopped ${Math.round(took / 1000)} s after the kills`);
  const removed = await gc([scratchRoot]);
  verdict("gc clears the rest", "PASS", await clean(`${P}t1`), `gc removed ${removed.join(", ")}`);
}

const withoutSlot = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OVIS_HEAVY_")));

async function slotProof(): Promise<void> {
  const band = inSlot();
  const up = (name: string, env: Record<string, string | undefined>, extra: string[] = []) => run(["timeout", "120", "env", "-i", ...Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined).map(([k, v]) => `${k}=${v}`), "bun", CLI, "up", "--name", name, ...extra]);
  const outside = await up(`${P}so1`, withoutSlot());
  verdict("a world started outside a heavy slot", "FAIL", outside.code === 0, `exit ${outside.code}: ${outside.err.trim().slice(0, 200)}`);
  const cpus = cpuSet(band);
  // a set online on this PC but not this slot's: once CPUs elsewhere, once this band less one CPU
  const elsewhere = cpuList(cpuSet(hostCpus().online).filter((cpu) => !cpus.includes(cpu)).slice(0, cpus.length));
  const forged = await up(`${P}so2`, { ...withoutSlot(), OVIS_HEAVY_SLOT: process.env["OVIS_HEAVY_SLOT"], OVIS_HEAVY_CPUS: elsewhere });
  verdict(`a world in the slot of ${band} claiming another set (OVIS_HEAVY_CPUS=${elsewhere})`, "FAIL", forged.code === 0, `exit ${forged.code}: ${forged.err.trim().slice(0, 200)}`);
  const narrower = cpuList(cpus.slice(0, -1));
  const shrunk = await up(`${P}so4`, { ...withoutSlot(), OVIS_HEAVY_SLOT: process.env["OVIS_HEAVY_SLOT"], OVIS_HEAVY_CPUS: narrower });
  verdict(`a world in the slot of ${band} claiming part of it (OVIS_HEAVY_CPUS=${narrower})`, "FAIL", shrunk.code === 0, `exit ${shrunk.code}: ${shrunk.err.trim().slice(0, 200)}`);
  const byHand = await up(`${P}so3`, process.env, ["--cpus", narrower]);
  verdict(`a world asking --cpus ${narrower} inside the slot of ${band}`, "FAIL", byHand.code === 0, `exit ${byHand.code}: ${byHand.err.trim().slice(0, 160)}`);
  const undated = await up(`${P}so5`, Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "OVIS_HEAVY_DEADLINE")));
  verdict("a world in a slot whose heavy-run.sh exports no OVIS_HEAVY_DEADLINE", "FAIL", undated.code === 0, `exit ${undated.code}: ${undated.err.trim().slice(0, 200)}`);
  verdict("none of the refused worlds left anything", "PASS", (await Promise.all([`${P}so1`, `${P}so2`, `${P}so3`, `${P}so4`, `${P}so5`].map(clean))).every(Boolean), "");
  await using world = await startWorld({ name: `${P}p1`, scratchRoot, machines: [{ name: "m1", engine: "herdr", start: "none" }] });
  const before = await unpinned(world.name, band);
  verdict(`every container of a world is pinned to the slot's band ${band} (OVIS_HEAVY_CPUS=${process.env["OVIS_HEAVY_CPUS"]})`, "PASS", before.length === 0 && world.plan.cpus === band, `${before.length} not on it`);
  const part = cpuList(cpus.slice(0, 2));
  // the binding rule pins every container this PC starts inside the slot, so the rogue one gets part of the band and
  // no memory cap; an empty read-back (no pin at all) is the unit test's case (plan.test.ts, samePins)
  await docker(["run", "-d", "--name", `ovw-${P}p1-rogue`, "--label", `ovis.world=${P}p1`, "--label", `ovis.world.owner=${world.description.owner}`, `--cpuset-cpus=${part}`, "--network", world.description.network, "--entrypoint", "sleep", "herdr-ci-runner:local", "120"]);
  const after = await unpinned(world.name, band);
  verdict("a container started without the world's pin and memory cap is detected", "FAIL", after.length === 0, `detected: ${after.map((pin) => `${pin.name} cpus="${pin.cpus}" memory=${pin.memory}`).join("; ")}`);
}

const HEAVY_RUN = join(homedir(), ".ovis-toolchain/heavy-run.sh");
/** how long a check that needs a slot of its own waits for heavy-run.sh to hand one out */
const SLOT_WAIT_S = 900;

/**
 * heavy-run.sh's own end of a slot, through the real thing: `heavy-run.sh -t 60` (a slot of its own, whose
 * OVIS_HEAVY_DEADLINE nobody here sets) around `up --ttl 3600`. Once the slot's TERM ends the owner; once the owner is
 * KILLed before that (its handlers never run). The world and each container's own timeout must end with the slot.
 */
async function slot60Proof(): Promise<void> {
  const slot = (name: string, inner: readonly string[]) => {
    const mark = join(scratchRoot, `.${name}.deadline`);
    const child = Bun.spawn(["timeout", String(SLOT_WAIT_S + 120), HEAVY_RUN, "-t", "60", "--", "sh", "-c", 'echo "$OVIS_HEAVY_DEADLINE" > "$0"; exec "$@"', mark, ...inner,
      "bun", CLI, "up", "--name", name, "--ttl", "3600", "--machine", "m1:herdr:bare"],
      { stdout: "ignore", stderr: "ignore", env: { ...withoutSlot(), OVIS_WORLD_SCRATCH: scratchRoot, OVIS_HEAVY_LABEL: `world-proof-${name}` } });
    return { name, child, mark };
  };
  mkdirSync(scratchRoot, { recursive: true });
  const slots = [slot(`${P}s6t`, []), slot(`${P}s6k`, ["timeout", "-s", "KILL", "40"])];
  // both at once: each slot starts when heavy-run.sh hands it out, and the KILLed one's world is gone 40 s later
  const seen = await Promise.all(slots.map(async ({ name, mark }) => {
    const file = join(scratchRoot, name, "world.json");
    await until(SLOT_WAIT_S * 1000, async () => existsSync(file) && existsSync(mark));
    const deadline = existsSync(mark) ? Number(readFileSync(mark, "utf8").trim()) : 0;
    const expires = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { expires: number }).expires : 0;
    const timer = expires === 0 ? "" : await docker(["inspect", "-f", "{{index .Args 2}}", `ovw-${name}-m_m1`]).catch(() => "");
    return { name, deadline, expires, timer };
  }));
  for (const { name, deadline, expires, timer } of seen) {
    verdict(`${name}: a world asking --ttl 3600 in a real heavy-run.sh -t 60 slot ends with it (its deadline and a container's own timeout are the slot's OVIS_HEAVY_DEADLINE)`, "PASS",
      deadline > 0 && expires === deadline && Number(timer) === deadline, `slot deadline ${deadline}, world expires ${expires}, container timeout until ${timer || "-"}`);
  }
  for (const { name, child, mark } of slots) {
    const code = await child.exited;
    rmSync(mark, { force: true });
    const how = name.endsWith("t") ? "the slot's TERM at its limit" : "a KILL of the owner before the limit (its handlers never run)";
    const took = await until(60_000, () => clean(name));
    verdict(`${name}: the world is gone after ${how}`, "PASS", took !== null, `slot exit ${code}; ${took === null ? `left: ${(await leftovers(name, join(scratchRoot, name))).join("; ")}` : `clean ${took} ms after the slot ended`}`);
  }
}

// real Ovis services are only ever RESOLVED, never asked: a request goes to neutral hosts alone, even when opened
const OUTSIDE = "for t in 'https://1.1.1.1' 'https://example.com'; do curl -s -m 4 -o /dev/null -w \"$t %{http_code} exit=%{exitcode}\\n\" \"$t\"; done; " +
  "for h in account.ovis.sh relay.ovis.sh; do if getent hosts $h >/dev/null; then echo \"$h resolves\"; else echo \"$h 000 exit=unresolved\"; fi; done; true";

async function sealedProof(): Promise<void> {
  for (const [name, outbound, expected] of [[`${P}s1`, false, "PASS"], [`${P}s2`, true, "FAIL"]] as const) {
    await using world = await startWorld({ name, scratchRoot, outbound, machines: [{ name: "m1", engine: "herdr", start: "none" }] });
    const answers = (await world.machine("m1").exec(["sh", "-c", OUTSIDE])).out.trim().split("\n");
    const reached = answers.filter((line) => !/ 000 exit=/.test(line) && line !== "");
    verdict(`sealed: no outside host reachable from a machine${outbound ? " (world opened with --outbound)" : ""}`, expected, reached.length === 0, answers.join(" | "));
    if (outbound) continue;
    await secretsProof(world);
  }
}

/**
 * Keys and tokens stay private (found in review): the world's certs folder is 0700 with both keys 0600, its TLS proxy
 * still serves with them, and a token given to a machine's command never appears on a docker command line.
 */
async function secretsProof(world: World): Promise<void> {
  const certs = join(world.description.scratch, "certs");
  const mode = (file: string) => existsSync(file) ? (statSync(file).mode & 0o777).toString(8) : "missing";
  const modes = [certs, ...["ca.key", "key.pem", "ca.pem", "cert.pem"].map((file) => join(certs, file))].map(mode);
  verdict("the world's certs folder is 0700, ca.key and key.pem 0600, ca.pem and cert.pem 0644", "PASS", modes.join(" ") === "700 600 600 644 644", `folder, ca.key, key.pem, ca.pem, cert.pem: ${modes.join(" ")}`);
  const status = async (args: readonly string[]) => (await world.machine("m1").exec(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code} exit=%{exitcode}", "-m", "5", ...args, `${world.description.account.url}/v1/providers`])).out.trim();
  const trusted = await status(["--cacert", "/world/ca.pem"]);
  verdict("its TLS proxy serves the account origin with that key to a machine that trusts the test CA", "PASS", trusted.startsWith("200 "), trusted);
  const untrusted = await status([]);
  verdict("the same request without trusting the test CA succeeds", "FAIL", untrusted.startsWith("200 "), untrusted);
  const spy = loggingDocker();
  const token = randomBytes(16).toString("hex");
  const inLine = randomBytes(16).toString("hex");
  const typed = randomBytes(16).toString("hex");
  // a token in Machine.exec's env, one inside Machine.terminal's command line, one typed with Machine.type; and an env
  // named PATH, which must reach the machine without steering docker. A terminal's recording ends with term.sh's own line.
  const child = Bun.spawn(["bun", "-e", `import { Machine } from ${JSON.stringify(join(TOOL_DIR, "machines.ts"))};
const machine = new Machine(JSON.parse(process.env["WORLD_PROOF_MACHINE"]));
const ended = async (label) => { let text = ""; for (const end = Date.now() + 15000; Date.now() < end && !text.includes("[term.sh: exited]"); await Bun.sleep(100)) text = await machine.recording(label); return text; };
const exec = (await machine.exec(["printenv", "WORLD_PROOF_TOKEN"], { WORLD_PROOF_TOKEN: process.env["WORLD_PROOF_SECRET"] })).out.trim();
const path = await machine.exec(["/bin/sh", "-c", "printf %s \\"$PATH\\""], { PATH: "/opt/world-bin" });
await machine.terminal("tokenline", "echo " + process.env["WORLD_PROOF_INLINE"]);
const line = await ended("tokenline");
await machine.terminal("tokentyped", "read typed; echo got-$typed");
await machine.type("tokentyped", process.env["WORLD_PROOF_TYPED"] + "\\n");
const typed = await ended("tokentyped");
console.log(JSON.stringify({ exec, path: { code: path.code, out: path.out, err: path.err.slice(0, 200) }, line, typed }));`],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${spy.path}:${process.env["PATH"]}`, WORLD_PROOF_MACHINE: JSON.stringify(world.machine("m1").description), WORLD_PROOF_SECRET: token, WORLD_PROOF_INLINE: inLine, WORLD_PROOF_TYPED: typed } });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const got = (() => { try { return JSON.parse(out) as { exec: string; path: { code: number; out: string; err: string }; line: string; typed: string }; } catch { return { exec: "", path: { code: -1, out: "", err: err.trim().slice(-200) }, line: "", typed: "" }; } })();
  const lines = spy.lines();
  const secrets = [token, inLine, typed];
  const hidden = (text: string) => secrets.reduce((line, secret, index) => line.replaceAll(secret, `<TOKEN${index + 1}>`), text).slice(0, 120);
  verdict("an env PATH=/opt/world-bin given to Machine.exec reaches the machine, and docker (found on this PC's own PATH) still runs", "PASS", got.path.code === 0 && got.path.out === "/opt/world-bin",
    `exit ${got.path.code}: ${got.path.out || got.path.err}`);
  verdict("a token in Machine.exec's env, one in Machine.terminal's command line and one typed with Machine.type all reach the machine", "PASS",
    got.exec === token && got.line.includes(inLine) && got.typed.includes(`got-${typed}`), `exec ${got.exec === token}, terminal ${got.line.includes(inLine)}, typed ${got.typed.includes(`got-${typed}`)}; ${lines.filter((line) => line.startsWith("exec ")).length} docker exec seen`);
  verdict("any of those tokens appears on a docker command line", "FAIL", lines.some((line) => secrets.some((secret) => line.includes(secret))), lines.filter((line) => /^exec (-[di] )?-u runner/.test(line)).map(hidden).join(" | "));
  rmSync(spy.path, { recursive: true, force: true });
}

async function twoWorldsProof(): Promise<void> {
  const [a, b] = await Promise.all([`${P}a1`, `${P}b1`].map((name) => startWorld({ name, scratchRoot, machines: ["herdr"] }))) as [World, World];
  try {
    verdict("two worlds at once get different subnets", "PASS", a.description.subnet !== b.description.subnet, `${a.description.subnet} ${b.description.subnet}`);
    await a.teardown();
    const bWhole = (await docker(["ps", "-q", "--filter", `label=ovis.world=${P}b1`, "--filter", "status=running"])).split("\n").filter(Boolean).length;
    const health = await b.machine("m1").health();
    verdict("tearing one down leaves the other whole (4 containers running, its server healthy)", "PASS", bWhole === 4 && health?.["ok"] === true, `running ${bWhole}, health ok ${health?.["ok"]}`);
    verdict("the torn-down world is gone", "PASS", await clean(`${P}a1`), "");
  } finally {
    await Promise.all([a.teardown(), b.teardown()]);
  }
}

async function enginesProof(): Promise<void> {
  await using world = await startWorld({ name: `${P}e1`, scratchRoot, machines: [{ name: "m1", engine: "herdr", start: "all" }, { name: "m2", engine: "core", start: "all" }, { name: "m3", engine: "herdr", start: "none" }] });
  for (const [name, expected] of [["m1", "PASS"], ["m2", "PASS"], ["m3", "FAIL"]] as const) {
    const machine = world.machine(name);
    const health = await machine.health();
    const ps = await machine.ps();
    const engine = (health?.["herdr"] as { version?: string; runtime?: string } | undefined);
    const ok = health?.["ok"] === true && /\bclaude\b/.test(ps) && /(herdr server|hc serve)/.test(ps);
    verdict(`${name} (${machine.description.engine}${name === "m3" ? ", nothing started" : ""}) answers: server health, engine, stand-in`, expected, ok, `engine ${engine?.version ?? "-"} ${engine?.runtime ?? ""}`);
  }
}

/**
 * Two scratch roots, one name: a second `up` must never take the first world. Once it is refused
 * by its look on docker; once a shim hides the first world from that look, so the second fails at its network and
 * runs its failure path and its reaper, which must remove only their own objects.
 */
async function clashProof(): Promise<void> {
  const name = `${P}cl`;
  mkdirSync(scratchRoot, { recursive: true });
  const other = mkdtempSync(join(scratchRoot, ".other-root-"));
  const shim = mkdtempSync(join(scratchRoot, ".hide-"));
  try {
    await using first = await startWorld({ name, scratchRoot, machines: [{ name: "m1", engine: "herdr", start: "none" }] });
    const whole = async () => ({ running: (await containers(first.name, false)).length, network: (await networks(first.name)).length });
    const before = await whole();
    const second = await run(["env", `OVIS_WORLD_SCRATCH=${other}`, "timeout", "120", "bun", CLI, "up", "--name", name, "--machine", "m1:herdr:bare"]);
    verdict("a second up of the same name from another scratch root starts", "FAIL", second.code === 0, `exit ${second.code}: ${second.err.trim().split("\n").find((line) => /refused|rror/.test(line))?.slice(0, 200) ?? ""}`);
    const afterRefusal = await whole();
    writeFileSync(join(shim, "docker"), `#!/bin/sh
case "$*" in *"label=ovis.world=$OVIS_HIDE_WORLD"*) case "$*" in *"label=ovis.world.owner="*) ;; *) exit 0 ;; esac ;; esac
exec "$OVIS_REAL_DOCKER" "$@"
`);
    chmodSync(join(shim, "docker"), 0o755);
    const raced = await run(["env", `OVIS_WORLD_SCRATCH=${other}`, `PATH=${shim}:${process.env["PATH"]}`, `OVIS_HIDE_WORLD=${name}`, `OVIS_REAL_DOCKER=${Bun.which("docker")}`,
      "timeout", "120", "bun", CLI, "up", "--name", name, "--machine", "m1:herdr:bare"]);
    // its reaper, if one was left at work, has ended (it removes only its own owner's objects)
    await until(30_000, async () => (await run(["pgrep", "-f", `reaper\\.ts ${name} .*${other}`])).code !== 0 && !existsSync(join(other, name)));
    const afterRace = await whole();
    verdict("the same, with its look on docker blinded: it fails at its network", "FAIL", raced.code === 0, `exit ${raced.code}: ${raced.err.split("\n").find((line) => /^error: .*exists already/.test(line))?.slice(0, 200) ?? raced.err.trim().slice(-200)}`);
    verdict("the first world stays whole after both: its containers running, its network there, its server's machine untouched", "PASS",
      before.running === 4 && before.network === 1 && JSON.stringify([afterRefusal, afterRace]) === JSON.stringify([before, before]), `before ${JSON.stringify(before)}, after the refusal ${JSON.stringify(afterRefusal)}, after the blinded one ${JSON.stringify(afterRace)}`);
  } finally {
    rmSync(other, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
  }
}

/** Where the start-point check holds an owner's own docker call while it starts. */
const START_POINTS = { network: "while its network is being made", container: "while its first container is being made" } as const;
type StartPoint = keyof typeof START_POINTS;

/**
 * `docker` for an owner under the start-point check, first on its PATH: the owner's own call at the point waits on a
 * fifo (it stays a docker call in flight, as one cut short by a signal does) and then runs. Every other call is docker's.
 */
const HOLDING_DOCKER = `#!/bin/sh
case "$OVIS_START_POINT $1 $2 $3" in
  "network network create "*|"container run -d "*)
    case "$*" in *"$OVIS_START_WORLD"*) echo $$ > "$OVIS_START_DIR/holding" && mv "$OVIS_START_DIR/holding" "$OVIS_START_DIR/held"; read go < "$OVIS_START_DIR/go" ;; esac ;;
esac
exec "$OVIS_REAL_DOCKER" "$@"
`;

/**
 * One owner given TERM while its own docker call at the point is held, and the call let go only after the owner has
 * exited: what that call makes lands after the owner's teardown, and the world's reaper must remove it.
 */
async function termedAt(name: string, point: StartPoint, dir: string, realDocker: string, reaperFirst = false): Promise<{ ended: string; owner: string; reaper: string; leftAfter3s: boolean }> {
  for (const file of ["held", "go"]) rmSync(join(dir, file), { force: true });
  if ((await run(["mkfifo", join(dir, "go")])).code !== 0) throw new Error("mkfifo failed");
  const watcher = watch(dir);
  const held = new Promise<true>((resolve) => watcher.on("change", (_event, file) => { if (file === "held") resolve(true); }));
  const said = join(dir, `${name}.err`);
  const owner = Bun.spawn(["bun", CLI, "up", "--name", name, "--machine", "m1:herdr:bare"], { stdout: "ignore", stderr: Bun.file(said),
    env: { ...process.env, OVIS_WORLD_SCRATCH: scratchRoot, PATH: `${dir}:${process.env["PATH"]}`, OVIS_START_POINT: point, OVIS_START_DIR: dir, OVIS_START_WORLD: `ovw-${name}-`, OVIS_REAL_DOCKER: realDocker } });
  const reached = await bounded(60_000, held);
  watcher.close();
  if (reached === null) {
    owner.kill("SIGKILL");
    const err = existsSync(said) ? readFileSync(said, "utf8").split("\n").filter((line) => /rror|refused/.test(line)).slice(-2).join(" / ").slice(0, 300) : "";
    return { ended: `never held (the owner said: ${err || "nothing"})`, owner: "", reaper: "", leftAfter3s: false };
  }
  const reaperId = readFileSync(join(scratchRoot, name, "reaper.pid"), "utf8").trim();
  if (reaperFirst) { process.kill(Number(reaperId.split(":")[0]), "SIGKILL"); await until(10_000, async () => !alive(reaperId)); }
  owner.kill("SIGTERM");
  const code = await bounded(30_000, owner.exited);
  const reaperAfter = alive(reaperId);
  const holder = Number(readFileSync(join(dir, "held"), "utf8").trim());
  // let the held call go (the fifo's reader is waiting on it, so the write does not block), and judge only once it
  // has landed: what it makes comes after the owner's teardown, which is the case under test
  const holding = processIdentity(holder);
  if (holding !== null) writeFileSync(join(dir, "go"), "go\n");
  const landed = holding === null || (await until(60_000, async () => processIdentity(holder) !== holding)) !== null;
  if (!landed) return { ended: "the held docker call never ended", owner: `exit ${code ?? "none in 30 s"}`, reaper: reaperAfter ? "alive" : "gone", leftAfter3s: true };
  // a short look first: on this shared PC any other session's up runs gc, which sweeps a dead owner's network sooner or later
  const leftAfter3s = (await until(3_000, () => clean(name))) === null;
  const took = await until(30_000, () => clean(name));
  return { ended: took === null ? `LEFT ${(await leftovers(name, join(scratchRoot, name))).join(", ")}` : `${took}ms`, owner: `exit ${code ?? "none in 30 s"}`, reaper: reaperAfter ? "alive" : "gone", leftAfter3s };
}

/**
 * TERM during the start, at named points, 3 times each: the owner must not end the reaper while its
 * own docker call is in flight, and the reaper must remove what that call makes after the owner's teardown. The case
 * built to break it: the same TERM to a world whose reaper was ended first.
 */
async function startPointsProof(): Promise<void> {
  const realDocker = Bun.which("docker");
  if (realDocker === null) throw new Error("no docker on PATH");
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, ".startpoints-"));
  try {
    writeFileSync(join(dir, "docker"), HOLDING_DOCKER);
    chmodSync(join(dir, "docker"), 0o755);
    for (const point of Object.keys(START_POINTS) as StartPoint[]) {
      const runs = [];
      for (let n = 0; n < 3; n++) runs.push(await termedAt(`${P}y${point[0]}${n}`, point, dir, realDocker));
      verdict(`TERM the owner ${START_POINTS[point]}, its call landing after the owner exited, 3 times: the reaper outlives the owner and nothing is left within 30 s`, "PASS",
        runs.every((one) => one.ended.endsWith("ms") && one.reaper === "alive"), runs.map((one) => `${one.owner}, reaper ${one.reaper}, ${one.ended}`).join("; "));
    }
    const orphan = await termedAt(`${P}yz`, "network", dir, realDocker, true);
    verdict("the same TERM while its network is being made, of a world whose reaper was ended first: nothing left 3 s after the late call landed", "FAIL", !orphan.leftAfter3s, `${orphan.leftAfter3s ? "left after 3 s" : "clean within 3 s"}; then ${orphan.ended}`);
    const removed = await gc([scratchRoot]);
    verdict("gc clears what that world left", "PASS", await clean(`${P}yz`), `gc removed ${removed.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whose docker calls a world waits for (found in review): two worlds w and w-m, a docker logs -f of w-m's proxy
 * and docker events watchers running. w must count none of them, and its teardown must end its reaper; the case
 * built to break it is a docker logs -f of w's own proxy, which w does count.
 */
async function inFlightProof(): Promise<void> {
  const [w, wm] = await Promise.all([`${P}w`, `${P}w-m`].map((name) => startWorld({ name, scratchRoot, machines: [] }))) as [World, World];
  const watchers: ReturnType<typeof Bun.spawn>[] = [];
  const follow = async (argv: string[]) => {
    watchers.push(Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }));
    await until(10_000, async () => (await run(["pgrep", "-f", argv.join(" ")])).code === 0);
    return watchers.at(-1)!;
  };
  try {
    await follow(["docker", "logs", "-f", `ovw-${wm.name}-tls`]);
    await follow(["docker", "events", "--filter", `container=ovw-${wm.name}-relay`]);
    await follow(["docker", "events", "--filter", `label=ovis.world=${w.name}`]);
    const seen = await dockerInFlight(w.name, w.description.owner);
    verdict(`world ${w.name} counts none of world ${wm.name}'s docker calls, nor docker events watchers, as its own`, "PASS", seen.length === 0, seen.map((line) => line.slice(0, 120)).join(" | "));
    const own = await follow(["docker", "logs", "-f", `ovw-${w.name}-tls`]);
    const mine = await dockerInFlight(w.name, w.description.owner);
    verdict(`the same look while a docker logs -f of ${w.name}'s own proxy runs finds nothing`, "FAIL", mine.length === 0, mine.map((line) => line.slice(0, 120)).join(" | "));
    own.kill();
    await own.exited;
    const reaper = readFileSync(join(w.description.scratch, "reaper.pid"), "utf8").trim();
    await w.teardown();
    const ended = await until(5_000, async () => !alive(reaper));
    verdict(`${w.name}'s teardown ends its reaper while ${wm.name}'s docker logs -f and the watchers run`, "PASS", ended !== null && await clean(w.name), `${ended === null ? `reaper ${reaper} still alive 5 s after the teardown` : `reaper gone ${ended} ms after it`}; left: ${(await leftovers(w.name, w.description.scratch)).join("; ") || "nothing"}`);
  } finally {
    for (const watcher of watchers) watcher.kill();
    await Promise.all([w.teardown(), wm.teardown()]);
  }
}

/** Loopback ports free this moment, from the kernel (a fixed test port may be anybody's ephemeral one). */
function freePorts(count: number): number[] {
  const held = Array.from({ length: count }, () => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }));
  const ports = held.map((listener) => listener.port);
  for (const listener of held) listener.stop(true);
  return ports;
}

async function servicesProof(): Promise<void> {
  const services = (args: string[]) => run(["bun", CLI, "services", ...args]);
  const objects = async (name: string) => [...(await docker(["ps", "-aq", "--filter", `label=ovis.world=svc-${name}`])).split("\n"), ...(await docker(["network", "ls", "-q", "--filter", `label=ovis.world=svc-${name}`])).split("\n")].filter(Boolean);
  const refused = await services(["up", "--name", `${P}lock`]);
  verdict("services up refuses the published ports to the fake (it signs in whoever asks)", "FAIL", refused.code === 0, `exit ${refused.code}: ${refused.err.trim().slice(0, 160)}`);
  const listening = (await run(["ss", "-ltnH"])).out.split("\n").filter((line) => /127\.0\.0\.1:2754[234]\b/.test(line));
  verdict("nothing of the refused services listens on 27542-27544", "PASS", listening.length === 0 && (await docker(["ps", "-aq", "--filter", `label=ovis.world=svc-${P}lock`])) === "", listening.join("; "));
  const [account, relay, kit, control] = freePorts(4) as [number, number, number, number];
  const spy = loggingDocker();
  const up = await run(["env", `PATH=${spy.path}:${process.env["PATH"]}`, "bun", CLI, "services", "up", "--name", `${P}lock`, "--ports", [account, relay, kit, control].join(",")]);
  try {
    const answers = (await fetch(`http://127.0.0.1:${account}/v1/providers`).catch(() => null))?.status;
    // the edge's own refusal is an empty 404; anything else came from the account service behind it
    const testRoutes = await Promise.all(["/v1/test", "/v1/test/token"].map(async (path) => {
      const answer = await fetch(`http://127.0.0.1:${account}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
      return { path, status: answer?.status ?? 0, body: answer ? await answer.text() : "" };
    }));
    verdict("the same services on test ports start and answer", "PASS", up.code === 0 && answers === 200, `exit ${up.code}, account ${answers}${up.code === 0 ? "" : `: ${up.err.trim().slice(-300)}`}`);
    verdict("the edge lets /v1/test or /v1/test/token through to the account service", "FAIL", testRoutes.some((route) => route.status !== 404 || route.body !== ""),
      testRoutes.map((route) => `${route.path} ${route.status} ${route.body === "" ? "(empty: the edge)" : `(${route.body.slice(0, 60)})`}`).join("; "));
    const format = '{{.Name}} {{.HostConfig.CpusetCpus}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.RestartPolicy.Name}} {{index .HostConfig.LogConfig.Config "max-size"}} {{index .HostConfig.LogConfig.Config "max-file"}}';
    const ids = (await docker(["ps", "-aq", "--filter", `label=ovis.world=svc-${P}lock`])).split("\n").filter(Boolean);
    const lines = ids.length === 0 ? [] : (await docker(["inspect", "-f", format, ...ids])).split("\n").sort();
    const expected = ["account", "edge", "relay"].map((part) => `/m2-${P}lock-${part} 0-55 2000000000 2147483648 unless-stopped 10m 3`);
    verdict("each service is m2-*, on CPUs 0-55, at most 2 CPUs and 2 GB, restarted unless stopped, logs capped (10m x 3)", "PASS", JSON.stringify(lines) === JSON.stringify(expected), lines.join(" | "));
    const state = join(homedir(), ".local/state/ovis-test-services", `${P}lock`);
    const token = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${control}/token`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ account: "acct_proof" }) }).then((answer) => answer.status, () => 0);
    const without = await token({});
    verdict("the control API on loopback issues a token without the secret", "FAIL", without === 200, `status ${without}`);
    const modes = ["control.secret", "Caddyfile"].map((file) => existsSync(join(state, file)) ? (statSync(join(state, file)).mode & 0o777).toString(8) : "missing");
    const withSecret = existsSync(join(state, "control.secret")) ? await token({ [CONTROL_HEADER]: readFileSync(join(state, "control.secret"), "utf8").trim() }) : 0;
    verdict("with the secret from control.secret (mode 0600) it does", "PASS", withSecret === 200 && modes.every((mode) => mode === "600"), `status ${withSecret}; modes control.secret ${modes[0]}, Caddyfile ${modes[1]}`);
    // past the edge: the services' own addresses, straight from this PC (any local user could do the same)
    const at = addresses((JSON.parse(readFileSync(join(state, "services.json"), "utf8")) as { subnet: string }).subnet);
    const direct = (url: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "acct_proof", subject: "acct_proof" }), signal: AbortSignal.timeout(3000) })
      .then((answer) => String(answer.status), (error: Error) => `unreachable (${error.name})`);
    const directToken = await direct(`http://${at.account}:9090/token`);
    verdict(`the control API on the account's own address (${at.account}:9090) issues a token to this PC without the secret`, "FAIL", directToken === "200", `POST /token: ${directToken}`);
    const directTest = await direct(`http://${at.account}:9080/v1/test/token`);
    verdict(`the account service on its own address (${at.account}:9080) answers this PC past the edge`, "FAIL", /^\d+$/.test(directTest), `POST /v1/test/token: ${directTest}`);
    // the control server's own check, from a container on the services' network (where the edge reaches it from)
    const secret = existsSync(join(state, "control.secret")) ? readFileSync(join(state, "control.secret"), "utf8").trim() : "";
    const seen = spy.lines();
    const runs = seen.filter((line) => line.startsWith("run "));
    verdict("the spy saw every docker run of services up (account, relay, edge)", "PASS", runs.length === 3, `${runs.length} docker run, ${seen.length} docker command lines`);
    // down is for worlds: M2's long-lived services (world label svc-<name>, owner "service") are never its to remove
    const downed = await run(["bun", CLI, "down", "--name", `svc-${P}lock`]);
    const servicesLeft = (await docker(["ps", "-q", "--filter", `label=ovis.world=svc-${P}lock`, "--filter", "status=running"])).split("\n").filter(Boolean).length;
    verdict(`down --name svc-${P}lock removes the long-lived services`, "FAIL", downed.code === 0 || servicesLeft < 3, `exit ${downed.code}, services running ${servicesLeft}: ${downed.err.trim().split("\n")[0]?.slice(0, 160)}`);
    verdict("the control secret appears on a docker command line while the services start", "FAIL", secret !== "" && seen.some((line) => line.includes(secret)),
      runs.map((line) => (/(-e WORLD_CONTROL_SECRET\S*|--env-file \S+)/.exec(line.replace(secret, "<SECRET>")) ?? [""])[0]).filter(Boolean).join(" ") || "neither -e WORLD_CONTROL_SECRET nor --env-file on any docker run");
    const fromInside = async (headers: readonly string[]) => (await run(["docker", "exec", `m2-${P}lock-relay`, "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "3", "-X", "POST",
      "-H", "content-type: application/json", ...headers, "-d", '{"account":"acct_proof"}', `http://${at.account}:9090/token`])).out.trim();
    const insideWithout = await fromInside([]);
    verdict("from inside the services' network, the control server itself issues a token without the secret", "FAIL", insideWithout === "200", `status ${insideWithout}`);
    const insideWith = await fromInside(["-H", `${CONTROL_HEADER}: ${secret}`]);
    verdict("and with the secret it does", "PASS", insideWith === "200", `status ${insideWith}`);
  } finally {
    await services(["down", "--name", `${P}lock`, "--purge"]);
    rmSync(spy.path, { recursive: true, force: true });
  }
  // a step that fails part-way: the edge cannot publish its control port, which something else holds
  const holder = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const taken = holder.port;
  const half = await services(["up", "--name", `${P}half`, "--ports", [...freePorts(3), taken].join(",")]);
  holder.stop(true);
  const left = await objects(`${P}half`);
  verdict("services up succeeds while its control port is taken", "FAIL", half.code === 0, `exit ${half.code}: ${/address already in use/.exec(half.err) ? `docker: address already in use (127.0.0.1:${taken})` : half.err.trim().slice(-240)}`);
  verdict("that failed services up leaves no container and no network", "PASS", left.length === 0, `left ${left.length}`);
  await services(["down", "--name", `${P}half`, "--purge"]);
}

/** What a machine was started with: what its server is pointed at, its pin and cap, whose checkout it runs, the CA trust. */
async function machineSettings(container: string): Promise<Record<string, string | number | boolean>> {
  const env = Object.fromEntries((JSON.parse(await docker(["inspect", "-f", "{{json .Config.Env}}", container])) as string[]).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const pins = await readPins(container);
  const repo = await docker(["inspect", "-f", '{{range .Mounts}}{{if eq .Destination "/opt/ovis"}}{{.Source}}{{end}}{{end}}', container]);
  const ca = (await run(["docker", "exec", container, "test", "-f", "/usr/local/share/ca-certificates/ovis-world-test.crt"])).code === 0;
  return { relay: env["WORLD_RELAY_URL"] ?? "", account: env["WORLD_ACCOUNT_URL"] ?? "", passes: env["WORLD_PASSES"] ?? "", cpus: pins.cpus, memory: pins.memory, repo, ca };
}

/**
 * add-machine, from a process other than the owner: the plan the world saved (not defaults), the world's band only,
 * and herdr-core's binary for a world that started without a core machine. The cases built to break it: a slot of
 * another band, a plan rebuilt from defaults (what add-machine did before), and a core machine with nothing started.
 */
async function addMachineProof(): Promise<void> {
  const name = `${P}am`;
  const relay = "wss://relay.example.test:8443";
  const owner = await ownerProcess(name, ["--machine", "m1:herdr:bare", "--passes", "grace", "--origin", `relay=${relay}`, "--memory", "1g", "--trust-ca"]);
  try {
    const band = inSlot();
    const add = (machine: string, prefix: readonly string[] = []) => run([...prefix, "bun", CLI, "add-machine", "--name", name, "--machine", machine, "--scratch-root", scratchRoot]);
    const other = cpuList(cpuSet(band).slice(0, -1));
    // a slot of its own to the tool: a part of this PC, the set this process runs on (taskset), and its OVIS_HEAVY_CPUS
    const elsewhere = await add("m3:herdr:bare", ["taskset", "-c", other, "env", `OVIS_HEAVY_CPUS=${other}`]);
    const strayM3 = (await docker(["ps", "-aq", "--filter", `name=^ovw-${name}-m_m3$`])) !== "";
    verdict(`add-machine from a slot of another band (${other}) to a world pinned to ${band}`, "FAIL", !/is pinned to/.test(elsewhere.err) || strayM3, `exit ${elsewhere.code}, container m3 ${strayM3 ? "started" : "none"}: ${elsewhere.err.trim().slice(0, 220)}`);
    // the review's own run: add-machine from a real second slot that heavy-run.sh hands out (another band)
    const second = await run(["env", ...Object.keys(process.env).filter((key) => key.startsWith("OVIS_HEAVY_")).flatMap((key) => ["-u", key]), `OVIS_HEAVY_LABEL=world-proof-${name}-b`,
      "timeout", String(SLOT_WAIT_S + 120), HEAVY_RUN, "-t", "300", "--", "sh", "-c", 'echo "slot band $OVIS_HEAVY_CPUS" >&2; exec "$@"', "add",
      "bun", CLI, "add-machine", "--name", name, "--machine", "m6:herdr:bare", "--scratch-root", scratchRoot]);
    const strayM6 = (await docker(["ps", "-aq", "--filter", `name=^ovw-${name}-m_m6$`])) !== "";
    verdict(`add-machine from a second slot that heavy-run.sh hands out, to a world pinned to ${band}`, "FAIL", !/is pinned to/.test(second.err) || strayM6,
      `exit ${second.code}, container m6 ${strayM6 ? "started" : "none"}: ${second.err.trim().split("\n").filter((line) => /slot band|refused/.test(line)).join(" / ").slice(0, 260)}`);
    const reference = await machineSettings(`ovw-${name}-m_m1`);
    const wanted = reference["relay"] === relay && reference["passes"] === "grace" && reference["memory"] === 1024 ** 3 && reference["cpus"] === band && reference["ca"] === true;
    const hcBefore = existsSync(join(scratchRoot, name, "bin", "hc"));
    const added = await add("m2:core");
    const settings = added.code === 0 ? await machineSettings(`ovw-${name}-m_m2`) : {};
    verdict("a machine added later runs with the world's own settings (relay origin, passes, memory, band, checkout, CA trust)", "PASS",
      added.code === 0 && wanted && JSON.stringify(settings) === JSON.stringify(reference), `world ${JSON.stringify(reference)}; added ${added.code === 0 ? JSON.stringify(settings) : `exit ${added.code}: ${added.err.trim().slice(-300)}`}`);
    const m2 = added.code === 0 ? attachWorld(name, scratchRoot).machine("m2") : null;
    const health = await m2?.health();
    const ps = m2 ? await m2.ps() : "";
    const runtime = (health?.["herdr"] as { runtime?: string } | undefined)?.runtime ?? "-";
    verdict("a core machine added to a world started without one: hc copied in, server healthy on herdr-core, stand-in running", "PASS",
      !hcBefore && existsSync(join(scratchRoot, name, "bin", "hc")) && health?.["ok"] === true && /hc serve/.test(ps) && /\bclaude\b/.test(ps), `hc before ${hcBefore}; health ok ${health?.["ok"]}, runtime ${runtime}`);
    // two add-machine processes at once: each takes an address of its own and world.json keeps both (the lock)
    const both = await Promise.all([add("m7:herdr:bare"), add("m8:herdr:bare")]);
    const recorded = (JSON.parse(readFileSync(join(scratchRoot, name, "world.json"), "utf8")) as { machines: { name: string; ip: string }[] }).machines.filter((machine) => machine.name === "m7" || machine.name === "m8");
    const ips = await Promise.all(["m7", "m8"].map((machine) => docker(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", `ovw-${name}-m_${machine}`]).catch(() => "none")));
    verdict("two add-machine at once: both start, on addresses of their own, and world.json records both", "PASS",
      both.every((ran) => ran.code === 0) && recorded.length === 2 && new Set(ips).size === 2 && recorded.every((machine) => ips.includes(machine.ip)),
      `exits ${both.map((ran) => ran.code).join(", ")}; containers at ${ips.join(", ")}; world.json ${recorded.map((machine) => `${machine.name} ${machine.ip}`).join(", ") || "neither"}`);
    const bare = await add("m5:core:bare");
    const m5 = bare.code === 0 ? attachWorld(name, scratchRoot).machine("m5") : null;
    const bareHealth = await m5?.health();
    verdict("the same core check on a core machine added with nothing started", "FAIL", bareHealth?.["ok"] === true && /hc serve/.test(m5 ? await m5.ps() : ""), `exit ${bare.code}, health ${bareHealth === null || bareHealth === undefined ? "none" : JSON.stringify(bareHealth).slice(0, 80)}`);
    // what add-machine did before: a plan rebuilt from defaults around the world's description
    const rebuilt = new World({ ...planFromArgs(["--name", name], { env: process.env, host: hostCpus(), repo: join(TOOL_DIR, "../.."), scratchRoot, hcBin: null }), scratchRoot }, attachWorld(name, scratchRoot).description);
    await rebuilt.addMachine({ name: "m4", engine: "herdr", start: "none" });
    const old = await machineSettings(`ovw-${name}-m_m4`);
    verdict("the same settings check on a machine added with a plan rebuilt from defaults", "FAIL", JSON.stringify(old) === JSON.stringify(reference), JSON.stringify(old));
  } finally {
    process.kill(owner.pid, "SIGTERM");
  }
  const took = await until(60_000, () => clean(name));
  verdict("the owner's TERM removes the world with every machine added to it", "PASS", took !== null, took === null ? `left: ${(await leftovers(name, join(scratchRoot, name))).join("; ")}` : `clean after ${took} ms`);
}

const evidence = process.env["OVIS_WORLD_EVIDENCE"] ?? join(scratchRoot, "evidence");
/** which run of `--repeat N` this is (1 when not repeated): parts that keep evidence keep one folder per run */
let round = 1;
const PROOFS: Record<string, () => Promise<void>> = { signin: () => signInProof({ verdict, say, scratchRoot, evidence, prefix: P, round }), member: () => memberProof({ verdict, say, scratchRoot, evidence, prefix: P, round }), devices: () => devicesProof(verdict, scratchRoot, evidence, P), realaccount: () => realAccountProof({ verdict, say, scratchRoot, evidence, prefix: P, round }, process.env["OVIS_ACCOUNT_REPO"] ?? join(homedir(), ".local/state/ovis-test-services/account-src/afa04d4")), machine: () => machineProof(verdict, scratchRoot, P), preset: () => presetProof(verdict, scratchRoot, P, process.env["OVIS_STANDINS"] ?? join(process.env["HOME"] ?? "", ".local/state/ovis-test-services/standins")), services: servicesProof, teardown: teardownProof, killpoints: killPointsProof, startpoints: startPointsProof, inflight: inFlightProof, gcmarker: gcMarkerProof, ttl: ttlProof, slot: slotProof, slot60: slot60Proof, sealed: sealedProof, two: twoWorldsProof, clash: clashProof, engines: enginesProof, addmachine: addMachineProof };
const { values } = parseArgs({ options: { only: { type: "string" }, repeat: { type: "string", default: "1" } } });
inSlot();
const chosen = values.only ? values.only.split(",") : Object.keys(PROOFS);
const rounds = Number(values.repeat);
if (!Number.isInteger(rounds) || rounds < 1) throw new Error(`--repeat ${values.repeat}: a count of runs`);
for (round = 1; round <= rounds; round++) {
  for (const name of chosen) {
    const proof = PROOFS[name];
    if (!proof) throw new Error(`no proof ${name}`);
    say(`== ${name}${rounds > 1 ? ` run ${round}/${rounds}` : ""} (worlds ${P}*)`);
    try { await proof(); } catch (error) { wrong++; say(`ERROR ${name}: ${(error as Error).message ?? error}\n${(error as Error).stack ?? ""}`); }
  }
}
const stray = await gc([scratchRoot]);
say(`gc after the proofs removed: ${stray.join(", ") || "nothing"}; scratch root ${existsSync(scratchRoot) ? "exists" : "absent"}`);
say(wrong === 0 ? "PROOF OK: every check gave its expected verdict" : `PROOF WRONG: ${wrong} check(s) did not`);
process.exitCode = wrong === 0 ? 0 : 1;

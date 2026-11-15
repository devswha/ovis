/**
 * The test world's pure rules (no docker, no files): names and labels, the CPU-set rule, the subnet choice, the
 * addresses inside a world, the big-world rule and the command line. Unit-tested in plan.test.ts, which runs in
 * `bun run check fast`; everything that needs docker is in the other files of this folder.
 */
import { parseArgs } from "node:util";
import { PlanError, PORTS } from "./constants.ts";
import { DEFAULT_ORIGINS, originsFrom, sitesFrom, type Origins, type SiteName } from "./origins.ts";
import { STAGING_ACCOUNT_SERVICE } from "../../server/relay/service.ts";
import { parsePreset, presetMachine, PRESET_NAME, standinUser, type Preset } from "./standins.ts";

export { PlanError, PORTS };

export type Engine = "herdr" | "core";
/** what a new machine starts: everything (engine, stand-in agent, Ovis server), only its engine, or nothing */
export type MachineStart = "all" | "engine" | "none";
export type AccountKind = "fake" | "real";
export type RelayLimits = "open" | "hosted";
export type PassMode = "off" | "grace" | "enforce";

export interface MachineSpec {
  readonly name: string;
  readonly engine: Engine;
  readonly start: MachineStart;
  /** a systemd system and user manager in the machine (the image ovis-world-systemd:local) */
  readonly systemd?: boolean;
  /** extra host folders, always read-only: `<host path>:<path in the machine>` (an older Ovis checkout, a kit) */
  readonly mounts?: readonly string[];
  /** the machine's user: the image's user renamed, with this PC's uid and gid (home /home/<name>), so files mounted from this PC are its own */
  readonly user?: string;
  readonly hostname?: string;
  /** B5: a stand-in this machine is (standins.ts), brought up by its steps instead of `start` */
  readonly preset?: Preset;
}

/** `--user od=ovisusr`, `--hostname od=true-form-desktop`: one value for one machine. */
export function machineValue(option: string, text: string, pattern: RegExp): [string, string] {
  const match = /^([a-z][a-z0-9-]*)=(.+)$/.exec(text);
  if (!match || !pattern.test(match[2]!)) throw new PlanError(`--${option} ${text}: <machine>=<value>`);
  return [match[1]!, match[2]!];
}

/** `--mount m1=/host/dir:/opt/ovis-0.4.22`: a read-only folder for one machine. */
export function mountSpec(text: string): [string, string] {
  const match = /^([a-z][a-z0-9-]*)=(\/[^:]+):(\/[^:]+)$/.exec(text);
  if (!match) throw new PlanError(`--mount ${text}: <machine>=<absolute host path>:<absolute path in the machine>`);
  return [match[1]!, `${match[2]}:${match[3]}`];
}

export interface WorldPlan {
  readonly name: string;
  readonly machines: readonly MachineSpec[];
  readonly account: AccountKind;
  /** the checkout whose relay, server and fake run (mounted read-only) */
  readonly repo: string;
  /** the account service's checkout for `account: "real"` */
  readonly accountRepo: string | null;
  readonly limits: RelayLimits;
  readonly passes: PassMode;
  readonly cpus: string;
  readonly memory: string;
  readonly ttlSeconds: number;
  readonly scratchRoot: string;
  /** opt-in: the world's network gets a route out (the default is sealed) */
  readonly outbound: boolean;
  /** a herdr binary to run instead of the image's (snapshot copied into the scratch folder) */
  readonly herdrBin: string | null;
  /** herdr-core's binary, needed by any machine on engine "core" */
  readonly hcBin: string | null;
  /** R13: the origins the world answers for (default: its own test names) and the folders behind app and kit */
  readonly origins: Origins;
  readonly sites: Readonly<Partial<Record<SiteName, string>>>;
  /** machines trust the test CA system-wide (curl, bun and node), not only through the server's NODE_EXTRA_CA_CERTS */
  readonly trustCa: boolean;
  /** B2: `name:passphrase` lines (mode 600): the person's sign-in page on either account service */
  readonly people: string | null;
  /** the checkout the app's built copy (`--site app=<dir>` with <dir>.json beside it) was built from (default: repo) */
  readonly appRepo: string | null;
}

/**
 * How a world gets a heavy slot of this PC. heavy-run.sh publishes no slot table (its bands are a bash array in the
 * script, and they changed from four slots to six and then eight), so a world takes the band the slot hands it: see slotBand.
 */
export const SLOT_CALL = "~/.ovis-toolchain/heavy-run.sh [-t SECONDS] -- <command>";
export const LABEL = "ovis.world";
export const PREFIX = "ovw";
/** the hosted relay's numbers the release names: 30 new connections a minute and 64 open sockets per address */
export const HOSTED_LIMITS = { perAddressPerMinute: 30, maxSocketsPerAddress: 64 } as const;
export const OPEN_LIMITS = { perAddressPerMinute: 100_000, globalPerMinute: 100_000, maxSocketsPerAddress: 4096, maxAddresses: 4096 } as const;
/** names the machines meet the world by; the TLS proxy answers for them inside the sealed network only */
export const HOSTS = { relay: "relay.world.test", account: "account.world.test", staging: new URL(STAGING_ACCOUNT_SERVICE).host } as const;

const WORLD_NAME = /^[a-z][a-z0-9-]{0,14}[a-z0-9]$/;
const MACHINE_NAME = /^[a-z][a-z0-9-]{0,14}[a-z0-9]$/;

export function checkWorldName(name: string): string {
  if (!WORLD_NAME.test(name)) throw new PlanError(`world name ${JSON.stringify(name)}: 2-16 of a-z 0-9 -, starting with a letter`);
  // M2's long-lived services carry the world label svc-<name>: no world may take such a name (down would remove them)
  if (name.startsWith("svc-")) throw new PlanError(`world name ${JSON.stringify(name)}: svc- names are M2's long-lived services' (bun scripts/world/cli.ts services ...)`);
  return name;
}

export function randomWorldName(random: () => number = Math.random): string {
  return `w${Math.floor(random() * 0xffffff).toString(16).padStart(6, "0")}`;
}

/**
 * Every docker object of a world is named `ovw-<world>-<part>`, so no other run's names can clash.
 * A part of the world's own (net, account, relay, tls) has no dash, so it is always the last word. A machine is
 * `ovw-<world>-m_<machine>`: names hold a-z 0-9 - only, so the `_` marks where the world's name ends and two worlds'
 * machines never share a name (world w with machine m-m1 against world w-m with m1, or w's machine account against w-m's account).
 */
export const objectName = (world: string, part: string) => `${PREFIX}-${world}-${part}`;
export const machineContainer = (world: string, machine: string) => objectName(world, `m_${machine}`);

/**
 * Whether a running docker command (one line of `pgrep -a`: pid, then its words) is one of this world's: it carries
 * the world's label as a word of its own (a create: `--label ovis.world=<world>`, and its owner's label too when an
 * owner is given), or it names one of the world's objects exactly (`names`: what docker lists for the world now).
 * A prefix never counts (world w1 is not w1-m), nor does a command that names nothing of the world (`docker events`).
 */
export function dockerCallOf(line: string, world: string, owner: string | null, names: ReadonlySet<string>): boolean {
  const words = line.trim().split(/\s+/).slice(1);
  const labelled = words.includes(`${LABEL}=${world}`) && (owner === null || words.includes(`${LABEL}.owner=${owner}`));
  return labelled || words.some((word) => names.has(word));
}

/** The CPUs of a list such as "116-127" or "112,114-115" (the kernel's and docker's form), sorted; refused when malformed. */
export function cpuSet(list: string): number[] {
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(list)) throw new PlanError(`CPU set ${JSON.stringify(list)}: a list such as 116-127`);
  const cpus = new Set<number>();
  for (const part of list.split(",")) {
    const [first, last = first] = part.split("-").map(Number) as [number, number?];
    if (first > last) throw new PlanError(`CPU set ${list}: ${part} runs backwards`);
    for (let cpu = first; cpu <= last; cpu++) cpus.add(cpu);
  }
  return [...cpus].sort((a, b) => a - b);
}

/** CPUs written as the kernel and docker write them: ranges joined by commas ([61, 62, 63, 125] is "61-63,125"). */
export function cpuList(cpus: readonly number[]): string {
  const sorted = [...new Set(cpus)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let at = 0; at < sorted.length;) {
    let end = at;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    parts.push(end === at ? `${sorted[at]}` : `${sorted[at]}-${sorted[end]}`);
    at = end + 1;
  }
  return parts.join(",");
}

/**
 * Whether a list is a slot's CPU set as heavy-run.sh and docker's --cpuset-cpus write it: ranges and single CPUs joined
 * by commas, each CPU once (parts that overlap are a list written by hand, refused), at least one CPU.
 */
export function wellFormedCpus(list: string): boolean {
  let cpus: number[];
  try { cpus = cpuSet(list); } catch { return false; }
  const named = list.split(",").reduce((count, part) => { const [first, last = first] = part.split("-").map(Number) as [number, number?]; return count + last - first + 1; }, 0);
  return cpus.length > 0 && named === cpus.length;
}
const wellFormed = wellFormedCpus;

/** Whether docker's read-back cpuset is exactly the set asked for (an empty read-back is an unpinned container). */
export const samePins = (asked: string, readBack: string) => readBack !== "" && cpuSet(asked).join(",") === cpuSet(readBack).join(",");

const ipv4 = (text: string) => text.split(".").reduce((value, part) => value * 256 + Number(part), 0);
function range(cidr: string): [number, number] {
  const [address = "", bits = "32"] = cidr.split("/");
  const size = 2 ** (32 - Number(bits));
  const start = Math.floor(ipv4(address) / size) * size;
  return [start, start + size - 1];
}
export const overlaps = (a: string, b: string) => { const [a0, a1] = range(a); const [b0, b1] = range(b); return a0 <= b1 && b0 <= a1; };

/** A free /24 out of 10.243.0.0/16, looked for from `start` on, never one that overlaps a subnet in use; null when all are taken. */
export function pickSubnet(used: readonly string[], start: number): string | null {
  for (let step = 0; step < 256; step++) {
    const candidate = `10.243.${(start + step) % 256}.0/24`;
    if (!used.some((cidr) => overlaps(cidr, candidate))) return candidate;
  }
  return null;
}

/** The fixed addresses inside a world's /24: the TLS proxy, the relay, the account service, then the machines from .100. */
export function addresses(subnet: string): { tls: string; relay: string; account: string; machine: (index: number) => string } {
  const base = subnet.split(".").slice(0, 3).join(".");
  return { tls: `${base}.10`, relay: `${base}.11`, account: `${base}.12`, machine: (index) => `${base}.${100 + index}` };
}

/** What this PC says about CPUs: the ones online (/sys/devices/system/cpu/online) and the ones this process may run on. */
export interface HostCpus { readonly online: string; readonly allowed: string }

/**
 * The band of the heavy slot this process runs in, or why there is none. heavy-run.sh sets OVIS_HEAVY_SLOT and
 * OVIS_HEAVY_CPUS and runs the command under `taskset -c <band>`, so the band is accepted only when it is a set of CPUs
 * online on this PC (one range, or since 2026-11-15 12:2x whole cores with their sibling threads such as 61-63,125-127),
 * never all of them (a slot is a part of the PC), AND exactly the set this process runs on: a forged or stale
 * OVIS_HEAVY_CPUS, or a process that left its slot's CPUs, is refused. A world never runs outside a slot.
 */
export function slotBand(env: Readonly<Record<string, string | undefined>>, host: HostCpus): { readonly band: string } | { readonly refused: string } {
  const band = env["OVIS_HEAVY_CPUS"];
  const slot = env["OVIS_HEAVY_SLOT"];
  if (band === undefined || slot === undefined || slot === "") return { refused: `a world runs only inside a heavy slot: ${SLOT_CALL}` };
  const online = new Set(cpuSet(host.online));
  if (!wellFormed(band) || !cpuSet(band).every((cpu) => online.has(cpu))) return { refused: `OVIS_HEAVY_CPUS=${band} is not a set of this PC's CPUs (${host.online}): run it as ${SLOT_CALL}` };
  if (cpuSet(band).length === online.size) return { refused: `OVIS_HEAVY_CPUS=${band} is every CPU of this PC, which no slot is: run it as ${SLOT_CALL}` };
  if (cpuSet(band).join(",") !== cpuSet(host.allowed).join(",")) return { refused: `OVIS_HEAVY_CPUS=${band} is not this slot's set: this process runs on CPUs ${host.allowed}; run it as ${SLOT_CALL}` };
  return { band };
}

/**
 * When the heavy slot this process runs in ends (epoch seconds): heavy-run.sh exports OVIS_HEAVY_DEADLINE, the moment
 * its `timeout` ends the slot's process group (the command's start plus its -t, at most 1800 s). A world takes it as
 * its deadline at the latest, also for the containers' own `timeout`; without it a world refuses to start.
 */
export function slotDeadline(env: Readonly<Record<string, string | undefined>>, now: number = Date.now() / 1000): number {
  const text = env["OVIS_HEAVY_DEADLINE"];
  if (text === undefined || !/^\d+$/.test(text)) throw new PlanError(`OVIS_HEAVY_DEADLINE is ${text === undefined ? "not set" : `not epoch seconds (${text})`}: a world ends with its slot and must know when; run it as ${SLOT_CALL} (heavy-run.sh exports it since 2026-11-15 05:41)`);
  if (Number(text) <= now) throw new PlanError(`OVIS_HEAVY_DEADLINE=${text} has passed: this slot is over`);
  return Number(text);
}

/** `m1:herdr`, `m2:core`, `m3:herdr:bare` (nothing started), `m4:core:engine` (only the engine), `m5:herdr:all:systemd`. */
export function machineSpec(text: string): MachineSpec {
  const [name = "", engine = "", start = "all", flag, extra] = text.split(":");
  if (!MACHINE_NAME.test(name) || extra !== undefined || (flag !== undefined && flag !== "systemd")) throw new PlanError(`machine ${JSON.stringify(text)}: <name>:<herdr|core>[:all|engine|bare[:systemd]]`);
  if (engine !== "herdr" && engine !== "core") throw new PlanError(`machine ${text}: the engine is herdr or core`);
  const starts: Record<string, MachineStart> = { all: "all", engine: "engine", bare: "none" };
  const chosen = starts[start];
  if (chosen === undefined) throw new PlanError(`machine ${text}: start all, engine or bare`);
  return { name, engine, start: chosen, ...(flag === "systemd" ? { systemd: true } : {}) };
}

export interface Defaults { readonly repo: string; readonly scratchRoot: string; readonly hcBin: string | null; readonly env: Readonly<Record<string, string | undefined>>; readonly host: HostCpus; readonly standins?: string; readonly random?: () => number }

function oneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  const found = allowed.find((option) => option === value);
  if (found === undefined) throw new PlanError(`${what} is one of ${allowed.join(", ")} (got ${value})`);
  return found;
}

/** The world's options from command-line arguments (after the subcommand), checked whole. */
export function planFromArgs(args: readonly string[], defaults: Defaults): WorldPlan {
  const { values } = parseArgs({
    args: [...args], allowPositionals: false, strict: true,
    options: {
      name: { type: "string" }, machine: { type: "string", multiple: true }, repo: { type: "string" },
      account: { type: "string", default: "fake" }, "account-repo": { type: "string" },
      limits: { type: "string", default: "open" }, passes: { type: "string", default: "off" },
      cpus: { type: "string" }, memory: { type: "string" },
      ttl: { type: "string", default: "3600" }, "scratch-root": { type: "string" }, outbound: { type: "boolean", default: false },
      "herdr-bin": { type: "string" }, "hc-bin": { type: "string" },
      origin: { type: "string", multiple: true }, mount: { type: "string", multiple: true }, user: { type: "string", multiple: true }, hostname: { type: "string", multiple: true }, preset: { type: "string", multiple: true }, site: { type: "string", multiple: true }, "trust-ca": { type: "boolean", default: false }, people: { type: "string" }, "app-repo": { type: "string" },
    },
  });
  const slot = slotBand(defaults.env, defaults.host);
  if ("refused" in slot) throw new PlanError(slot.refused);
  if (values.cpus !== undefined && values.cpus !== slot.band) throw new PlanError(`--cpus ${values.cpus}: a world takes its slot's band, ${slot.band}`);
  const origins = originsFrom(values.origin ?? []);
  const presets = (values.preset ?? []).map(parsePreset).map(([name, preset]) => presetMachine(name, preset, defaults.standins ?? defaults.env["OVIS_STANDINS"] ?? "", standinUser(defaults.env)));
  if (presets.length > 0 && !(defaults.standins ?? defaults.env["OVIS_STANDINS"])) throw new PlanError("--preset needs the stand-ins' artifacts folder (OVIS_STANDINS)");
  if (presets.length > 0 && values["herdr-bin"] !== undefined && values["herdr-bin"] !== presets[0]!.herdrBin) throw new PlanError(`--preset ${PRESET_NAME} brings its own herdr 0.9.5: leave out --herdr-bin`);
  const names = new Set([...(values.machine ?? []).map((text) => text.split(":")[0]), ...presets.map((entry) => entry.spec.name)]);
  const users = (values.user ?? []).map((text) => machineValue("user", text, /^[a-z][a-z0-9_-]{0,30}$/));
  const hostnames = (values.hostname ?? []).map((text) => machineValue("hostname", text, /^[a-z0-9][a-z0-9-]{0,62}$/));
  for (const [owner] of [...(values.mount ?? []).map(mountSpec), ...users, ...hostnames]) if (!names.has(owner)) throw new PlanError(`a per-machine option names machine ${owner}, which no --machine starts`);
  return checkPlan({
    origins, sites: sitesFrom(values.site ?? [], origins), trustCa: values["trust-ca"], people: values.people ?? null, appRepo: values["app-repo"] ?? null,
    name: values.name ?? randomWorldName(defaults.random),
    machines: [...(values.machine ?? []).map(machineSpec), ...presets.map((entry) => entry.spec)].map((machine) => {
      const mounts = (values.mount ?? []).map(mountSpec).filter(([owner]) => owner === machine.name).map(([, mount]) => mount);
      const user = users.find(([owner]) => owner === machine.name)?.[1];
      const hostname = hostnames.find(([owner]) => owner === machine.name)?.[1];
      return { ...machine, ...(mounts.length > 0 ? { mounts } : {}), ...(user ? { user } : {}), ...(hostname ? { hostname } : {}) };
    }),
    account: oneOf(values.account, ["fake", "real"], "--account"),
    repo: values.repo ?? defaults.repo,
    accountRepo: values["account-repo"] ?? null,
    limits: oneOf(values.limits, ["open", "hosted"], "--limits"),
    passes: oneOf(values.passes, ["off", "grace", "enforce"], "--passes"),
    // the 0.5.1 form builds a release in the machine (install, typecheck, build): 2g is not enough for it
    cpus: slot.band, memory: values.memory ?? (presets.some((entry) => entry.spec.preset?.version === "0.5.1") ? "4g" : "2g"), ttlSeconds: Number(values.ttl),
    scratchRoot: values["scratch-root"] ?? defaults.scratchRoot, outbound: values.outbound,
    herdrBin: values["herdr-bin"] ?? presets[0]?.herdrBin ?? null, hcBin: values["hc-bin"] ?? defaults.hcBin,
  });
}

/** Where a world keeps the plan it was started with (in its scratch folder): add-machine reads it, never a plan rebuilt from defaults. */
export const PLAN_FILE = "plan.json";

/** The plan a world saved at its start (PLAN_FILE), checked whole again. */
export function savedPlan(text: string): WorldPlan { return checkPlan(JSON.parse(text) as WorldPlan); }

/** Why a process on the slot band `current` may not add to a world pinned to `saved`, or null: a world's containers all stay on one band. */
export function bandRefusal(current: string, saved: string): string | null {
  if (current === saved || (wellFormed(current) && wellFormed(saved) && cpuSet(current).join(",") === cpuSet(saved).join(","))) return null;
  return `this process holds the slot band ${current}, the world is pinned to ${saved}: add machines from inside the world's own slot (the command its run starts, or a process beside its up in that slot)`;
}

/** Refuses a plan whose parts cannot work together; returns it unchanged otherwise. */
export function checkPlan(plan: WorldPlan): WorldPlan {
  checkWorldName(plan.name);
  if (!wellFormed(plan.cpus)) throw new PlanError(`CPU set ${plan.cpus}: a world is pinned to exactly one slot's band, a set such as 61-63,125-127`);
  if (!/^\d+[mg]$/.test(plan.memory)) throw new PlanError(`memory ${plan.memory}: a docker size such as 2g`);
  if (!Number.isInteger(plan.ttlSeconds) || plan.ttlSeconds < 60 || plan.ttlSeconds > 24 * 3600) throw new PlanError("--ttl is 60 to 86400 seconds");
  const names = plan.machines.map((machine) => machine.name);
  if (new Set(names).size !== names.length) throw new PlanError(`machine names repeat: ${names.join(", ")}`);
  if (plan.machines.length > 150) throw new PlanError("at most 150 machines: the /24 has room from .100 to .249");
  if (plan.account === "real" && plan.accountRepo === null) throw new PlanError("--account real needs --account-repo <checkout of ovis-sh/account>");
  if (plan.account === "fake" && plan.accountRepo !== null) throw new PlanError("--account-repo is for --account real");
  if (plan.passes !== "off" && plan.origins.account.url !== DEFAULT_ORIGINS.account.url) throw new PlanError("--passes needs the world's own account origin: a server asks a relay of its own for no pass unless the account service is Ovis's staging one");
  if (plan.machines.some((machine) => machine.engine === "core") && plan.hcBin === null) throw new PlanError("a machine on herdr-core needs --hc-bin <herdr-core binary>");
  return plan;
}

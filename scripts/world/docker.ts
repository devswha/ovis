/**
 * The test world's docker calls: every container is started pinned, labelled and with a lifetime of its own, and its
 * pin is read back; a world's objects are found and removed by its label alone.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL, dockerCallOf, samePins, type HostCpus } from "./plan.ts";

export class DockerError extends Error {
  constructor(readonly args: readonly string[], readonly code: number, readonly output: string) {
    super(`docker ${args.slice(0, 3).join(" ")} … exited ${code}: ${output.trim().slice(-600)}`);
    this.name = "DockerError";
  }
}

export interface Ran { readonly code: number; readonly out: string; readonly err: string }

export async function run(argv: readonly string[], input?: string): Promise<Ran> {
  const child = Bun.spawn([...argv], { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

export async function docker(args: readonly string[], input?: string): Promise<string> {
  const ran = await run(["docker", ...args], input);
  if (ran.code !== 0) throw new DockerError(args, ran.code, ran.err + ran.out);
  return ran.out.trim();
}

export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly network: string;
  readonly ip?: string;
  readonly cpus: string;
  readonly memory: string;
  readonly labels: Readonly<Record<string, string>>;
  /** epoch seconds: the container's own first process ends then, whatever happens to the tool */
  readonly deadline: number | null;
  readonly command: readonly string[];
  readonly mounts?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Environment the container gets whose values never appear on a command line (any local user reads a process's
   * /proc/<pid>/cmdline): handed over in a 0600 env file (withEnvFile).
   */
  readonly secrets?: Readonly<Record<string, string>>;
  readonly extra?: readonly string[];
  /** docker's tini as the first process (default); false for a container whose first process is systemd */
  readonly init?: boolean;
}

/** The command under a lifetime: `timeout -s KILL <seconds left>` from the container's own clock, so a restart never extends it. */
export function underDeadline(deadline: number, command: readonly string[]): string[] {
  return ["sh", "-c", 'left=$(( $0 - $(date +%s) )); [ "$left" -gt 0 ] || exit 0; exec timeout -s KILL "$left" "$@"', String(deadline), ...command];
}

export async function startContainer(spec: ContainerSpec): Promise<string> {
  return withEnvFile(spec.secrets ?? {}, (envFlag) => startWith(spec, envFlag));
}

/**
 * Gives `use` the flags (`--env-file <file>`, or none for an empty `env`) that hand `env` to a docker run or exec: the
 * file is 0600 in a fresh 0700 folder and removed once `use` is done, so the values reach the container and nothing
 * else: no command line (any local user reads those), and not docker's own environment, where names such as PATH or
 * DOCKER_HOST would steer docker itself. A value with a line break cannot go in an env file and is refused.
 */
export async function withEnvFile<T>(env: Readonly<Record<string, string>>, use: (flags: string[]) => Promise<T>): Promise<T> {
  const entries = Object.entries(env);
  if (entries.length === 0) return use([]);
  for (const [key, value] of entries) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) throw new Error(`environment ${key}: a name of letters, digits and _, and a value on one line`);
  const dir = mkdtempSync(join(tmpdir(), "world-env-"));
  try {
    writeFileSync(join(dir, "env"), entries.map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
    return await use(["--env-file", join(dir, "env")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function startWith(spec: ContainerSpec, envFlag: readonly string[]): Promise<string> {
  const args = ["run", "-d", ...(spec.init === false ? [] : ["--init"]), "--name", spec.name, "--network", spec.network, ...(spec.ip ? ["--ip", spec.ip] : []),
    `--cpuset-cpus=${spec.cpus}`, `--memory=${spec.memory}`, "--stop-timeout", "2",
    ...Object.entries(spec.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    ...(spec.mounts ?? []).flatMap((mount) => ["-v", mount]),
    ...Object.entries(spec.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    ...envFlag,
    ...(spec.extra ?? []),
    "--entrypoint", spec.deadline === null ? spec.command[0]! : "sh",
    spec.image,
    ...(spec.deadline === null ? spec.command.slice(1) : underDeadline(spec.deadline, spec.command).slice(1))];
  const id = await docker(args);
  const pins = await readPins(spec.name);
  if (!samePins(spec.cpus, pins.cpus)) {
    await docker(["rm", "-f", spec.name]);
    throw new Error(`${spec.name}: asked for CPUs ${spec.cpus}, docker reads back "${pins.cpus}"; removed`);
  }
  return id;
}

export interface Pins { readonly name: string; readonly cpus: string; readonly memory: number }

export async function readPins(container: string): Promise<Pins> {
  const [cpus = "", memory = "0"] = (await docker(["inspect", "-f", "{{.HostConfig.CpusetCpus}} {{.HostConfig.Memory}}", container])).split(" ");
  return { name: container, cpus, memory: Number(memory) };
}

/** Every container of a world whose pin is not the world's set or that has no memory cap: empty when all hold. */
export async function unpinned(world: string, cpus: string): Promise<Pins[]> {
  const pins = await Promise.all((await containers(world)).map(readPins));
  return pins.filter((pin) => !samePins(cpus, pin.cpus) || pin.memory <= 0);
}

const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);

/** docker's filters for a world's objects: by its name, and by its owner too when one is given (`<pid>:<start>`). */
const owned = (world: string, owner: string | null) => ["--filter", `label=${LABEL}=${world}`, ...(owner === null ? [] : ["--filter", `label=${LABEL}.owner=${owner}`])];

export async function containers(world: string, all = true, owner: string | null = null): Promise<string[]> {
  return lines(await docker(["ps", ...(all ? ["-a"] : []), ...owned(world, owner), "--format", "{{.Names}}"]));
}

export async function networks(world: string, owner: string | null = null): Promise<string[]> {
  return lines(await docker(["network", "ls", ...owned(world, owner), "--format", "{{.Name}}"]));
}

/**
 * Removes every container and network of a world (idempotent) and throws when one is left; the scratch folder is the
 * caller's. What docker answers to a removal is no verdict: "No such container" and "removal ... is already in
 * progress" mean another remover was first, and a network that still holds a container goes at the next try. Only
 * what is left afterwards decides, so a caller that tries again (the reaper) needs to know none of docker's words.
 * With an owner, only that owner's objects: a failed start of a second world of the same name (from another scratch
 * root) never takes the first one's.
 */
export async function removeObjects(world: string, owner: string | null = null): Promise<void> {
  const said: string[] = [];
  const found = await containers(world, true, owner);
  if (found.length > 0) said.push((await run(["docker", "rm", "-f", "-v", ...found])).err);
  for (const network of await networks(world, owner)) said.push((await run(["docker", "network", "rm", network])).err);
  const left = [...(await containers(world, true, owner)).map((name) => `container ${name}`), ...(await networks(world, owner)).map((name) => `network ${name}`)];
  if (left.length > 0) throw new Error(`world ${world}: left ${left.join(", ")}; docker said: ${said.join(" ").replace(/\s+/g, " ").trim().slice(-600) || "nothing"}`);
}

/**
 * docker commands on this PC that are this world's and still running (dockerCallOf: its label, or one of its objects
 * by exact name): a start cut short by a signal leaves its call in flight, and what it makes lands after its owner is
 * gone. Nobody ends a world's reaper while one runs, and the reaper removes again after they end.
 */
export async function dockerInFlight(world: string, owner: string | null = null): Promise<string[]> {
  const names = new Set([...await containers(world, true, owner), ...await networks(world, owner)]);
  return lines((await run(["pgrep", "-af", "(^|/)docker( |$)"])).out).filter((line) => dockerCallOf(line, world, owner, names));
}

/**
 * `docker network inspect` of networks listed a moment ago, one line per network: one removed in between (any other
 * run's teardown, on this busy PC) is skipped, not an error; docker still prints the others.
 */
async function inspectNetworks(format: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const args = ["network", "inspect", "-f", format, ...ids];
  const ran = await run(["docker", ...args]);
  const errors = lines(ran.err).filter((line) => !/^Error( response from daemon)?: (network \S+ not found|No such network: \S+)$/i.test(line));
  if (ran.code !== 0 && errors.length > 0) throw new DockerError(args, ran.code, ran.err + ran.out);
  return lines(ran.out);
}

/** The subnets docker networks and the host's routes already use. */
export async function usedSubnets(): Promise<string[]> {
  const ids = lines(await docker(["network", "ls", "-q"]));
  const fromDocker = (await inspectNetworks("{{range .IPAM.Config}}{{.Subnet}} {{end}}", ids)).flatMap((line) => line.split(" ")).filter((cidr) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr));
  const routes = (await run(["ip", "-4", "route"])).out;
  const fromRoutes = lines(routes).map((line) => line.split(" ")[0] ?? "").filter((cidr) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr));
  return [...fromDocker, ...fromRoutes];
}

/** The labels of every world on this PC, one entry per world, read from its networks. */
export async function worldLabels(): Promise<Record<string, string>[]> {
  const ids = lines(await docker(["network", "ls", "-q", "--filter", `label=${LABEL}`]));
  return (await inspectNetworks("{{json .Labels}}", ids)).map((line) => JSON.parse(line) as Record<string, string>);
}

/** Names of worlds that still have a container but no network (a network removed by hand): gc takes them too. */
export async function containerWorlds(): Promise<string[]> {
  return [...new Set(lines(await docker(["ps", "-a", "--filter", `label=${LABEL}`, "--format", `{{.Label "${LABEL}"}}`])))];
}

/** This PC's online CPUs and the ones this process may run on (heavy-run.sh's taskset): what slotBand checks a band against. */
export function hostCpus(): HostCpus {
  const online = readFileSync("/sys/devices/system/cpu/online", "utf8").trim();
  const allowed = /^Cpus_allowed_list:\s*(\S+)$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? "";
  return { online, allowed };
}

/** `<pid>:<start>`: a process's id and its start time in clock ticks, so a reused pid is not taken for the owner. */
export function processIdentity(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return start === undefined ? null : `${pid}:${start}`;
  } catch {
    return null;
  }
}

export function alive(identity: string): boolean {
  const pid = Number(identity.split(":")[0]);
  return Number.isInteger(pid) && pid > 0 && processIdentity(pid) === identity;
}

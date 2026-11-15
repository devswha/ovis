/**
 * The test world for scripts of every session: `await using world = await startWorld({ machines: [...] })` gives a
 * relay, an account service and machines on either engine in a sealed docker network of its own, pinned to the band
 * of the heavy slot it runs in, removed on dispose. A world also ends without its owner: a reaper outside the owner's process group removes
 * it when the owner is gone, every container ends by itself at the world's deadline, and `gc` sweeps the rest.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { makeCerts } from "./certs.ts";
import { containers, hostCpus, networks, processIdentity } from "./docker.ts";
import { Machine, type MachineDescription } from "./machines.ts";
import { DEFAULT_ORIGINS, originsFrom, proxyNames, sitesFrom } from "./origins.ts";
import { LABEL, PLAN_FILE, PlanError, addresses, bandRefusal, checkPlan, randomWorldName, savedPlan, slotBand, slotDeadline, type MachineSpec, type WorldPlan } from "./plan.ts";
import { TOOL_DIR, createNetwork, extraHosts, serverOrigins, startMachine, startServices, type Staged } from "./stage.ts";
import { forgetOnSignals, removeWorld, startReaper, teardownOnSignals } from "./teardown.ts";

export { TOOL_DIR };
export const DEFAULT_SCRATCH_ROOT = join(homedir(), ".cache/ovis-tmp/world");
const DEFAULT_HC = join(homedir(), ".local/bin/herdr-core");

export interface WorldDescription {
  readonly name: string;
  readonly network: string;
  readonly subnet: string;
  readonly sealed: boolean;
  readonly scratch: string;
  /** the test CA every machine trusts (NODE_EXTRA_CA_CERTS); a device or script that talks TLS to the proxy needs it */
  readonly ca: string;
  /** epoch seconds: no container of the world runs past it */
  readonly expires: number;
  readonly owner: string;
  /** what the machines' servers are pointed at (WORLD_RELAY_URL, WORLD_ACCOUNT_URL, WORLD_APP_URL) */
  readonly origins: Readonly<Record<string, string>>;
  readonly relay: { readonly url: string; readonly address: string; readonly limits: string; readonly passes: string };
  readonly account: { readonly url: string; readonly address: string; readonly kind: string };
  /** the world's control API (the account service's): on the world's network, so this PC and the world's machines both reach it; never point a machine's server at it */
  readonly control: string;
  /** the app's build record (<dir>.json) when the app's site is a verified built copy, else null */
  readonly app?: Record<string, unknown> | null;
  /** the TLS proxy's address: every origin of the world resolves to it inside the network */
  readonly tls: string;
  readonly machines: readonly MachineDescription[];
}

export type WorldOptions = Partial<Omit<WorldPlan, "machines" | "origins" | "sites">> & {
  readonly machines?: readonly (MachineSpec | string)[];
  /** `relay=wss://host:port`, `account=https://…`, `app=…`, `kit=…` (R13) */
  readonly origins?: readonly string[];
  /** `app=<folder>`, `kit=<folder>`: what those origins serve */
  readonly sites?: readonly string[];
};

/** The band of the heavy slot this process holds; refused outside one (B8: every world runs in a slot). */
export function inSlot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const slot = slotBand(env, hostCpus());
  if ("refused" in slot) throw new PlanError(slot.refused);
  return slot.band;
}

/** A people file holds passphrases: it must exist, be this user's and be readable by nobody else (mode 600). */
export function checkPeopleFile(file: string): void {
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new PlanError(`people file ${file}: not a file`);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new PlanError(`people file ${file}: must be yours and readable by you only (chmod 600)`);
}

export function worldPlan(options: WorldOptions = {}): WorldPlan {
  const machines = (options.machines ?? []).map((machine, index) => typeof machine === "string" ? { name: `m${index + 1}`, engine: machine === "core" ? "core" as const : "herdr" as const, start: "all" as const } : machine);
  const origins = options.origins ? originsFrom(options.origins) : DEFAULT_ORIGINS;
  return checkPlan({
    name: options.name ?? randomWorldName(), machines, account: options.account ?? "fake",
    repo: resolve(options.repo ?? join(TOOL_DIR, "../..")), accountRepo: options.accountRepo ?? null,
    limits: options.limits ?? "open", passes: options.passes ?? "off", cpus: options.cpus ?? inSlot(), memory: options.memory ?? "2g",
    ttlSeconds: options.ttlSeconds ?? 3600, scratchRoot: options.scratchRoot ?? DEFAULT_SCRATCH_ROOT, outbound: options.outbound ?? false,
    herdrBin: options.herdrBin ?? null, hcBin: options.hcBin ?? (existsSync(DEFAULT_HC) ? DEFAULT_HC : null),
    origins, sites: sitesFrom(options.sites ?? [], origins), trustCa: options.trustCa ?? false, people: options.people ?? null, appRepo: options.appRepo ?? null,
  });
}

/** What every process can do with a world, its owner or not: machines and the account service's control API. */
export class WorldHandle {
  constructor(protected current: WorldDescription) {}

  get description(): WorldDescription { return this.current; }
  get name(): string { return this.current.name; }

  machine(name: string): Machine {
    const found = this.current.machines.find((machine) => machine.name === name);
    if (!found) throw new Error(`world ${this.name} has no machine ${name}`);
    return new Machine(found);
  }

  get machines(): Machine[] { return this.current.machines.map((machine) => new Machine(machine)); }

  /** A call to the account service's control API (the fake's methods by `call`; `token` on either kind). */
  async control<T>(path: string, body?: unknown): Promise<T> {
    const answer = await fetch(`${this.current.control}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await answer.json() as T & { error?: string };
    if (!answer.ok) throw new Error(`control ${path}: ${answer.status} ${value.error ?? ""}`);
    return value;
  }

  /** Any method of the repository's fake account service, by name: a new method on a branch needs no change here. */
  async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> { return (await this.control<{ result: T }>("/call", { method, args })).result; }
  async token(account: string): Promise<string> { return (await this.control<{ token: string }>("/token", { account })).token; }
}

/** The world its own process started: it also adds machines and removes the world. */
export class World extends WorldHandle implements AsyncDisposable {
  private ending: Promise<void> | null = null;
  private creating: Promise<unknown> | null = null;
  private cancelled = false;

  constructor(readonly plan: WorldPlan, description: WorldDescription) { super(description); }

  /** Throws once the world's start is called off: the start checks it before each docker object it makes. */
  readonly live = (): void => { if (this.cancelled) throw new Error(`the start of world ${this.name} was called off: its owner is removing it`); };

  /** The part of the start that makes docker objects: a teardown during it waits for it (bounded) before removing. */
  track<T>(creating: Promise<T>): Promise<T> { this.creating = creating; return creating; }

  describe(description: WorldDescription): void { this.current = description; }

  async addMachine(spec: MachineSpec): Promise<Machine> {
    const refusal = bandRefusal(inSlot(), this.plan.cpus);
    if (refusal) throw new PlanError(refusal);
    if (this.current.machines.some((machine) => machine.name === spec.name)) throw new Error(`machine ${spec.name} exists`);
    // a world started without a core machine has no hc in its bin folder yet (every machine mounts that folder)
    const hc = join(this.current.scratch, "bin", "hc");
    if (spec.engine === "core" && !existsSync(hc)) {
      if (this.plan.hcBin === null) throw new PlanError("a machine on herdr-core needs herdr-core's binary: the world was started without --hc-bin, and none was found then");
      copyFileSync(this.plan.hcBin, hc);
    }
    // two add-machine at once (two processes, or the owner and a script) must not take the same address or lose each
    // other's machine in world.json: the pick, the start and the record happen under one lock, on world.json as it is now
    const file = join(this.current.scratch, "world.json");
    const description = await withLock(join(this.current.scratch, "add-machine.lock"), async () => {
      this.current = { ...this.current, machines: (JSON.parse(readFileSync(file, "utf8")) as WorldDescription).machines };
      if (this.current.machines.some((machine) => machine.name === spec.name)) throw new Error(`machine ${spec.name} exists`);
      const used = new Set(this.current.machines.map((machine) => machine.ip));
      let index = 0;
      while (used.has(addresses(this.current.subnet).machine(index))) index++;
      const started = await startMachine(this.plan, this.current, spec, index);
      this.current = { ...this.current, machines: [...this.current.machines, started] };
      writeFileSync(file, JSON.stringify(this.current, null, 2));
      return started;
    });
    const machine = new Machine(description);
    await machine.bringUp();
    return machine;
  }

  /**
   * Removes everything the world made (containers, network, scratch folder, reaper); idempotent, and a second call
   * waits for the first. During the start it calls the start off and gives the docker call in flight a few seconds to
   * land; one that takes longer is the reaper's, which nobody ends while it runs (removeWorld).
   */
  teardown(): Promise<void> {
    this.ending ??= (async () => {
      forgetOnSignals(this);
      this.cancelled = true;
      if (this.creating) await Promise.race([this.creating.catch(() => {}), Bun.sleep(START_GRACE_MS)]);
      await removeWorld(this.name, this.current.scratch, this.current.owner);
    })();
    return this.ending;
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.teardown(); }
}

/**
 * The app's built copy: when <dir>.json lies beside the site's folder, `bun scripts/shell-build.ts --verify <dir>` in
 * the checkout it was built from must pass, and the world serves it with that checkout's own pages server.
 */
async function verifyAppBuild(plan: WorldPlan): Promise<Record<string, unknown> | null> {
  const dir = plan.sites.app;
  if (dir === undefined || !existsSync(`${dir}.json`)) return null;
  const repo = plan.appRepo ?? plan.repo;
  // awaited, not spawnSync: a TERM to the owner while it runs is handled at once
  const child = Bun.spawn(["bun", "scripts/shell-build.ts", "--verify", resolve(dir)], { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new PlanError(`the app's built copy ${dir} does not verify: ${(out + err).trim().slice(-300)}`);
  return { ...JSON.parse(readFileSync(`${dir}.json`, "utf8")) as Record<string, unknown>, verified: out.trim(), checkout: repo };
}

/**
 * Runs `work` while this process holds an exclusive lock on `file`: flock(1) takes it (at most 5 minutes of waiting)
 * and keeps it until `work` ends; the kernel lets it go if this process dies, so no lock is ever left behind.
 */
async function withLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const holder = Bun.spawn(["flock", "-x", "-w", "300", file, "sh", "-c", "echo held; exec cat"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const said = await holder.stdout.getReader().read();
  if (said.done) throw new Error(`${file}: not locked within 300 s (${(await new Response(holder.stderr).text()).trim()})`);
  try {
    return await work();
  } finally {
    await holder.stdin.end();
    await holder.exited;
  }
}

export async function startWorld(options: WorldOptions = {}): Promise<World> { return startPlannedWorld(worldPlan(options)); }

/** How long a teardown during the start waits for the docker call in flight before it removes what is there. */
const START_GRACE_MS = 3000;

export async function startPlannedWorld(plan: WorldPlan): Promise<World> {
  if (inSlot() !== plan.cpus) throw new PlanError(`this process holds the slot band ${inSlot()}, the plan asks for ${plan.cpus}`);
  if (plan.people !== null) checkPeopleFile(plan.people);
  for (const machine of plan.machines) for (const mount of machine.mounts ?? []) if (!existsSync(mount.split(":")[0]!)) throw new PlanError(`machine ${machine.name}: ${mount.split(":")[0]} does not exist`);
  if (!existsSync(join(plan.repo, "node_modules"))) throw new Error(`${plan.repo} has no node_modules: run bun install there first (the world runs it read-only and sealed)`);
  const owner = processIdentity(process.pid)!;
  // the slot ends its whole process group at OVIS_HEAVY_DEADLINE: the world, and each container's own timeout, never outlive it
  const expires = Math.min(Math.floor(Date.now() / 1000) + plan.ttlSeconds, slotDeadline(process.env));
  const scratch = join(plan.scratchRoot, plan.name);
  if (existsSync(scratch)) throw new Error(`${scratch} exists: a world of that name is running or was left (bun scripts/world/cli.ts gc)`);
  // another scratch root may hold a live world of this name: its objects are on docker, never this start's to touch
  const named = [...await containers(plan.name), ...await networks(plan.name)];
  if (named.length > 0) throw new PlanError(`world ${plan.name} exists already on docker (${named.slice(0, 3).join(", ")}), perhaps from another scratch root: choose another --name`);
  mkdirSync(join(scratch, "bin"), { recursive: true, mode: 0o755 });
  writeFileSync(join(scratch, "owner.json"), JSON.stringify({ name: plan.name, owner, expires, scratch }));
  writeFileSync(join(scratch, PLAN_FILE), JSON.stringify(plan, null, 2));
  const world = new World(plan, { name: plan.name, network: "", subnet: "", sealed: !plan.outbound, scratch, ca: "", expires, owner, origins: serverOrigins(plan),
    relay: { url: plan.origins.relay.url, address: "", limits: plan.limits, passes: plan.passes }, account: { url: serverOrigins(plan)["WORLD_ACCOUNT_URL"]!, address: "", kind: plan.account }, control: "", tls: "", machines: [] });
  teardownOnSignals(world);
  try {
    await startReaper({ name: plan.name, owner, expires, scratch });
    const binaries = [[plan.herdrBin, "herdr"], [plan.machines.some((machine) => machine.engine === "core") ? plan.hcBin : null, "hc"]] as const;
    for (const [file, name] of binaries) if (file) copyFileSync(file, join(scratch, "bin", name));
    const { network, subnet, ca, control, machines, app } = await world.track((async () => {
      world.live();
      const { network, subnet } = await createNetwork(plan, { [LABEL]: plan.name, [`${LABEL}.owner`]: owner, [`${LABEL}.expires`]: String(expires), [`${LABEL}.scratch`]: scratch });
      const ca = makeCerts(join(scratch, "certs"), proxyNames(plan.origins, extraHosts(plan)));
      const app = await verifyAppBuild(plan);
      world.live();
      const staged: Staged = { network, subnet, scratch, ca, expires, owner, live: world.live, verifiedApp: app !== null };
      const control = await startServices(plan, staged);
      const machines = await Promise.all(plan.machines.map((spec, index) => startMachine(plan, staged, spec, index)));
      return { network, subnet, ca, control, machines, app };
    })());
    const at = addresses(subnet);
    world.describe({ ...world.description, network, subnet, ca, control, tls: at.tls, machines, app,
      relay: { ...world.description.relay, address: `ws://${at.relay}:8787` }, account: { ...world.description.account, address: `http://${at.account}:9080` } });
    writeFileSync(join(scratch, "world.json"), JSON.stringify(world.description, null, 2));
    await Promise.all(world.machines.map((machine) => machine.bringUp()));
    return world;
  } catch (error) {
    await world.teardown();
    throw error;
  }
}

/** A world another process owns (its `up`, or the `run` around this command), from its world.json: everything but ownership. */
export function attachWorld(name: string = process.env["OVIS_WORLD"] ?? "", scratchRoot: string = process.env["OVIS_WORLD_SCRATCH"] ?? DEFAULT_SCRATCH_ROOT): WorldHandle {
  const file = process.env["OVIS_WORLD_FILE"] && name === process.env["OVIS_WORLD"] ? process.env["OVIS_WORLD_FILE"] : join(scratchRoot, name, "world.json");
  return new WorldHandle(JSON.parse(readFileSync(file, "utf8")) as WorldDescription);
}

/**
 * A running world as add-machine sees it: its description and the plan it was started with (plan.json in its scratch
 * folder), so a machine added later gets the world's origins, passes, repo, CA trust, memory and CPU band.
 */
export function savedWorld(name: string, scratchRoot: string = process.env["OVIS_WORLD_SCRATCH"] ?? DEFAULT_SCRATCH_ROOT): World {
  const file = join(scratchRoot, name, PLAN_FILE);
  if (!existsSync(file)) throw new PlanError(`${file} is missing: world ${name} is not running here, or was started by a tool that saved no plan`);
  return new World(savedPlan(readFileSync(file, "utf8")), attachWorld(name, scratchRoot).description);
}

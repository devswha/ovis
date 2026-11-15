/**
 * How a world is put on docker: its network (a free /24, internal unless outbound was asked for), the account
 * service, the relay, the TLS proxy for the world's origins, and machines. world.ts orders the steps.
 */
import { join, resolve } from "node:path";
import { docker, run, startContainer, usedSubnets } from "./docker.ts";
import { RUNNER, type MachineDescription } from "./machines.ts";
import { caddyfile, proxyNames, type Origins } from "./origins.ts";
import { HOSTED_LIMITS, HOSTS, LABEL, OPEN_LIMITS, PORTS, addresses, machineContainer, objectName, pickSubnet, type MachineSpec, type WorldPlan } from "./plan.ts";

export const IMAGE = "herdr-ci-runner:local";
export const PROXY_IMAGE = "caddy:2";
export const SYSTEMD_IMAGE = "ovis-world-systemd:local";
/**
 * What a systemd machine needs beyond an ordinary one: systemd must
 * write its OWN cgroup tree, which docker mounts read-only unless the container is privileged (CAP_SYS_ADMIN, seccomp
 * and apparmor unconfined do not help: "Failed to create /init.scope control group: Read-only file system"). So:
 * privileged, but in a private cgroup namespace and never with the host's cgroup tree; the CPU pin, the memory cap and
 * the internal network stay as on every machine.
 */
export const SYSTEMD_FLAGS = ["--privileged", "--cgroupns=private", "--tmpfs", "/run", "--tmpfs", "/run/lock"] as const;
export const TOOL_DIR = import.meta.dir;
const PATH = "/opt/world-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface Staged {
  readonly network: string; readonly subnet: string; readonly scratch: string; readonly ca: string; readonly expires: number;
  /** `<pid>:<start>` of the world's owner: every object carries it, so removals never take a same-named world's */
  readonly owner: string;
  /** throws once the world's start is called off (its owner is removing it): checked before each container is made */
  readonly live?: () => void;
  /** the app's built copy verified (world.ts, verifyAppBuild): it gets a site container of its own */
  readonly verifiedApp?: boolean;
}

const fetchOk = async (url: string) => { try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
const answers = async (url: string) => { try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; } };

export async function within(what: string, ms: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(200);
  }
}

/** Names the TLS proxy answers for besides the origins: Ovis's staging account name when passes are on. */
export const extraHosts = (plan: WorldPlan) => plan.passes === "off" ? [] : [HOSTS.staging];

export async function createNetwork(plan: WorldPlan, labels: Readonly<Record<string, string>>): Promise<{ network: string; subnet: string }> {
  return networkOnFreeSubnet(objectName(plan.name, "net"), !plan.outbound, labels);
}

/** A docker network on a free /24 of 10.243.0.0/16; looks again when another run takes the same subnet first. */
export async function networkOnFreeSubnet(network: string, internal: boolean, labels: Readonly<Record<string, string>>, options: readonly string[] = []): Promise<{ network: string; subnet: string }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const subnet = pickSubnet(await usedSubnets(), Math.floor(Math.random() * 256));
    if (subnet === null) throw new Error("no free /24 left in 10.243.0.0/16");
    const ran = await run(["docker", "network", "create", ...(internal ? ["--internal"] : []), ...options.flatMap((option) => ["-o", option]), "--subnet", subnet,
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), network]);
    if (ran.code === 0) return { network, subnet };
    if (/already exists/.test(ran.err)) throw new Error(`network ${network} exists already`);
    // another world took the subnet between our look and our create: look again
    if (!/overlap|Pool/i.test(ran.err)) throw new Error(`docker network create: ${ran.err.trim()}`);
  }
  throw new Error("no free subnet after 8 tries");
}

/** The account service, then the relay with the pass keys it reports, then the TLS proxy. Returns the control API. */
export async function startServices(plan: WorldPlan, staged: Staged): Promise<string> {
  const at = addresses(staged.subnet);
  const base = { network: staged.network, cpus: plan.cpus, memory: plan.memory, deadline: staged.expires };
  const labels = (role: string) => ({ [LABEL]: plan.name, [`${LABEL}.owner`]: staged.owner, [`${LABEL}.role`]: role });
  const live = () => staged.live?.();
  const code = [`${plan.repo}:/opt/ovis:ro`, `${TOOL_DIR}:/opt/world:ro`];
  live();
  await startContainer({ ...base, name: objectName(plan.name, "account"), image: IMAGE, ip: at.account, labels: labels("account"),
    mounts: [...code, ...(plan.accountRepo ? [`${resolve(plan.accountRepo)}:/opt/account:ro`] : [])],
    env: { WORLD_ROLE: plan.account === "real" ? "account-real" : "account", WORLD_BIND: at.account, WORLD_REPO: "/opt/ovis", WORLD_PUBLIC_URL: plan.origins.account.url,
      ...(plan.people ? { WORLD_PEOPLE: "/world/people", HOME: "/tmp" } : {}) },
    // the people file is mode 600: the account service reads it as its owner, and nothing else in the world sees it
    ...(plan.people ? { extra: ["--user", `${process.getuid?.()}:${process.getgid?.()}`, "-v", `${resolve(plan.people)}:/world/people:ro`] } : {}),
    command: ["bun", "/opt/world/inside/services.ts"] });
  const control = `http://${at.account}:${PORTS.control}`;
  await within("the account service", 90_000, () => { live(); return fetchOk(`${control}/ready`); });
  const ready = await (await fetch(`${control}/ready`)).json() as { relay_pass_keys: string };
  live();
  await startContainer({ ...base, name: objectName(plan.name, "relay"), image: IMAGE, ip: at.relay, labels: labels("relay"), mounts: code,
    env: { WORLD_ROLE: "relay", WORLD_BIND: at.relay, WORLD_REPO: "/opt/ovis", WORLD_PASSES: plan.passes, WORLD_PASS_KEYS: ready.relay_pass_keys,
      WORLD_LIMITS: JSON.stringify(plan.limits === "hosted" ? HOSTED_LIMITS : OPEN_LIMITS) },
    command: ["bun", "/opt/world/inside/services.ts"] });
  await within("the relay", 30_000, () => { live(); return answers(`http://${at.relay}:${PORTS.relay}/`); });
  const site = staged.verifiedApp === true && plan.sites.app !== undefined ? `${at.account.split(".").slice(0, 3).join(".")}.13` : undefined;
  if (site !== undefined) {
    live();
    await startContainer({ ...base, name: objectName(plan.name, "site"), image: IMAGE, ip: site, labels: labels("site"),
      mounts: [`${resolve(plan.appRepo ?? plan.repo)}:/opt/app-repo:ro`, `${resolve(plan.sites.app!)}:/sites/app:ro`, `${TOOL_DIR}:/opt/world:ro`],
      env: { WORLD_BIND: site }, command: ["bun", "/opt/world/inside/site.ts"] });
    await within("the app's site", 30_000, () => { live(); return answers(`http://${site}:8080/`); });
  }
  const caddy = join(staged.scratch, "Caddyfile");
  await Bun.write(caddy, caddyfile({ bind: at.tls, relay: at.relay, account: at.account, ...(site !== undefined ? { site } : {}), ...(plan.account === "real" ? { accountHostIsItsOwn: true } : {}) }, plan.origins, extraHosts(plan)));
  live();
  await startContainer({ ...base, name: objectName(plan.name, "tls"), image: PROXY_IMAGE, ip: at.tls, labels: labels("tls"),
    mounts: [`${join(staged.scratch, "certs")}:/certs:ro`, `${caddy}:/etc/caddy/Caddyfile:ro`,
      ...Object.entries(plan.sites).map(([name, dir]) => `${resolve(dir)}:/sites/${name}:ro`)],
    extra: proxyNames(plan.origins, extraHosts(plan)).flatMap((alias) => ["--network-alias", alias]),
    command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"] });
  await within("the TLS proxy", 30_000, async () => { live(); return (await run(["docker", "logs", objectName(plan.name, "tls")])).err.includes("serving initial configuration"); });
  return control;
}

/** The URLs a machine's server is pointed at: the world's origins (Ovis's staging account name when passes are on). */
export function serverOrigins(plan: WorldPlan, origins: Origins = plan.origins): Record<string, string> {
  return {
    WORLD_RELAY_URL: origins.relay.url,
    WORLD_ACCOUNT_URL: plan.passes === "off" ? origins.account.url : `https://${HOSTS.staging}`,
    ...(origins.app ? { WORLD_APP_URL: origins.app.url } : {}),
  };
}

export async function startMachine(plan: WorldPlan, staged: Staged, spec: MachineSpec, index: number): Promise<MachineDescription> {
  const container = machineContainer(plan.name, spec.name);
  const ip = addresses(staged.subnet).machine(index);
  const systemd = spec.systemd === true;
  staged.live?.();
  await startContainer({
    name: container, image: systemd ? SYSTEMD_IMAGE : IMAGE, network: staged.network, ip, cpus: plan.cpus, memory: plan.memory,
    // systemd must be the first process, so docker cannot wrap it in the deadline: the machine powers itself off instead
    deadline: systemd ? null : staged.expires, init: !systemd,
    labels: { [LABEL]: plan.name, [`${LABEL}.owner`]: staged.owner, [`${LABEL}.role`]: "machine", [`${LABEL}.machine`]: spec.name },
    mounts: [`${plan.repo}:/opt/ovis:ro`, `${TOOL_DIR}:/opt/world:ro`, `${staged.ca}:/world/ca.pem:ro`, `${join(staged.scratch, "bin")}:/opt/world-bin:ro`,
      ...(spec.mounts ?? []).map((mount) => `${mount}:ro`)],
    env: { WORLD_MACHINE: spec.name, WORLD_ENGINE: spec.engine, WORLD_REPO: "/opt/ovis", WORLD_PASSES: plan.passes, PATH,
      NODE_EXTRA_CA_CERTS: "/world/ca.pem", ...serverOrigins(plan) },
    extra: ["--hostname", spec.hostname ?? `${spec.name}-box`, ...(systemd ? SYSTEMD_FLAGS : [])],
    command: systemd ? ["/sbin/init"] : ["sleep", "infinity"],
  });
  const user = spec.user ? await renameUser(container, spec.user) : RUNNER;
  await ownMountParents(container, user, spec.mounts ?? []);
  if (systemd) await bootSystemd(container, staged.expires, user);
  if (plan.trustCa) await trustCa(container);
  return { name: spec.name, container, ip, engine: spec.engine, start: spec.start, systemd, user, ...(spec.preset ? { preset: spec.preset } : {}), ...(spec.hostname ? { hostname: spec.hostname } : {}), server: `http://127.0.0.1:${PORTS.server}` };
}

/** The image's user (ubuntu, uid 1000) becomes `name` with home /home/<name> and this PC's uid and gid, so mounted files are its own. */
async function renameUser(container: string, name: string): Promise<MachineDescription["user"] & object> {
  const home = `/home/${name}`;
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  // uid and gid stay 1000 on a PC where they are 1000; else the image's user takes this PC's (a uid the image already
  // gives someone else is refused by usermod, and the start fails with its words)
  await docker(["exec", "-u", "0", container, "sh", "-c",
    'groupmod -n "$0" -g "$3" -o ubuntu && usermod -l "$0" -d "$1" -u "$2" -g "$3" ubuntu && mkdir -p "$1" && chown "$0:$0" "$1"', name, home, String(uid), String(gid)]);
  const got = (await docker(["exec", container, "id", "-u", name])).trim();
  if (got !== String(uid)) throw new Error(`${container}: the machine's user ${name} has uid ${got}, not this PC's ${uid}`);
  return { name, uid, home };
}

/** Folders docker made for mounts under the user's home belong to root: each one between the home and a mount is the user's. */
async function ownMountParents(container: string, user: { readonly name: string; readonly home: string }, mounts: readonly string[]): Promise<void> {
  const parents = new Set<string>();
  for (const mount of mounts) {
    const target = mount.split(":")[1] ?? "";
    if (!target.startsWith(`${user.home}/`)) continue;
    for (let dir = target.slice(0, target.lastIndexOf("/")); dir.length > user.home.length; dir = dir.slice(0, dir.lastIndexOf("/"))) parents.add(dir);
  }
  if (parents.size > 0) await docker(["exec", "-u", "0", container, "chown", `${user.name}:${user.name}`, user.home, ...parents]);
}

/**
 * Waits for systemd, arms its own poweroff at the world's deadline (layer 3 for a machine docker cannot wrap), and
 * starts the machine user's manager by lingering. Units of the user manager: `systemctl --user` with XDG_RUNTIME_DIR set.
 */
async function bootSystemd(container: string, expires: number, user: { readonly name: string; readonly uid: number }): Promise<void> {
  await within(`${container}: systemd`, 120_000, async () => /^(running|degraded)$/.test((await run(["docker", "exec", container, "systemctl", "is-system-running"])).out.trim()));
  const left = Math.max(1, expires - Math.floor(Date.now() / 1000));
  await docker(["exec", container, "systemd-run", "--unit=world-deadline", `--on-active=${left}s`, "/bin/systemctl", "poweroff", "--force", "--force"]);
  await docker(["exec", container, "loginctl", "enable-linger", user.name]);
  await within(`${container}: ${user.name}'s user manager`, 60_000, async () => (await run(["docker", "exec", container, "test", "-S", `/run/user/${user.uid}/bus`])).code === 0);
}

/** The test CA in the machine's system store, so curl, bun and node all accept the world's origins. */
export async function trustCa(container: string): Promise<void> {
  await docker(["exec", "-u", "0", container, "sh", "-c", "cp /world/ca.pem /usr/local/share/ca-certificates/ovis-world-test.crt && update-ca-certificates >/dev/null"]);
}

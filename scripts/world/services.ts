/**
 * M2's test services (R11): a named, LONG-LIVED relay and account service on loopback ports of this PC, for
 * `tailscale serve` to put on the tailnet (the entries are printed, never run here). Containers restart with docker,
 * so no process of this tool has to stay alive; gc never touches them (owner "service").
 *   bun scripts/world/cli.ts services up [--name m2] [--repo <checkout>] [--account fake|real --account-repo <checkout>]
 *                                        [--people <file>] [--account-arg=<arg>]... [--kit <folder>] [--ports <account,relay,kit,control>]
 * The published ports (27542-27544, and 17541) take only an account service that asks a person (publishRefusal).
 *   bun scripts/world/cli.ts services status [--name m2]
 *   bun scripts/world/cli.ts services down [--name m2] [--purge]
 * The relay and the account service sit on an internal network (no route out) on which this PC itself has no address
 * (docker's inhibit_ipv4), so nothing on the PC reaches them but through the edge (caddy): the only container with a
 * published port, on 127.0.0.1 only, which refuses /v1/test/* from outside. State: ~/.local/state/ovis-test-services/<name>.
 * The control API (its /token signs anybody in) answers only a request carrying the secret in that state folder's
 * control.secret (mode 0600), in the header X-World-Control: the edge checks it, and so does the control server itself.
 * Every container is named m2-<name>-<part> and sits on CPUs 0-55 (beside the CI runners, never in a heavy slot, which
 * ends after 30 minutes), at most 2 CPUs and 2 GB each, restarted unless stopped, logs capped at 3 files of 10 MB.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { docker, removeObjects, run, startContainer } from "./docker.ts";
import { LABEL, PlanError, addresses, checkWorldName } from "./plan.ts";
import { IMAGE, PROXY_IMAGE, TOOL_DIR, networkOnFreeSubnet, within } from "./stage.ts";
import { checkPeopleFile } from "./world.ts";

export const ORIGINS = {
  app: "https://home-server.tail1e211e.ts.net:17541", account: "https://home-server.tail1e211e.ts.net:17542",
  relay: "wss://home-server.tail1e211e.ts.net:17543", kit: "https://home-server.tail1e211e.ts.net:17544",
} as const;
export const LOOPBACK = { account: 27542, relay: 27543, kit: 27544, control: 27549 } as const;
export type Loopback = { readonly [K in keyof typeof LOOPBACK]: number };
const SERVE = [[17541, 17541], [17542, LOOPBACK.account], [17543, LOOPBACK.relay], [17544, LOOPBACK.kit]] as const;
/** the loopback ports `tailscale serve` puts on the whole tailnet once the maintainer has made the entries (17541 is the app's) */
export const PUBLISHED = [LOOPBACK.account, LOOPBACK.relay, LOOPBACK.kit, 17541] as const;

/** What `services up` takes to put the services on the published ports (with --account-repo <checkout>): the refusal and the README name it. */
export const PUBLISH_ARGS = ["--account", "real", "--people", "<file>"] as const;

/**
 * The interlock: on a published port, whoever signs in can open terminals of the owner's machine, so the account
 * service there must ask a PERSON for a passphrase: only the real code with --people (a people file, `name:passphrase`
 * lines, mode 600; or its own --people through --account-arg). The fake stays off them even with a people file: our
 * /link page asks for a passphrase and the fake's other sign-in routes are refused then (inside/linkpage.ts,
 * passphraseFree), but the fake is a test's service, never the tailnet's. Any other port is for tests.
 */
export function publishRefusal(ports: Loopback, account: "fake" | "real", accountArgs: readonly string[], people: string | null = null): string | null {
  const published = Object.values(ports).filter((port) => (PUBLISHED as readonly number[]).includes(port));
  if (published.length === 0) return null;
  if (account === "real" && (people !== null || accountArgs.includes("--people"))) return null;
  return `ports ${published.join(", ")} are the ones tailscale serve puts on the tailnet: only an account service that asks a person for a passphrase may sit there (${PUBLISH_ARGS.join(" ")} --account-repo <checkout>; never the fake). Tests use --ports <account,relay,kit,control> elsewhere.`;
}

/**
 * `services up`'s options. `--people <file>` is the people file (it goes to either account service); `--account-arg=<arg>`
 * passes any other argument to the account service (the `=` is needed for a value that starts with a dash).
 */
export function upOptions(args: readonly string[]): { readonly name: string; readonly repo?: string; readonly account: string; readonly "account-repo"?: string; readonly accountArgs: string[]; readonly people?: string; readonly kit?: string; readonly ports?: string } {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    name: { type: "string", default: "m2" }, repo: { type: "string" }, account: { type: "string", default: "fake" },
    "account-repo": { type: "string" }, "account-arg": { type: "string", multiple: true }, people: { type: "string" },
    kit: { type: "string" }, ports: { type: "string" },
  } });
  return { name: values.name, repo: values.repo, account: values.account, "account-repo": values["account-repo"], accountArgs: values["account-arg"] ?? [], people: values.people, kit: values.kit, ports: values.ports };
}

export function portsFrom(text: string | undefined): Loopback {
  if (text === undefined) return LOOPBACK;
  const ports = text.split(",").map(Number);
  if (ports.length !== 4 || ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set(ports).size !== 4) throw new PlanError("--ports <account>,<relay>,<kit>,<control>: four different ports from 1024");
  const [account, relay, kit, control] = ports as [number, number, number, number];
  return { account, relay, kit, control };
}
/** Where M2's long-lived services sit and what each may take. */
export const SERVICE_CPUS = "0-55";
export const SERVICE_FLAGS = ["--cpus", "2", "--restart", "unless-stopped", "--log-opt", "max-size=10m", "--log-opt", "max-file=3"] as const;
/** the header that carries control.secret to the control API */
export const CONTROL_HEADER = "X-World-Control";
/** the services' internal network gives this PC no address on its bridge: the PC reaches the services only through the edge */
export const NO_HOST_ADDRESS = "com.docker.network.bridge.inhibit_ipv4=true";

/**
 * The edge's Caddyfile: plain HTTP behind `tailscale serve`; /v1/test and /v1/test/* (a session for any subject) never from outside;
 * the control API only with the secret. It holds the secret, so it is written mode 0600.
 */
export function edgeCaddyfile(account: string, relay: string, secret: string): string {
  return `{\n\tauto_https off\n\tadmin off\n}\n` +
    `:8542 {\n\t@test path /v1/test /v1/test/*\n\trespond @test 404\n\treverse_proxy ${account}:9080 {\n\t\theader_up X-World-Origin ${ORIGINS.account}\n\t}\n}\n` +
    `:8543 {\n\treverse_proxy ${relay}:8787\n}\n` +
    `:8544 {\n\troot * /kit\n\theader X-Content-Type-Options nosniff\n\theader Content-Type application/octet-stream\n\theader Content-Disposition attachment\n\tfile_server\n}\n` +
    `:8549 {\n\t@key header ${CONTROL_HEADER} ${secret}\n\thandle @key {\n\t\treverse_proxy ${account}:9090\n\t}\n\thandle {\n\t\trespond 401\n\t}\n}\n`;
}

const stateOf = (name: string) => join(homedir(), ".local/state/ovis-test-services", name);
const world = (name: string) => `svc-${name}`;
const object = (name: string, part: string) => `m2-${name}-${part}`;
const secretOf = (state: string) => join(state, "control.secret");
/** A file only its owner reads, whatever mode an older file of that name had. */
function privateFile(file: string, text: string): void {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

interface UpValues { readonly account: string; readonly "account-repo"?: string; readonly accountArgs: readonly string[]; readonly people?: string }
interface UpPlaces { readonly repo: string; readonly state: string; readonly kit: string; readonly subnet: string; readonly labels: Readonly<Record<string, string>> }

/** Everything of `services up` after its internal network: the edge's network, the account service, the relay and the edge. */
async function startAll(name: string, values: UpValues, ports: Loopback, { repo, state, kit, subnet, labels }: UpPlaces): Promise<void> {
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  await docker(["network", "create", ...labelArgs, object(name, "edge")]);
  const at = addresses(subnet);
  const base = { network: object(name, "net"), cpus: SERVICE_CPUS, memory: "2g", deadline: null, labels, extra: [...SERVICE_FLAGS] };
  const code = [`${repo}:/opt/ovis:ro`, `${TOOL_DIR}:/opt/world:ro`];
  const real = values.account === "real";
  const secret = randomBytes(32).toString("hex");
  privateFile(secretOf(state), `${secret}\n`);
  await startContainer({ ...base, name: object(name, "account"), image: IMAGE, ip: at.account,
    mounts: [...code, ...(real ? [`${resolve(values["account-repo"]!)}:/opt/account:ro`, `${join(state, "account")}:/state/account`, `${join(state, "home")}:/state/home`] : [])],
    env: { WORLD_ROLE: real ? "account-real" : "account", WORLD_BIND: at.account, WORLD_REPO: "/opt/ovis", WORLD_PUBLIC_URL: ORIGINS.account,
      WORLD_ACCOUNT_STATE: "/state/account", WORLD_ACCOUNT_ARGS: JSON.stringify(values.accountArgs),
      ...(real ? { HOME: "/state/home" } : values.people ? { HOME: "/tmp" } : {}), ...(values.people ? { WORLD_PEOPLE: "/world/people" } : {}) },
    // never on docker's command line, which any local user reads: docker takes it from its own environment
    secrets: { WORLD_CONTROL_SECRET: secret },
    // the people file is mode 600: the account service reads it as its owner
    extra: [...base.extra, ...(real || values.people ? ["--user", `${process.getuid?.()}:${process.getgid?.()}`] : []),
      ...(values.people ? ["-v", `${resolve(values.people)}:/world/people:ro`] : [])],
    command: ["bun", "/opt/world/inside/services.ts"] });
  // this PC has no address on the services' network: it asks from inside the account's own container
  const askReady = () => run(["docker", "exec", object(name, "account"), "curl", "-s", "-f", "-m", "2", `http://${at.account}:9090/ready`]);
  await within("the account service", 90_000, async () => (await askReady()).code === 0);
  const ready = JSON.parse((await askReady()).out) as { relay_pass_keys: string };
  await startContainer({ ...base, name: object(name, "relay"), image: IMAGE, ip: at.relay, mounts: code,
    env: { WORLD_ROLE: "relay", WORLD_BIND: at.relay, WORLD_REPO: "/opt/ovis", WORLD_PASSES: real ? "grace" : "off", WORLD_PASS_KEYS: ready.relay_pass_keys,
      WORLD_LIMITS: JSON.stringify({ perAddressPerMinute: 100_000, globalPerMinute: 100_000, maxSocketsPerAddress: 4096, maxAddresses: 4096 }) },
    command: ["bun", "/opt/world/inside/services.ts"] });
  const caddy = join(state, "Caddyfile");
  privateFile(caddy, edgeCaddyfile(at.account, at.relay, secret));
  await startContainer({ ...base, network: object(name, "edge"), name: object(name, "edge"), image: PROXY_IMAGE,
    mounts: [`${caddy}:/etc/caddy/Caddyfile:ro`, `${kit}:/kit:ro`],
    extra: [...base.extra, ...([[ports.account, 8542], [ports.relay, 8543], [ports.kit, 8544], [ports.control, 8549]] as const).flatMap(([host, inside]) => ["-p", `127.0.0.1:${host}:${inside}`])],
    command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"] });
  await docker(["network", "connect", "--ip", at.tls, object(name, "net"), object(name, "edge")]);
}

async function up(args: string[]): Promise<number> {
  const values = upOptions(args);
  const name = checkWorldName(values.name);
  if (values.account !== "fake" && values.account !== "real") throw new PlanError("--account is fake or real");
  const ports = portsFrom(values.ports);
  const refusal = publishRefusal(ports, values.account === "real" ? "real" : "fake", values.accountArgs, values.people ?? null);
  if (refusal) throw new PlanError(refusal);
  if (values.people !== undefined) checkPeopleFile(values.people);
  if ((values.account === "real") !== (values["account-repo"] !== undefined)) throw new PlanError("--account real goes with --account-repo <checkout of ovis-sh/account>, and only it");
  if ((await run(["docker", "network", "inspect", object(name, "net")])).code === 0) throw new PlanError(`services ${name} are up already (services down --name ${name} first)`);
  const repo = resolve(values.repo ?? join(TOOL_DIR, "../.."));
  const state = stateOf(name);
  const kit = resolve(values.kit ?? join(state, "kit"));
  for (const dir of [join(state, "account"), join(state, "home"), kit]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const labels = { [LABEL]: world(name), [`${LABEL}.owner`]: "service", [`${LABEL}.expires`]: "0", [`${LABEL}.scratch`]: state };
  // made before the cleanup is armed: a network of that name that exists already is another run's, never ours to remove
  const { subnet } = await networkOnFreeSubnet(object(name, "net"), true, labels, [NO_HOST_ADDRESS]);
  try {
    await startAll(name, values, ports, { repo, state, kit, subnet, labels });
  } catch (error) {
    // nothing half-made stays behind to make the next `up` refuse with "up already"
    await removeObjects(world(name)).catch((left: Error) => console.error(`services up failed, and its cleanup too: ${left.message}`));
    throw error;
  }
  writeFileSync(join(state, "services.json"), JSON.stringify({ name, account: values.account, repo, accountRepo: values["account-repo"] ?? null, kit, subnet, origins: ORIGINS, loopback: ports, cpus: SERVICE_CPUS }, null, 2));
  return status([`--name`, name]);
}

async function probe(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  try { return String((await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(3000) })).status); } catch (error) { return `no answer (${(error as Error).message})`; }
}

async function status(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { name: { type: "string", default: "m2" } } });
  const name = checkWorldName(values.name);
  const containers = (await docker(["ps", "-a", "--filter", `label=${LABEL}=${world(name)}`, "--format", "{{.Names}} {{.Status}}"])).split("\n").filter(Boolean);
  const saved = join(stateOf(name), "services.json");
  const ports: Loopback = existsSync(saved) ? (JSON.parse(readFileSync(saved, "utf8")) as { loopback: Loopback }).loopback : LOOPBACK;
  const answers = {
    account: await probe(ports.account, "/v1/providers"), accountTestRoute: await probe(ports.account, "/v1/test/token"),
    relay: await probe(ports.relay, "/"), kit: await probe(ports.kit, "/"), controlWithoutSecret: await probe(ports.control, "/ready"),
    control: existsSync(secretOf(stateOf(name))) ? await probe(ports.control, "/ready", { [CONTROL_HEADER]: readFileSync(secretOf(stateOf(name)), "utf8").trim() }) : "no control.secret",
  };
  console.log(JSON.stringify({ name, state: stateOf(name), containers, answers, origins: ORIGINS, loopback: ports }, null, 2));
  console.log("\nThe tailscale serve entries these services need (NOT run here; they need the maintainer's word; never Funnel):");
  for (const [https, loopback] of SERVE) console.log(`tailscale serve --bg --https=${https} http://127.0.0.1:${loopback}`);
  return containers.length === 0 ? 1 : 0;
}

async function down(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { name: { type: "string", default: "m2" }, purge: { type: "boolean", default: false } } });
  const name = checkWorldName(values.name);
  await removeObjects(world(name));
  if (values.purge && existsSync(stateOf(name))) rmSync(stateOf(name), { recursive: true, force: true });
  console.log(JSON.stringify({ down: name, state: values.purge ? "removed" : stateOf(name) }));
  return 0;
}

export async function servicesCommand(args: string[]): Promise<number> {
  const [command = "", ...rest] = args;
  switch (command) {
    case "up": return up(rest);
    case "status": return status(rest);
    case "down": return down(rest);
    default: throw new PlanError("services up|status|down");
  }
}

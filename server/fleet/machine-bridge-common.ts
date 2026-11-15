import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FleetBridgeHealth } from "../../shared/machines.ts";
import type { RelayStatus } from "../../shared/protocol.ts";
import type { AgentDetector } from "../agent-catalog-detect.ts";
import { descriptorLive, registerBridge, socketPath, type BridgeDescriptor } from "../bridge.ts";
import { createServer } from "../index.ts";
import { acquireOwnerDirectory, withOwnerGuard } from "../owner-guard.ts";
import { writePrivateState } from "../private-state.ts";
import { RelayService, RelayUnavailableError } from "../relay/service.ts";
import type { ShellAgentLocator } from "../shell-agent.ts";

/** The file the link agent reads (crates/fleet-link/src/daemon.rs ADVERT_FILE). */
export const ADVERT_FILE = "advert.json";
/** What advert.json says of the agent sidecar until todo 41 installs one. */
export const NO_AGENT = "none";
/** How often a runtime that stopped answering is asked again, besides the handle's own restart signal. */
export const RECHECK_MS = 2_000;

/** advert.json as this bridge writes it: the ADVERT_FILE rows of docs/fleet-link.md, and `machine_id`, which the agent does not read. */
export interface BridgeAdvert {
  readonly v: 1;
  /** what the controller merges this machine's row by (todo 26): this PC's own Ovis id when it has one, else the runtime's machine id */
  readonly runtime_id: string;
  /** the runtime's control server boot id: new at each runtime start */
  readonly boot_id: string;
  /** the runtime's own machine id */
  readonly machine_id: string;
  readonly bridge_port: number;
  readonly bridge_token: string;
  readonly native_bearer?: string;
  readonly native_socket?: string;
  readonly runtime_down: boolean;
  readonly versions: { readonly server: string; readonly agent: string; readonly runtime: string };
}

/** PIPE_ADVERT's `runtime_id` and `boot_id` (docs/fleet-link.md, Fields). */
const RUNTIME_TEXT = /^[A-Za-z0-9._:-]{1,64}$/;
/** PIPE_ADVERT's versions. */
const VERSION_TEXT = /^[0-9A-Za-z.+-]{1,64}$/;

/** `value` when PIPE_ADVERT takes it as an id, else a stable digest of it that it takes. */
export function runtimeText(value: string): string {
  return RUNTIME_TEXT.test(value) ? value : createHash("sha256").update(value).digest("hex").slice(0, 32);
}
export function versionText(value: string): string {
  const text = value.replace(/[^0-9A-Za-z.+-]/g, "-").slice(0, 64);
  return VERSION_TEXT.test(text) ? text : "unknown";
}

/**
 * Writes `advert` to `<folder>/advert.json`: a new file of mode 0600 beside it, synced, then renamed over the old one,
 * so the agent reads either the old advert or the new one whole, and never a file another user could read. The new
 * file is created exclusively: a file or symbolic link already at its name is never written through. `tmpTag` names
 * it (random unless a test names it).
 */
export function writeAdvert(folder: string, advert: BridgeAdvert, tmpTag = randomBytes(6).toString("hex")): string {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, ADVERT_FILE);
  const tmp = `${path}.${process.pid}.${tmpTag}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    // the mode given to open is masked by the umask: set it on the file itself before anything is in it
    chmodSync(tmp, 0o600);
    writeSync(fd, JSON.stringify(advert));
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
  closeSync(fd);
  renameSync(tmp, path);
  return path;
}

/**
 * The relay of a fleet machine's bridge: it never starts (no relay link and no direct carrier: the link agent is the
 * machine's way out), and it names this PC by its own Ovis id, the one its own Ovis server reports, so the bridge's
 * /api/health says the same id as its advert.
 */
class MachineRelay extends RelayService {
  constructor(stateDir: string, private readonly pcId: string | undefined) {
    super({ stateDir });
  }
  override start(): RelayStatus {
    throw new RelayUnavailableError("A fleet machine's bridge does not start the relay: its fleet link is its only way out.");
  }
  override serverId(): string | undefined {
    return this.pcId;
  }
}

/** Where a fleet machine keeps its files (OVIS_FLEET_HOME). */
export function fleetMachinePaths(env: Record<string, string | undefined> = process.env): { fleetState: string; stateDir: string } {
  const home = env["OVIS_FLEET_HOME"] || join(homedir(), ".local", "share", "ovis-fleet");
  // the folder `ovis-link run --state` reads
  const stateDir = join(home, "server");
  return { fleetState: env["OVIS_FLEET_STATE"] || join(home, "state"), stateDir };
}

/**
 * The descriptor of the bridge that writes `fleetState`'s advert.json: one per fleet state folder, however its path is
 * spelled. It lives in that folder, not in the user's bridge registry (~/.config/herdr-web-ui/bridges), which no one
 * looks a fleet bridge up in: a fleet install writes nothing outside its own folder, and --uninstall takes it all back.
 */
export function machineDescriptorPath(fleetState: string): string {
  mkdirSync(fleetState, { recursive: true, mode: 0o700 });
  return join(realpathSync(fleetState), "bridge.json");
}

/** Whether a live bridge already holds the descriptor at `path`. */
function heldByLiveBridge(path: string): boolean {
  try { return descriptorLive(JSON.parse(readFileSync(path, "utf8")) as BridgeDescriptor); } catch { return false; }
}

/** Thrown when another live bridge already writes this fleet state folder's advert.json. */
export class MachineBridgeRunning extends Error {
  constructor(readonly descriptor: string) {
    super(`Another bridge already serves this fleet machine (descriptor ${descriptor})`);
    this.name = "MachineBridgeRunning";
  }
}

/** Claim before any asynchronous startup: one writer, including while its engine is down. */
export function claimMachineBridge(descriptor: string): () => void {
  mkdirSync(dirname(descriptor), { recursive: true, mode: 0o700 });
  if (heldByLiveBridge(descriptor)) throw new MachineBridgeRunning(descriptor);
  const lease = acquireOwnerDirectory(descriptor + ".lock", {
    running: "Another bridge already serves this fleet machine", starting: "Another bridge is starting for this fleet machine",
  });
  return () => lease.release();
}

/** The same private listener and descriptor for every engine. Its caller holds the startup claim. */
export function openMachineBridge(options: {
  stateDir: string; descriptor: string; pcServerId?: string;
  shellAgents?: ShellAgentLocator; agentDetector?: AgentDetector; fleetBridgeHealth?: () => FleetBridgeHealth;
  /** The engine behind the adapter, so a bridge restart keeps the browser's pane identity. */
  herdrIdentity?: () => string | null;
}) {
  const token = randomBytes(32).toString("hex");
  const server = createServer({
    port: 0, hostname: "127.0.0.1", ipv6Loopback: false, token, machines: false, bridgeOnly: true, localFiles: true,
    stateDir: options.stateDir, relay: new MachineRelay(options.stateDir, options.pcServerId),
    ...(options.shellAgents ? { shellAgents: options.shellAgents } : {}),
    ...(options.agentDetector ? { agentDetector: options.agentDetector } : {}),
    ...(options.fleetBridgeHealth ? { fleetBridgeHealth: options.fleetBridgeHealth } : {}),
    ...(options.herdrIdentity ? { herdrIdentity: options.herdrIdentity } : {}),
  });
  try {
    const registration = registerBridge(server.port, token, { path: options.descriptor });
    if (!registration.registered) throw new MachineBridgeRunning(options.descriptor);
    return {
      server, port: server.port, token,
      // An initially absent/ambiguous session may become selected after the listener starts.
      selectedSocket(path = socketPath()) {
        withOwnerGuard(options.descriptor, () => {
          const record = JSON.parse(readFileSync(options.descriptor, "utf8")) as BridgeDescriptor;
          writePrivateState(options.descriptor, { ...record, socket_path: path });
        });
      },
      close() { registration.close(); server.stop(); },
    };
  } catch (error) { server.stop(); throw error; }
}

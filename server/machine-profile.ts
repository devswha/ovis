/** The ordinary server beside an owner's classic herdr or herdr-core, with no engine lifecycle authority. */
import { type Dirent, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chosenHerdrSocketStatus, discoverHerdrSessions, validHerdrSocket } from "./herdr-discovery.ts";
import { herdrSocketPath, ping } from "./herdr/client.ts";
import { isJsonObject } from "./http.ts";
import { acquireOwnerDirectory, liveOwner } from "./owner-guard.ts";
import { writePrivateState } from "./private-state.ts";
import { stateDirNames } from "./update-state.ts";

/** Pending the no-inbound-port decision. This is deliberately not an environment override. */
export const MACHINE_DIRECT_CARRIER_ENABLED = false;

export class MachineProfileError extends Error {}

/** Read the selection without invoking runtime discovery, hc, a login shell or any core connection. */
export function machineEngine(stateDir: string, port: number): string {
  const named = process.env["OVIS_RUNTIME"];
  if (named) return named;
  try {
    const saved: unknown = JSON.parse(readFileSync(join(stateDir, `runtime-${port}.json`), "utf8"));
    if (isJsonObject(saved) && typeof saved.runtime === "string") return saved.runtime;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return "herdr";
}

/** A path as the system resolves it (links, `..`, a trailing slash, relative to the working folder), also where its last parts do not exist yet. */
function canonical(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const absolute = resolve(path);
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
}

/**
 * A lease per canonical state folder, across checkouts and ports of the machine profile. Never on a
 * folder the ordinary server uses by default, nor one an Ovis's supervisor holds: a second responder
 * there would answer with that Ovis's relay key. Nothing is written before both are ruled out.
 */
export function claimServerState(told: string | undefined) {
  const own = "name a folder of its own with OVIS_STATE_DIR";
  const { legacy, next } = stateDirNames(process.env);
  if (!told || [legacy, next].some((dir) => canonical(dir) === canonical(told))) {
    throw new MachineProfileError(`The machine profile does not run on a default Ovis state folder, so no server was started; ${own}`);
  }
  const updates = join(canonical(told), "updates");
  let ids: Dirent[] = [];
  try { ids = readdirSync(updates, { withFileTypes: true }); }
  catch (error) { if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error; }
  for (const id of ids) {
    const holder = id.isDirectory() ? liveOwner(join(updates, id.name, "supervisor.lock")) : null;
    if (holder !== null) throw new MachineProfileError(`An Ovis already runs on this state folder (${holder}), so no second server was started; ${own}`);
  }
  mkdirSync(told, { recursive: true, mode: 0o700 });
  const stateDir = realpathSync(told);
  const lease = acquireOwnerDirectory(join(stateDir, "serve.lock"), {
    running: "Another server already owns this Ovis state directory, so no second server was started",
    starting: "Another server is claiming this Ovis state directory, so no second server was started",
  }, {}, { wait: false });
  return { stateDir, release: lease.release, listening: (port: number, hostname: string) => lease.amend((lock) => writePrivateState(join(lock, "http.json"), { port, hostname })) };
}

/** The herdr this server runs, and where that came from: OVIS_HERDR_BIN, or the PATH. */
export function machineHerdrBinary(): string {
  const named = process.env["OVIS_HERDR_BIN"];
  if (named) return `herdr binary: ${named} (from OVIS_HERDR_BIN)`;
  return `herdr binary: ${Bun.which("herdr") ?? "herdr, not found"} (from PATH)`;
}

/** Pin a safe classic session once. An absent explicit socket stays selected for its return. */
export async function machineSocket(stateDir: string, engine: string): Promise<string | null> {
  const unavailable = join(stateDir, "unavailable", "herdr.sock");
  if (engine !== "herdr") { process.env["HERDR_SOCKET"] = unavailable; return `${engine} is not supported for a machine yet`; }
  const named = process.env["HERDR_REMOTE_SESSION"];
  const socket = process.env["HERDR_REMOTE_SOCKET"];
  let selected = socket || (named ? join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr", "sessions", named, "herdr.sock") : process.env["HERDR_SOCKET"]);
  process.env["HERDR_SOCKET"] = unavailable;
  if (named && !/^[A-Za-z0-9_-]{1,64}$/.test(named)) return "HERDR_REMOTE_SESSION must name a herdr session";
  if (selected && !validHerdrSocket(selected)) return `${socket ? "HERDR_REMOTE_SOCKET" : named ? "HERDR_REMOTE_SESSION" : "HERDR_SOCKET"} must be an absolute path ending in /herdr.sock`;
  if (!selected) {
    const found = await discoverHerdrSessions();
    if (found.length !== 1) return found.length === 0 ? "herdr is not running for the selected session" : "Several herdr sessions are running; select one with HERDR_REMOTE_SOCKET";
    selected = found[0]?.socket_path;
  }
  if (!selected || await chosenHerdrSocketStatus(selected) === "refused") return "The selected herdr socket cannot be used safely by this account";
  process.env["HERDR_SOCKET"] = selected;
  return null;
}

/** Readiness is separate from the HTTP server's liveness and is only sent after authentication. `refusal`: why the engine serve() chose is down, null while it answers. */
export async function machineHealth(engine: string, refusal: string | null = engine === "herdr" ? null : `${engine} is not supported for a machine yet`) {
  let reason = refusal;
  let herdr: Awaited<ReturnType<typeof ping>> | undefined;
  if (reason === null) {
    try {
      herdr = await ping(herdrSocketPath(), 1500);
      if (herdr.protocol < 22) reason = "herdr protocol 22 or newer is required; update herdr explicitly";
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      reason = `${engine} is not running for the selected session`;
    }
  }
  return { machine_profile: { engine, runtime_down: reason !== null, reason }, ...(herdr ? { herdr } : {}) };
}

/** Refused before optional route handlers, for local owners and devices alike. */
export function machineRouteRestricted(path: string): boolean {
  return /^\/api\/(?:herdr\/update$|runtime(?:\/|$)|portal(?:\/|$)|fleet(?:\/|$)|machines(?:\/|$)|bridge$)/.test(path)
    || path === "/api/relay/direct" && !MACHINE_DIRECT_CARRIER_ENABLED;
}

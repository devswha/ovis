import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, dirname } from "node:path";
import { randomBytes } from "node:crypto";

import type { PaneProcessInfoProcess } from "../shared/herdr-api.generated.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { processStartIdentity } from "./process-start.ts";
import { descriptorTargets, sameDescriptors, socketInodes, unixSocketTable } from "./unix-peer.ts";

/** A live session as Prime Agent's daemon lists it (`list`, a read-only command of its protocol 7). */
export interface PrimeLiveSession { readonly activeSessionId: string; readonly sessionId: string; readonly sessionFile: string | null; readonly workerPid: number | null }
export interface PrimeDaemonList { readonly supervisorPid: number; readonly sessions: readonly PrimeLiveSession[] }

/** What the proof reads; tests stand in for the machine. */
export interface PrimeReaders {
  readonly platform: NodeJS.Platform;
  readonly descriptors: (pid: number) => Map<string, string> | null;
  readonly started: (pid: number) => number | null;
  readonly argv: (pid: number) => readonly string[] | null;
  readonly sockets: typeof unixSocketTable;
  readonly list: (socket: string) => Promise<PrimeDaemonList | null>;
  readonly header: (path: string) => { readonly id: string; readonly identity: string } | null;
}

const WORKER_SOCKET = /\/worker-[0-9a-f]+-[0-9a-f]+\.sock$/;
const DAEMON_PROTOCOL = "prime-agent.daemon";
const LIST_MS = 1_000;
const LIST_BYTES = 4 * 1024 * 1024;

/** The pane's one Prime Agent TUI: the `prime-agent` process that is not its daemon or a worker. */
function primeTui(processes: readonly PaneProcessInfoProcess[]): number | null {
  const tuis = processes.filter(({ name, argv }) => (name === "prime-agent" || basename(argv?.[0] ?? "") === "prime-agent")
    && !(argv ?? []).some((arg) => arg === "worker" || arg === "daemon" || arg === "--mode"));
  return tuis.length === 1 ? tuis[0]!.pid : null;
}

/**
 * The session file a pane's Prime Agent shows, with its identity, or null when nothing proves it (Linux only; elsewhere
 * the pane stays a terminal). Prime Agent 0.10 keeps the conversation in a background daemon, and its herdr report
 * follows the pane that created a session, not the one showing it (measured wrong after /resume, /new and /fork), so
 * neither that report, the command line nor the folder binds. What does: the pane's TUI holds a unix stream straight to
 * the worker of the session it shows. The kernel names that stream's other end and the daemon it is on; the daemon,
 * asked read-only, says which session that worker runs; the file's header must carry that session's id; and nothing may
 * have moved while it was read.
 */
export async function primeTranscriptPath(paneId: string, options: { processes?: readonly PaneProcessInfoProcess[]; readers?: PrimeReaders } = {}): Promise<{ path: string; identity: string; agentDir: string | null } | null> {
  const read = options.readers ?? PRIME_READERS;
  if (read.platform !== "linux") return null;
  const processes = options.processes ?? (await paneProcessInfo(paneId).catch(() => undefined))?.foreground_processes ?? [];
  const tui = primeTui(processes);
  if (tui === null) return null;
  const born = read.started(tui);
  const before = read.descriptors(tui);
  const table = await read.sockets();
  if (born === null || before === null || table === null) return null;
  const peers = new Set([...socketInodes(before)].flatMap((inode) => table.peers.get(inode) ?? []));
  // the one socket the TUI is on that is not a worker's: its daemon, as the kernel says, never a guessed default path
  const daemons = new Set([...peers].flatMap((inode) => table.names.get(inode) ?? []).filter((name) => !WORKER_SOCKET.test(name)));
  if (daemons.size !== 1) return null;
  const [daemon] = daemons as Set<string>;
  // a Prime Agent process in that role (`--mode daemon`, `worker`) owning one end of the TUI's streams
  const owns = (pid: number, role: "daemon" | "worker") => {
    const argv = read.argv(pid), targets = read.descriptors(pid);
    return argv !== null && basename(argv[0] ?? "") === "prime-agent" && (role === "worker" ? argv[1] === "worker" : argv.includes("daemon"))
      && targets !== null && [...socketInodes(targets)].some((inode) => peers.has(inode));
  };
  const listed = await read.list(daemon!);
  // the daemon that answered is the TUI's: its supervisor owns one end of the TUI's streams
  if (listed === null || !owns(listed.supervisorPid, "daemon")) return null;
  const linked = listed.sessions.filter(({ workerPid }) => workerPid !== null && owns(workerPid, "worker"));
  // none: a picker (the agents view) is in front, or no direct link; several: not one conversation
  if (linked.length !== 1) return null;
  const [session] = linked as [PrimeLiveSession];
  const supervisorBorn = read.started(listed.supervisorPid), workerBorn = read.started(session.workerPid!);
  if (session.sessionFile === null || supervisorBorn === null || workerBorn === null) return null;
  const header = read.header(session.sessionFile);
  if (header === null || header.id !== session.sessionId) return null;
  const again = await read.list(daemon!);
  const still = again?.sessions.find(({ activeSessionId }) => activeSessionId === session.activeSessionId);
  // pids are checked by their start too: one reused since would own none of these streams, but is not trusted to
  if (!sameDescriptors(before, read.descriptors(tui)) || read.started(tui) !== born || again?.supervisorPid !== listed.supervisorPid
    || read.started(listed.supervisorPid) !== supervisorBorn || read.started(session.workerPid!) !== workerBorn
    || still?.workerPid !== session.workerPid || still?.sessionFile !== session.sessionFile || still?.sessionId !== session.sessionId) return null;
  const store = dirname(session.sessionFile);
  return { path: session.sessionFile, identity: header.identity, agentDir: basename(store) === "sessions" ? dirname(store) : null };
}

const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const pid = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The daemon's `list`, asked under an id of Ovis's own: a TUI's id would make the daemon count this connection as that TUI's. */
export async function listPrimeDaemon(socket: string): Promise<PrimeDaemonList | null> {
  const id = `ovis-${randomBytes(6).toString("hex")}`;
  const { promise, resolve } = Promise.withResolvers<PrimeDaemonList | null>();
  // the whole exchange, connecting included, is bounded in time and bytes
  const timer = setTimeout(() => resolve(null), LIST_MS);
  let buffer = Buffer.alloc(0), supervisorPid: number | null = null;
  const answer = (link: { write(data: string): number }, line: string) => {
    let frame: Record<string, unknown> | null;
    try { frame = object(JSON.parse(line)); } catch { return; }
    if (frame === null) return;
    const protocol = object(frame.protocol);
    if (frame.type === "daemon_hello" && protocol?.name === DAEMON_PROTOCOL && pid(protocol.version) !== null) {
      supervisorPid = pid(frame.supervisorPid);
      link.write(`${JSON.stringify({ type: "command", id, protocol, clientId: id, command: { type: "list", id } })}\n`);
    } else if (frame.type === "response" && frame.id === id) {
      const rows = object(frame.data)?.sessions;
      if (frame.success !== true || supervisorPid === null || !Array.isArray(rows)) return resolve(null);
      const sessions = rows.flatMap((value: unknown) => {
        const row = object(value);
        const activeSessionId = text(row?.activeSessionId), sessionId = text(row?.sessionId);
        return row === null || activeSessionId === null || sessionId === null ? []
          : [{ activeSessionId, sessionId, sessionFile: text(row.sessionFile), workerPid: pid(row.workerPid) }];
      });
      resolve({ supervisorPid, sessions });
    }
  };
  const connecting = Bun.connect({ unix: socket, socket: {
    data(link, chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > LIST_BYTES) return resolve(null);
      for (let end = buffer.indexOf(0x0a); end >= 0; end = buffer.indexOf(0x0a)) {
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 1);
        answer(link, line);
      }
    },
    close() { resolve(null); },
    error() { resolve(null); },
  } }).catch(() => null);
  void connecting.then((link) => { if (link === null) resolve(null); });
  try { return await promise; }
  finally { clearTimeout(timer); void connecting.then((link) => link?.end()); }
}

function processArgv(pid: number): readonly string[] | null {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((arg) => arg.length > 0); } catch { return null; }
}

/** The id a session file's first line names and the file's identity: a regular file of this user, not through a link. */
function sessionHeader(path: string): { id: string; identity: string } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || (process.getuid !== undefined && Number(stat.uid) !== process.getuid())) return null;
    const head = Buffer.alloc(16 * 1024);
    const first = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString("utf8").split("\n")[0] ?? "";
    const entry = JSON.parse(first) as { type?: unknown; id?: unknown };
    return entry.type === "session" && typeof entry.id === "string" ? { id: entry.id, identity: `${stat.dev}:${stat.ino}` } : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const PRIME_READERS: PrimeReaders = {
  platform: process.platform, descriptors: descriptorTargets, started: processStartIdentity, argv: processArgv, sockets: unixSocketTable, list: listPrimeDaemon, header: sessionHeader,
};

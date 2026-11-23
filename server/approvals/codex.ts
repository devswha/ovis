/**
 * Codex on its own app server, with the real TUI on it: what an agent Ovis starts in a herdr-core pane runs, so that
 * Ovis answers Codex's approvals as data rather than as keys read off the screen.
 *
 * The pane runs a launcher Ovis writes for the launch (launcherScript): `codex app-server --listen unix://<socket>` in a
 * folder of this account only (0700, made by mkdtemp; Codex makes the socket 0600), then the real TUI on it with
 * `codex --remote unix://<socket>`. No other account can reach the socket, so it needs no token. The launcher stops
 * the server and removes the folder when the TUI ends or the pane hangs up. Both start from the pane's shell, with its
 * PATH and environment, and with the launch's own arguments: nothing of the user's Codex settings is written.
 *
 * Ovis connects to the same server (CodexServers) and subscribes to each thread once it runs (`thread/resume`, which
 * also brings back any request already waiting). Codex sends an approval to every subscribed client, the TUI draws its
 * own dialog for it, and whichever answers first wins: the server tells both with `serverRequest/resolved`, which
 * releases the card's held request, and a later answer is ignored (measured on 0.169.0 and 0.171.0). The held request
 * goes through the approval hub (hub.ts `hold`): its card is the dialog the screen reader finds (dialogs/codex.ts),
 * with the command as Codex runs it, its `/bin/bash -lc` taken off, where the screen may have cut or wrapped it.
 * A turn's end comes from `turn/completed` (servedTurnEnd).
 *
 * Whatever is not sure goes the old way, the plain TUI and the screen reader: a Codex version not measured, arguments
 * the launcher does not know, a server that does not come up (the launcher then starts plain `codex`), a connection
 * that fails or ends, and a request this file does not take.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readlinkSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { meetsMinVersion } from "../../shared/agent-catalog.ts";
import { shellCommandLine } from "../shell-agent.ts";
import type { ApprovalDecision, ApprovalHub, ApprovalRequest, ApprovalSource } from "./hub.ts";

/** The Codex versions measured with a TUI on its own server; any other runs as before. */
export const CODEX_SERVER_MIN_VERSION = "0.169.0";
export const CODEX_SERVER_BELOW_VERSION = "0.172.0";

export function supportsCodexServer(version: string): boolean {
  return meetsMinVersion(version, CODEX_SERVER_MIN_VERSION) && !meetsMinVersion(version, CODEX_SERVER_BELOW_VERSION);
}

/** How long the server may take to come up before Ovis stops waiting for it (the launcher waits 15 s). */
const CONNECT_MS = 30_000;
/** How often a socket that is there but not yet up is looked at again. */
const SOCKET_LOOK_MS = 50;
const SOCKET_NAME = "codex.sock";
/** A path a `unix://` address and a `ws+unix://` URL both take as it is, and under the shortest limit on one. */
const PLAIN_PATH = /^[A-Za-z0-9._/-]{1,100}$/;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * The words of a POSIX shell line, as `sh` splits them (quotes, backslashes, white space), or null for one it would read
 * otherwise (an unclosed quote, or anything that would expand).
 */
function shellWords(line: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  for (let at = 0; at < line.length; at++) {
    const char = line[at]!;
    if (char === "'") {
      const end = line.indexOf("'", at + 1);
      if (end < 0) return null;
      word = (word ?? "") + line.slice(at + 1, end);
      at = end;
    } else if (char === '"') {
      let inner = "";
      for (at++; at < line.length && line[at] !== '"'; at++) {
        if (line[at] === "\\" && at + 1 < line.length && '$`"\\\n'.includes(line[at + 1]!)) inner += line[++at];
        else if (line[at] === "$" || line[at] === "`") return null;
        else inner += line[at];
      }
      if (at >= line.length) return null;
      word = (word ?? "") + inner;
    } else if (char === "\\") {
      if (at + 1 >= line.length) return null;
      word = (word ?? "") + line[++at];
    } else if (char === " " || char === "\t" || char === "\n") {
      if (word !== null) words.push(word);
      word = null;
    } else if (/[$`;&|<>(){}*?[\]~#]/.test(char)) {
      return null;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

const SHELL = /^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh)$/;

/** The script a `/bin/bash -lc '<script>'` command runs, as the shell gets it; any other command as it is. */
export function shellScript(command: string): string {
  const words = shellWords(command);
  return words !== null && words.length === 3 && SHELL.test(words[0]!) && (words[1] === "-lc" || words[1] === "-c") ? words[2]! : command;
}

export const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
]);

/** A file change Codex announced (item/started), for the card of its approval. */
export interface FileChange { path: string; kind: string; diff: string }

const permissionLines = (permissions: unknown): string[] | null => {
  if (!isObject(permissions)) return null;
  const lines: string[] = [];
  const network = permissions["network"];
  if (isObject(network) && network["enabled"] === true) lines.push("network: on");
  const files = permissions["fileSystem"];
  if (isObject(files)) {
    for (const access of ["read", "write"] as const) {
      const paths = files[access];
      if (Array.isArray(paths) && paths.every((path) => typeof path === "string") && paths.length) lines.push(`${access}: ${paths.join(", ")}`);
    }
    if (Array.isArray(files["entries"]) && files["entries"].length) return null;
  }
  return lines.length ? lines : null;
};

/**
 * The card of an approval Codex asks (`method` and its params), or null for one Ovis leaves to the TUI's own dialog and
 * the screen reader: a command of another kind than a plain one (writing to a running command's input, a network
 * approval), a file change whose edits were not announced, permissions it cannot spell out, and an MCP server's form
 * that asks for more than a yes or no.
 */
export function codexCard(method: string, params: unknown, changes?: ReadonlyMap<string, FileChange[]>): ApprovalRequest | null {
  if (!isObject(params)) return null;
  const reason = text(params["reason"]);
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const command = text(params["command"]);
      if (command === null || (params["kind"] !== undefined && params["kind"] !== "command") || params["networkApprovalContext"] != null) return null;
      return { command: shellScript(command), description: reason };
    }
    case "item/fileChange/requestApproval": {
      const edits = typeof params["itemId"] === "string" ? changes?.get(params["itemId"]) : undefined;
      if (edits === undefined || edits.length === 0) return null;
      return { command: edits.map((edit) => `${edit.kind} ${edit.path}\n${edit.diff}`.trimEnd()).join("\n"), description: reason };
    }
    case "item/permissions/requestApproval": {
      const lines = permissionLines(params["permissions"]);
      return lines === null ? null : { command: lines.join("\n"), description: reason };
    }
    case "mcpServer/elicitation/request": {
      const schema = params["requestedSchema"];
      const message = text(params["message"]);
      const empty = isObject(schema) && (schema["properties"] === undefined || (isObject(schema["properties"]) && Object.keys(schema["properties"]).length === 0));
      if (params["mode"] !== "form" || message === null || !empty) return null;
      return { command: message, description: text(params["serverName"]) };
    }
    default:
      return null;
  }
}

/** What Codex takes as the answer to `method` for a card's decision, as its TUI answers: No stops the turn (cancel). */
export function codexAnswer(method: string, params: unknown, decision: ApprovalDecision): Json | null {
  const input = isObject(params) ? params : {};
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": {
      if (decision === "allow") return { decision: "accept" };
      const offered = Array.isArray(input["availableDecisions"]) ? input["availableDecisions"] : null;
      return { decision: offered === null || offered.includes("cancel") || !offered.includes("decline") ? "cancel" : "decline" };
    }
    case "item/permissions/requestApproval": {
      const asked = isObject(input["permissions"]) ? input["permissions"] : {};
      const granted = Object.fromEntries(Object.entries(asked).filter(([, value]) => value !== null));
      return { permissions: decision === "allow" ? granted : {}, scope: "turn" };
    }
    case "mcpServer/elicitation/request":
      return decision === "allow" ? { action: "accept", content: {}, _meta: null } : { action: "decline", content: null, _meta: null };
    default:
      return null;
  }
}

/** Yes allows once, No stops the turn; any other option ("don't ask again") goes to the TUI's dialog as its keys. */
export function codexDecision(label: string): ApprovalDecision | null {
  return /^Yes, (?:proceed|grant|accept)\b/.test(label) ? "allow" : /^No\b/.test(label) ? "deny" : null;
}

const SOURCE: ApprovalSource = { kind: "codex", decision: codexDecision };

/** The flags the server takes as they are; the TUI gets them too. */
const SHARED_FLAGS = new Set(["-c", "--config", "--enable", "--disable"]);
/** The TUI's own flags that take a value. */
const TUI_FLAGS = new Set(["-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval"]);

/**
 * A Codex launch's arguments split for its server and its TUI, or null for arguments the launcher does not know (a
 * subcommand, a flag it has not seen, an address of its own): that launch runs as before.
 */
export function serverArgs(args: readonly string[]): { server: string[]; tui: string[] } | null {
  const server: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") break;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!SHARED_FLAGS.has(flag) && !TUI_FLAGS.has(flag)) return null;
    const value = inline ?? args[++at];
    if (value === undefined) return null;
    if (SHARED_FLAGS.has(flag)) server.push(flag, value);
  }
  return { server, tui: [...args] };
}

/** The launcher the pane runs: the server, then the real TUI on it, or plain `codex` when the server does not come up. */
export function launcherScript(dir: string, server: readonly string[], tui: readonly string[], plain: readonly string[]): string {
  const words = (args: readonly string[]) => args.length ? ` ${shellCommandLine("posix", args[0]!, args.slice(1))}` : "";
  return [
    "#!/bin/sh",
    "# Written by Ovis for one Codex launch (server/approvals/codex.ts); removed with its folder when Codex ends.",
    `dir=${shellCommandLine("posix", dir, [])}`,
    `socket="$dir/${SOCKET_NAME}"`,
    "server=",
    'stop() { if [ -n "$server" ]; then kill "$server" 2>/dev/null; server=; fi; rm -rf "$dir"; }',
    "trap stop EXIT",
    "trap 'stop; exit 129' HUP",
    "trap 'stop; exit 143' TERM",
    // job control: the server in a process group of its own, the TUI in front of the terminal alone
    "set -m",
    `codex${words(["app-server", ...server])} --listen "unix://$socket" </dev/null >/dev/null 2>&1 &`,
    "server=$!",
    "tries=0",
    'while [ ! -S "$socket" ] && kill -0 "$server" 2>/dev/null && [ "$tries" -lt 300 ]; do sleep 0.05; tries=$((tries + 1)); done',
    'if [ ! -S "$socket" ]; then',
    "  stop",
    "  trap - EXIT HUP TERM",
    `  exec codex${words(plain)}`,
    "fi",
    `codex --remote "unix://$socket"${words(tui)}`,
    "",
  ].join("\n");
}

/**
 * Whether `path` is the server's socket, of this account: the socket itself (0.169), or as 0.171 makes it, a link to
 * `<dir>/<sha256 of path>` in a folder of this account only (Codex's own rendezvous, as for its daemon: codex-daemon.ts).
 */
export function serverSocket(path: string): boolean {
  const uid = process.getuid?.();
  try {
    let entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      const target = resolve(dirname(path), readlinkSync(path));
      const folder = lstatSync(dirname(target));
      if (!folder.isDirectory() || folder.uid !== uid || (folder.mode & 0o777) !== 0o700) return false;
      if (basename(target) !== createHash("sha256").update(path).digest("hex")) return false;
      entry = lstatSync(target);
    }
    return entry.isSocket() && entry.uid === uid;
  } catch {
    return false;
  }
}

type TurnEnd = "running" | "answered" | "failed";

interface Held { method: string; params: unknown; release: () => void }

/** Ovis's connection to one pane's Codex server. */
class Connection {
  private readonly socket: WebSocket;
  private next = 1;
  private readonly calls = new Map<number, (message: Json) => void>();
  private readonly held = new Map<string, Held>();
  private readonly subscribed = new Set<string>();
  private readonly subagents = new Set<string>();
  private readonly changes = new Map<string, FileChange[]>();
  turn: TurnEnd | null = null;
  closed = false;

  constructor(path: string, private readonly paneId: string, private readonly hub: ApprovalHub, private readonly onClose: () => void) {
    this.socket = new WebSocket(`ws+unix://${path}:/`);
    this.socket.onopen = () => void this.start();
    this.socket.onmessage = (event) => this.receive(String(event.data));
    this.socket.onclose = () => this.end();
    this.socket.onerror = () => this.end();
  }

  private call(method: string, params: Json): Promise<Json> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.calls.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  private send(message: Json): void {
    if (!this.closed) this.socket.send(JSON.stringify(message));
  }

  private async start(): Promise<void> {
    const answer = await this.call("initialize", { clientInfo: { name: "ovis", title: "Ovis", version: "0" }, capabilities: { experimentalApi: true } });
    const agent = isObject(answer["result"]) ? answer["result"]["userAgent"] : undefined;
    const version = typeof agent === "string" ? /\/(\d+\.\d+\.\d+)/.exec(agent)?.[1] : undefined;
    // a server of a version not measured is left to the TUI and the screen reader
    if (version === undefined || !supportsCodexServer(version)) return this.close();
    this.send({ method: "initialized" });
    const loaded = await this.call("thread/loaded/list", {});
    const ids = isObject(loaded["result"]) && Array.isArray(loaded["result"]["data"]) ? loaded["result"]["data"] : [];
    for (const id of ids) if (typeof id === "string") void this.subscribe(id);
  }

  /** A thread's requests come only to its subscribers; Codex refuses one that has not run yet (no rollout), tried again as it runs. */
  private async subscribe(threadId: string): Promise<void> {
    if (this.subscribed.has(threadId)) return;
    this.subscribed.add(threadId);
    const answer = await this.call("thread/resume", { threadId, excludeTurns: true });
    if (answer["error"] !== undefined) this.subscribed.delete(threadId);
  }

  private receive(data: string): void {
    let message: unknown;
    try { message = JSON.parse(data); } catch { return; }
    if (!isObject(message)) return;
    const method = message["method"];
    const params = isObject(message["params"]) ? message["params"] : {};
    if (typeof method !== "string") {
      if (typeof message["id"] === "number") {
        const resolve = this.calls.get(message["id"]);
        this.calls.delete(message["id"]);
        resolve?.(message);
      }
      return;
    }
    if (message["id"] !== undefined) return this.request(message["id"], method, params);
    const threadId = typeof params["threadId"] === "string" ? params["threadId"] : null;
    switch (method) {
      case "thread/started": {
        const thread = isObject(params["thread"]) ? params["thread"] : {};
        if (typeof thread["id"] === "string" && typeof thread["parentThreadId"] === "string") this.subagents.add(thread["id"]);
        break;
      }
      case "thread/status/changed": {
        const status = isObject(params["status"]) ? params["status"] : {};
        if (threadId === null || status["type"] !== "active") break;
        if (!this.subagents.has(threadId) && this.turn !== "running") this.turn = "running";
        void this.subscribe(threadId);
        break;
      }
      case "turn/started":
        if (threadId !== null && !this.subagents.has(threadId)) this.turn = "running";
        break;
      case "turn/completed": {
        const turn = isObject(params["turn"]) ? params["turn"] : {};
        if (threadId !== null && !this.subagents.has(threadId)) this.turn = turn["status"] === "failed" ? "failed" : "answered";
        break;
      }
      case "item/started": {
        const item = isObject(params["item"]) ? params["item"] : {};
        if (item["type"] !== "fileChange" || typeof item["id"] !== "string" || !Array.isArray(item["changes"])) break;
        const edits = item["changes"].flatMap((change): FileChange[] => {
          if (!isObject(change) || typeof change["path"] !== "string" || typeof change["diff"] !== "string") return [];
          const kind = isObject(change["kind"]) && typeof change["kind"]["type"] === "string" ? change["kind"]["type"] : "update";
          return [{ path: change["path"], kind, diff: change["diff"] }];
        });
        this.changes.set(item["id"], edits);
        break;
      }
      case "item/completed": {
        const item = isObject(params["item"]) ? params["item"] : {};
        if (typeof item["id"] === "string") this.changes.delete(item["id"]);
        break;
      }
      case "serverRequest/resolved":
        this.held.get(JSON.stringify(params["requestId"]))?.release();
        this.held.delete(JSON.stringify(params["requestId"]));
        break;
    }
  }

  /** An approval goes to the hub as a card; any other request is the TUI's to answer. */
  private request(id: unknown, method: string, params: Json): void {
    if (!APPROVAL_METHODS.has(method)) return;
    const key = JSON.stringify(id);
    if (this.held.has(key)) return;
    const card = codexCard(method, params, this.changes);
    if (card === null) return;
    const release = this.hub.hold(this.paneId, SOURCE, card, (decision) => {
      this.held.delete(key);
      const result = decision === null ? null : codexAnswer(method, params, decision);
      if (result !== null) this.send({ id, result });
    });
    if (release !== null) this.held.set(key, { method, params, release });
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const held of this.held.values()) held.release();
    this.held.clear();
    for (const resolve of this.calls.values()) resolve({ error: { message: "closed" } });
    this.calls.clear();
    this.onClose();
  }

  close(): void {
    try { this.socket.close(); } catch {}
    this.end();
  }
}

interface Served { dir: string; connection: Connection | null; stopWaiting: () => void }

const instances = new Set<CodexServers>();

/**
 * The last turn's end of the Codex Ovis started on its own server in `paneId`, as the server said (`turn/completed`):
 * null where Ovis has no connection to one there.
 */
export function servedTurnEnd(paneId: string): TurnEnd | null {
  for (const servers of instances) {
    const end = servers.turnEnd(paneId);
    if (end !== null) return end;
  }
  return null;
}

/** The Codex servers of the panes Ovis started Codex in, and its connection to each. */
export class CodexServers {
  private readonly panes = new Map<string, Served>();
  private stopped = false;

  constructor(private readonly hub: ApprovalHub, private readonly options: { tmp?: string; connectMs?: number } = {}) {
    instances.add(this);
  }

  /**
   * The launcher `paneId` runs for Codex at `version` with `args`, written for this launch, or null for a launch that
   * runs as before. Ovis connects to its server as it comes up.
   */
  launch(paneId: string, args: readonly string[] | undefined, version: string | null): string | null {
    this.forget(paneId);
    if (this.stopped || version === null || !supportsCodexServer(version)) return null;
    const split = serverArgs(args ?? []);
    if (split === null) return null;
    let dir: string;
    try {
      dir = mkdtempSync(join(this.options.tmp ?? tmpdir(), "ovis-codex-"));
    } catch (error) {
      console.error(`codex server: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    const socket = join(dir, SOCKET_NAME);
    const program = join(dir, "launch");
    if (!PLAIN_PATH.test(socket)) {
      rmSync(dir, { recursive: true, force: true });
      return null;
    }
    writeFileSync(program, launcherScript(dir, split.server, split.tui, args ?? []), { mode: 0o700 });
    const served: Served = { dir, connection: null, stopWaiting: () => {} };
    this.panes.set(paneId, served);
    this.await(paneId, served, socket);
    return program;
  }

  /** Waits for the server's socket in the launch's own folder (serverSocket), then connects to it. */
  private await(paneId: string, served: Served, socket: string): void {
    let done = false;
    let look: ReturnType<typeof setTimeout> | undefined;
    const finish = (connect: boolean) => {
      if (done) return;
      done = true;
      watcher?.close();
      clearTimeout(timer);
      clearTimeout(look);
      if (connect && this.panes.get(paneId) === served) served.connection = new Connection(socket, paneId, this.hub, () => { if (served.connection?.closed) served.connection = null; });
    };
    // the link can come before the socket it names is up
    const check = () => {
      clearTimeout(look);
      if (serverSocket(socket)) finish(true);
      else if (!done) look = setTimeout(check, SOCKET_LOOK_MS);
    };
    served.stopWaiting = () => finish(false);
    const timer = setTimeout(() => finish(false), this.options.connectMs ?? CONNECT_MS);
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      watcher = watch(served.dir, (_event, name) => { if (name === SOCKET_NAME) check(); });
      watcher.on("error", () => finish(false));
    } catch {
      return finish(false);
    }
  }

  turnEnd(paneId: string): TurnEnd | null {
    return this.panes.get(paneId)?.connection?.turn ?? null;
  }

  /** `paneId` no longer runs that Codex (it moved, ended or closed, or another agent starts there): its connection goes. */
  forget(paneId: string): void {
    const served = this.panes.get(paneId);
    if (served === undefined) return;
    this.panes.delete(paneId);
    served.stopWaiting();
    served.connection?.close();
  }

  /** A launch whose launcher never ran: Ovis stops waiting for its server and removes its folder. */
  abandon(paneId: string): void {
    const served = this.panes.get(paneId);
    this.forget(paneId);
    if (served !== undefined) rmSync(served.dir, { recursive: true, force: true });
  }

  stop(): void {
    this.stopped = true;
    for (const paneId of [...this.panes.keys()]) this.forget(paneId);
    instances.delete(this);
  }
}

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { freeAgentName } from "./agent-name.ts";
import { launchedAgents } from "./launched-agents.ts";
import { isShellAgentKind, startShellAgent, type ShellAgentLocator } from "./shell-agent.ts";
import { agentStart, HerdrError, sessionSnapshot } from "./herdr/client.ts";
import { requestFault } from "./http.ts";
import { agentStartArgs } from "./claude-settings-file.ts";
import { DSH_EFFORTS, launchArgsFault } from "../shared/launch-rules.ts";
import { BUILT_IN_BROWSER_TOOL, browserToolArgs, browserToolChoices, browserToolConfig, isBrowserToolAgent, withBrowserToolArgs, type BuiltInBrowserLaunch } from "../shared/browser-tools.ts";
import { hcMachine } from "./herdr-core/runtime.ts";
import { userHome } from "./user-home.ts";

export type AgentPayload = { kind?: unknown; name?: unknown; args?: unknown };

export function agentFault(agent: AgentPayload | undefined): string | null {
  if (agent === undefined) return null;
  if (typeof agent !== "object" || typeof agent.kind !== "string" || agent.kind.length === 0) return "agent.kind is required";
  if ((agent.name !== undefined && typeof agent.name !== "string")
    || (agent.args !== undefined && (!Array.isArray(agent.args) || !agent.args.every((arg) => typeof arg === "string")))) {
    return "agent.name must be a string and agent.args must be an array of strings";
  }
  // the dialog's model, effort and Codex prompt, checked as the dialog checks them: a client is not trusted to
  return agent.args === undefined ? null : launchArgsFault(agent.kind, agent.args as string[]);
}

/**
 * A dsh-tui launch's arguments without `--effort <level>`, which dsh-tui 0.20.0 has no flag for, and the level they
 * named. Read as launchArgsFault reads them: only before `--` (what follows is passed on as it is), and a level
 * outside DSH_EFFORTS is no level, so nothing the check would refuse is ever saved.
 */
export function dshEffortArgs(args: readonly string[]): { args: string[]; effort: string | undefined } {
  const rest: string[] = [];
  let effort: string | undefined;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") { rest.push(...args.slice(at)); break; }
    let value: string | undefined;
    if (arg === "--effort") value = args[++at] ?? "";
    else if (arg.startsWith("--effort=")) value = arg.slice("--effort=".length);
    else { rest.push(arg); continue; }
    effort = (DSH_EFFORTS as readonly string[]).includes(value) ? value : undefined;
  }
  return { args: rest, effort };
}

/**
 * Starts dsh-tui with its `--effort <level>` saved to `<home>/.dsh-tui/effort.json` instead, the file dsh-tui's own
 * `/effort <id>` writes and its boot reads (lib/types/effortPrefs.js), so the session starts on it and later ones
 * keep it, as after `/effort`; a /settings "default reasoning effort" set in dsh-tui still outranks it there. The
 * file is written just before the command is typed, since dsh-tui reads it as it boots, and put back as it was when
 * the start fails, unless something else wrote it meanwhile (even the same level). One file serves every dsh-tui and
 * none takes a level of its own, so two launches at about the same time may both start on the later level. With no
 * home a chosen level cannot be saved, so dsh-tui is not started.
 */
async function startDshTui(paneId: string, args: string[], options: { locator?: ShellAgentLocator }, home: string): Promise<number | null> {
  const { args: rest, effort } = dshEffortArgs(args);
  if (effort === undefined) return startShellAgent("dsh-tui", paneId, rest, options);
  if (home === "") throw new Error("the effort level could not be saved to ~/.dsh-tui/effort.json: this server has no home folder (HOME is not set)");
  const file = join(home, ".dsh-tui", "effort.json");
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  const written = JSON.stringify({ effort }, null, 2);
  mkdirSync(join(home, ".dsh-tui"), { recursive: true });
  writeFileSync(file, written);
  const same = (stats: Stats, then: Stats): boolean => stats.ino === then.ino && stats.size === then.size && stats.mtimeMs === then.mtimeMs && stats.ctimeMs === then.ctimeMs;
  const ours = statSync(file);
  try {
    return await startShellAgent("dsh-tui", paneId, rest, options);
  } catch (error) {
    try {
      if (existsSync(file) && same(statSync(file), ours) && readFileSync(file, "utf8") === written) {
        if (before === null) rmSync(file);
        else writeFileSync(file, before);
      }
    } catch (restoreError) {
      console.warn(`dsh-tui effort: ${file} could not be put back (${restoreError instanceof Error ? restoreError.message : String(restoreError)})`);
    }
    throw error;
  }
}

interface BuiltInBrowserHost {
  /** the desktop app's socket for its built-in browser (OVIS_BROWSER_SOCKET), null outside the desktop app */
  socket: string | null;
  /** whether the shared Built-in browser setting is on */
  enabled: () => boolean;
  /** where each pane's token goes (shared/browser-broker.ts BROWSER_TOKENS_DIR) */
  tokensDir: string;
  /** the server's own program and the arguments that run its `browser-mcp` entry */
  command: string[];
}

let browserTools: { read: () => unknown; dir: string; builtIn: BuiltInBrowserHost | null } | null = null;

/**
 * Where the launch reads the shared `agentBrowserTools` setting from, the folder its MCP config files go in, and what
 * the desktop app's built-in browser needs (null: never offered).
 */
export function readBrowserToolSetting(read: () => unknown, dir: string, builtIn: BuiltInBrowserHost | null = null): void {
  browserTools = { read, dir: resolve(dir), builtIn };
}

/** writes `text` at `file` through a new file renamed over it (only the user can read it): a link there is replaced, never written through */
function writeAnew(file: string, text: string): void {
  const staged = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staged, text, { flag: "wx", mode: 0o600 });
    renameSync(staged, file);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
}

/**
 * A pane's token for the built-in browser, under a key made for this launch (shared/browser-broker.ts): the token file
 * and, beside it, the pane that owns it. A pane moved keeps its key and only that owner changes, so a later pane given
 * the old id never meets this agent's token. The app takes calls only while the token is there.
 */
function builtInLaunch(host: BuiltInBrowserHost, paneId: string): (BuiltInBrowserLaunch & { key: string }) | null {
  // no socket where the app said it would be (the app not up): the agent starts without the tool, and no token is written
  if (host.socket === null || !host.enabled() || !/^[A-Za-z0-9_-]{1,120}$/.test(paneId) || !existsSync(host.socket)) return null;
  const key = randomBytes(16).toString("hex");
  const tokenFile = join(host.tokensDir, `${key}.token`);
  if ([host.socket, tokenFile, ...host.command].some((part) => part.includes("'"))) return null;
  // the pane's agent started anew: its earlier tokens go
  forgetBuiltInBrowserToken(paneId);
  mkdirSync(host.tokensDir, { recursive: true, mode: 0o700 });
  builtInGrantedAt.set(key, Date.now());
  writeAnew(join(host.tokensDir, `${key}.pane`), paneId);
  writeAnew(tokenFile, randomBytes(32).toString("base64url"));
  return { command: host.command, socket: host.socket, tokenFile, key };
}

/**
 * When this server issued or moved each key's token, by the clock a snapshot's asking time is read from (Date.now()):
 * a key not here is older than every snapshot this server asked for.
 */
const builtInGrantedAt = new Map<string, number>();

/** each token key with the pane that owns it now */
function builtInOwners(tokensDir: string): { key: string; pane: string }[] {
  let names: string[];
  try {
    names = readdirSync(tokensDir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const key = /^([A-Za-z0-9_-]{1,120})\.pane$/.exec(name)?.[1];
    if (key === undefined) return [];
    try {
      return [{ key, pane: readFileSync(join(tokensDir, name), "utf8").trim() }];
    } catch {
      return [];
    }
  });
}

/** removes a launch's token, its owner and the agent config made for it */
function dropBuiltInKey(host: BuiltInBrowserHost, key: string): void {
  builtInGrantedAt.delete(key);
  for (const name of [`${key}.token`, `${key}.pane`]) rmSync(join(host.tokensDir, name), { force: true });
  if (!browserTools) return;
  let configs: string[];
  try {
    configs = readdirSync(browserTools.dir);
  } catch {
    return;
  }
  for (const name of configs) if (name.endsWith(`-${key}.json`)) rmSync(join(browserTools.dir, name), { force: true });
}

/** Takes back a pane's token for the built-in browser: its agent's calls stop being answered at once. */
export function forgetBuiltInBrowserToken(paneId: string): void {
  const host = browserTools?.builtIn;
  if (!host) return;
  for (const { key, pane } of builtInOwners(host.tokensDir)) if (pane === paneId) dropBuiltInKey(host, key);
}

/**
 * Takes back the tokens of panes not in a snapshot asked for at `askedAt` (one that ended while the server was not running
 * heard no end). A token issued or moved since the snapshot was asked for is newer than it, and kept.
 */
export function keepBuiltInBrowserTokens(paneIds: ReadonlySet<string>, askedAt: number): void {
  const host = browserTools?.builtIn;
  if (!host) return;
  const owners = builtInOwners(host.tokensDir);
  for (const { key, pane } of owners) {
    const at = builtInGrantedAt.get(key);
    if (!paneIds.has(pane) && (at === undefined || at < askedAt)) dropBuiltInKey(host, key);
  }
  // a token with no pane beside it is no launch's (the app answers none): it goes too
  const keys = new Set(owners.map(({ key }) => key));
  try {
    for (const name of readdirSync(host.tokensDir)) {
      const key = /^([A-Za-z0-9_-]{1,120})\.token$/.exec(name)?.[1];
      if (key !== undefined && !keys.has(key) && !builtInGrantedAt.has(key)) rmSync(join(host.tokensDir, name), { force: true });
    }
  } catch {}
}

/** A pane moved (herdr gave it another id): its agent keeps its token, now owned by the new id. */
export function moveBuiltInBrowserToken(from: string, to: string): void {
  const host = browserTools?.builtIn;
  if (!host || !/^[A-Za-z0-9_-]{1,120}$/.test(to)) return;
  for (const { key, pane } of builtInOwners(host.tokensDir)) {
    if (pane !== from) continue;
    builtInGrantedAt.set(key, Date.now());
    writeAnew(join(host.tokensDir, `${key}.pane`), to);
  }
}

export function withBrowserTool(kind: string, args: string[] | undefined, platform: string, paneId?: string): string[] | undefined {
  if (browserTools === null || !isBrowserToolAgent(kind)) return args;
  const tool = browserToolChoices(browserTools.read())[kind];
  if (tool === undefined) return args;
  let builtIn: (BuiltInBrowserLaunch & { key: string }) | undefined;
  if (tool === BUILT_IN_BROWSER_TOOL) {
    // the app's socket and the token are this PC's: an agent another machine of the core starts cannot reach them
    const launch = browserTools.builtIn !== null && paneId !== undefined && hcMachine() === null ? builtInLaunch(browserTools.builtIn, paneId) : null;
    if (launch === null) {
      console.warn(`browser tool: the built-in browser is not added to ${kind}: it is off, or this server does not run in the desktop app`);
      return args;
    }
    builtIn = launch;
  }
  let file = "";
  if (kind !== "codex") {
    if (hcMachine() !== null) {
      console.warn(`browser tool: not added to ${kind}, which starts on another machine than this PC's config file`);
      return args;
    }
    file = join(browserTools.dir, builtIn === undefined ? `${kind}-${tool}.json` : `${kind}-${tool}-${builtIn.key}.json`);
    const config = browserToolConfig(kind, tool, platform, builtIn);
    if (!existsSync(file) || readFileSync(file, "utf8") !== config) {
      mkdirSync(browserTools.dir, { recursive: true, mode: 0o700 });
      // a new file renamed over the old one: a link left at that name is replaced, never written through
      const staged = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(staged, config, { flag: "wx", mode: 0o600 });
        renameSync(staged, file);
      } catch (error) {
        rmSync(staged, { force: true });
        throw error;
      }
    }
  }
  return withBrowserToolArgs(args ?? [], browserToolArgs(kind, tool, platform, file, builtIn));
}

export async function agentLaunch(paneId: string, agent: AgentPayload, launched?: (pid: number) => void, locator?: ShellAgentLocator, options: { platform?: string; settingsDir?: string; home?: string } = {}): Promise<{ agent_started: true } | { agent_started: false; error: { code: string; message: string } }> {
  try {
    const kind = agent.kind as string;
    const args = agent.args as string[] | undefined;
    if (isShellAgentKind(kind)) {
      // another machine of the core: its path would be this PC's, and its start is never seen there (no pids)
      if (hcMachine() !== null) return { agent_started: false, error: { code: "other_machine", message: `${kind} starts only on the PC that runs Ovis` } };
      const shellOptions = locator ? { locator } : {};
      const pid = kind === "dsh-tui" && args !== undefined
        ? await startDshTui(paneId, args, shellOptions, options.home ?? userHome())
        : await startShellAgent(kind, paneId, args, shellOptions);
      if (pid !== null) launched?.(pid);
    }
    else {
      const given = typeof agent.name === "string" && agent.name.length > 0 ? agent.name : null;
      // on Windows a Claude Code's inline JSON --settings goes as a file's path (server/claude-settings-file.ts)
      const launchArgs = withBrowserTool(kind, args, options.platform ?? process.platform, paneId);
      const startArgs = launchArgs === undefined ? undefined : agentStartArgs(kind, launchArgs, { platform: options.platform, dir: options.settingsDir });
      // herdr refuses a name another agent holds. Two creations at once can pick the same
      // free one: the refused one picks again. It also refuses a pane whose shell is not up
      // yet (`agent_pane_busy`, herdr 0.9.3), which a pane made a moment ago can be.
      const shellDeadline = Date.now() + 10_000;
      for (let attempt = 1; ; ) {
        try {
          await agentStart({
            name: given ?? freeAgentName(kind, (await sessionSnapshot()).agents.map((running) => running.name)),
            kind,
            paneId,
            ...(startArgs === undefined ? {} : { args: startArgs }),
            timeoutMs: 60_000,
          });
          break;
        } catch (error) {
          if (!(error instanceof HerdrError)) throw error;
          if (error.code === "agent_pane_busy" && Date.now() < shellDeadline) {
            await Bun.sleep(100);
            continue;
          }
          if (given !== null || attempt === 3 || error.code !== "agent_name_taken") throw error;
          attempt += 1;
        }
      }
    }
    launchedAgents.launched(paneId, kind);
    return { agent_started: true };
  } catch (error) {
    return {
      agent_started: false,
      error: requestFault(error, "agent_start_failed"),
    };
  }
}

import type { CommandForm, HerdrPane, SlashCommand } from "../shared/protocol.ts";
import { FileBusyError, fileTask } from "./file-pool.ts";
import type { FileTask } from "./file-tasks.ts";
import { AGENT_SOURCES } from "./skills/index.ts";
import type { AgentCommandSource, ProcessRoots } from "./skills/index.ts";
import { ancestorsToRepoRoot } from "./skills/walk.ts";
import { userHome } from "./user-home.ts";

const DESCRIPTIONS: Record<string, string> = {
  clear: "Clear the conversation", compact: "Compact conversation context", config: "Open configuration",
  cost: "Show token usage and cost", help: "Show available commands", init: "Initialize project instructions",
  memory: "Edit agent memory", model: "Choose a model", permissions: "Manage tool permissions", review: "Review changes",
  status: "Show session status", doctor: "Check the installation", login: "Sign in", logout: "Sign out",
  "pr-comments": "Fetch pull request comments", "release-notes": "Show release notes", "terminal-setup": "Configure terminal integration",
  vim: "Toggle Vim mode", new: "Start a new session", sessions: "List sessions", exit: "Exit the agent",
  diff: "Show the current diff", quit: "Exit the agent",
  goal: "[condition|clear] — Keep working until a condition is met",
  effort: "Set effort level for model usage",
};

const UNKNOWN_FORMS: readonly CommandForm[] = [{ match: "bare", interaction: "unknown" }];

const majorMinor = (version: string | null | undefined): string | null => version?.match(/^(\d+)\.(\d+)(?:\D|$)/)?.slice(1, 3).join(".") ?? null;

function visibility(source: AgentCommandSource, name: string): NonNullable<SlashCommand["visibility"]> {
  if (source.terminalBound?.includes(name)) return "terminal";
  if (source.agentHidden?.includes(name)) return "agent-hidden";
  return "offered";
}

/** Static metadata only: safe on the delivery path, with no filesystem or process discovery. */
export function builtinCommands(agent: string | null | undefined, version?: string | null): SlashCommand[] {
  if (!agent || !Object.hasOwn(AGENT_SOURCES, agent)) return [];
  const source = AGENT_SOURCES[agent];
  if (!source) return [];
  const running = majorMinor(version);
  const verified = running !== null && [source.pin ?? []].flat().some((pin) => majorMinor(pin) === running);
  const builtinNames = [...new Set([...source.builtins, ...(source.terminalBound ?? []), ...(source.agentHidden ?? [])])];
  return builtinNames.map((name) => ({
    name, description: source.descriptions?.[name] ?? DESCRIPTIONS[name] ?? `Run /${name}`, source: "builtin",
    forms: [...(source.forms?.[name] ?? UNKNOWN_FORMS)], visibility: visibility(source, name), provenance: { transport: "static", verified },
  }));
}

const paneCatalogs = new Map<string, { identity: string; agent: string | null; commands: SlashCommand[] }>();
const catalogIdentity = (pane: HerdrPane): string => JSON.stringify([pane.terminal_id, pane.agent_session, pane.agent, pane.foreground_cwd ?? pane.cwd]);

/** Remember only catalogs already requested by the browser; never discover during a send. */
export function rememberPaneCommands(pane: HerdrPane, agent: string | null, commands: SlashCommand[]): void {
  paneCatalogs.delete(pane.pane_id);
  paneCatalogs.set(pane.pane_id, { identity: catalogIdentity(pane), agent, commands });
  if (paneCatalogs.size > 128) paneCatalogs.delete(paneCatalogs.keys().next().value!);
}

export function cachedPaneCommands(pane: HerdrPane): { agent: string | null; commands: SlashCommand[] } | undefined {
  const cached = paneCatalogs.get(pane.pane_id);
  return cached?.identity === catalogIdentity(pane) ? cached : undefined;
}

/**
 * How long one request waits for a scan before it is answered 503: under the minute a signed-in API
 * request may go without a byte before Bun closes it (`index.ts`).
 */
export const COMMANDS_WAIT_MS = 45_000;
let waitMs = COMMANDS_WAIT_MS;

/** For tests: how long a request waits for a scan; no argument restores the default. */
export function setCommandsWait(ms = COMMANDS_WAIT_MS): void {
  waitMs = ms;
}

/** Scans under way, by what they were asked: a request for the same scan waits for that one. */
const scans = new Map<string, Promise<SlashCommand[]>>();

/**
 * `paneCommands` run on a file thread (`file-pool.ts`), never on the server's: the scan reads every
 * skill and command folder the agent would, synchronously, and a folder on a slow mount (9p, a
 * network share) took 10-27 s there, stalling every terminal and request with it (#2254).
 *
 * A request waits for its scan at most `COMMANDS_WAIT_MS`, or until `signal` aborts, and is then
 * refused with `FileBusyError` (503); the scan itself goes on, and a request for the same scan made
 * meanwhile (the menu asks again after a failed read) waits for it rather than starting another, so
 * a scan slower than one request's wait still answers the next. A finished scan is not kept: the
 * next request scans again, and sees a skill added since. An agent with no scan answers at once,
 * without a thread.
 */
export function scanPaneCommands(agent: string | null | undefined, cwd: string | null | undefined, process: ProcessRoots = {}, version?: string | null, signal?: AbortSignal): Promise<SlashCommand[]> {
  if (!agent || !Object.hasOwn(AGENT_SOURCES, agent)) return Promise.resolve([]);
  if (signal?.aborted) return Promise.reject(new FileBusyError("the request was cancelled"));
  // plain data only: a thread is handed a copy
  const roots: ProcessRoots = { agentDir: process.agentDir ?? null, pluginDir: process.pluginDir ?? null, environ: process.environ ?? null };
  const task: FileTask = { op: "commands", agent, cwd: cwd ?? null, home: userHome(), roots, version: version ?? null, serverEnv: { ...globalThis.process.env } };
  const key = JSON.stringify(task);
  let scan = scans.get(key);
  if (scan === undefined) {
    const started = fileTask<SlashCommand[]>(task);
    scan = started;
    const forget = () => { if (scans.get(key) === started) scans.delete(key); };
    started.then(forget, forget);
    scans.set(key, started);
  }
  const running = scan;
  return new Promise<SlashCommand[]>((done, fail) => {
    let waiting = true;
    const leave = (): boolean => {
      if (!waiting) return false;
      waiting = false;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      return true;
    };
    const timer = setTimeout(() => { if (leave()) fail(new FileBusyError("the skill folders did not answer in time")); }, waitMs);
    const cancel = () => { if (leave()) fail(new FileBusyError("the request was cancelled")); };
    signal?.addEventListener("abort", cancel, { once: true });
    running.then((commands) => { if (leave()) done(commands); }, (error: unknown) => { if (leave()) fail(error); });
  });
}

export function paneCommands(agent: string | null | undefined, cwd: string | null | undefined, home = userHome(), process: ProcessRoots = {}, version?: string | null, serverEnv?: Readonly<Record<string, string | undefined>>): SlashCommand[] {
  if (!agent || !Object.hasOwn(AGENT_SOURCES, agent)) return [];
  const source = AGENT_SOURCES[agent];
  if (!source) return [];
  const builtins = new Map(builtinCommands(agent, version).map((command) => [command.name, command]));
  const ancestors = cwd ? ancestorsToRepoRoot(cwd, home) : [];
  const discovered = source.discover({ home, cwd, repoRoot: ancestors.at(-1) ?? null, env: process.environ ?? null, roots: process, version, ...(serverEnv ? { serverEnv } : {}) });
  const commands: SlashCommand[] = [];
  // one row per file: the same (trigger, name, id) reached twice, e.g. through a link; a row without an id is its own
  const seen = new Set<string>();
  for (const found of discovered) {
    const trigger = found.trigger ?? "/";
    if (found.id !== undefined) {
      const key = JSON.stringify([trigger, found.name, found.id]);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const command: SlashCommand = { ...found, forms: found.forms ?? [...UNKNOWN_FORMS], visibility: found.visibility ?? "offered", provenance: found.provenance ?? { transport: "scan", verified: false } };
    // typed the same way as a builtin, a skill replaces it only where the agent says its skills win
    if (trigger === "/" && source.skillsOverrideBuiltins && builtins.delete(found.name)) command.shadows = "builtin";
    commands.push(command);
  }
  return [...builtins.values(), ...commands].sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
}

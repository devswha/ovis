/**
 * The browser tool an agent Ovis starts may be given (Settings → Agents → Browser tool): an MCP server the agent
 * runs itself, pinned to one version, whose browser keeps its profile only for the session (`--isolated`), so
 * none of the user's sign-ins goes with it. Ovis neither sees nor limits that browser.
 *
 * Only agents that take an MCP server on their command line are offered one: the server adds it to the launch
 * (server/agent-launch.ts) and never writes the agent's own settings. Checked 2026-11-21 with each CLI's
 * `--help` and a start in an empty HOME: Claude Code 2.1.326 (`--mcp-config <file>`), Codex 0.169.0
 * (`-c mcp_servers.<name>.…`), GitHub Copilot CLI 1.0.109 (`--additional-mcp-config @<file>`). Left out: agents
 * whose `mcp` commands write their own settings files (grok, agy, droid, letta, OpenCode), and Gajae Code, whose
 * `--mcp-config` waits at most 1.75 s for a server to connect, less than an `npx` start takes.
 */
export const BROWSER_TOOLS = {
  "chrome-devtools": { name: "Chrome DevTools MCP", package: "chrome-devtools-mcp", version: "1.13.0" },
  playwright: { name: "Playwright MCP", package: "@playwright/mcp", version: "0.0.86" },
} as const;
/**
 * The desktop app's own built-in browser (shared/browser-broker.ts): the agent runs `ovis-server browser-mcp`, which
 * reaches the app's agent tabs over a socket of this PC with the pane's token. Offered only where the desktop app
 * runs the server (it names the socket) and its Built-in browser setting is on; Ovis's block list applies to it.
 */
export const BUILT_IN_BROWSER_TOOL = "ovis";
/** what the launch of the built-in browser's MCP server needs from this PC's server */
export interface BuiltInBrowserLaunch {
  /** the server's own program and the arguments that run its `browser-mcp` entry */
  command: string[];
  socket: string;
  tokenFile: string;
}
export type BrowserToolId = keyof typeof BROWSER_TOOLS | typeof BUILT_IN_BROWSER_TOOL;
export const BROWSER_TOOL_IDS = [...Object.keys(BROWSER_TOOLS), BUILT_IN_BROWSER_TOOL] as BrowserToolId[];

export const BROWSER_TOOL_AGENTS = ["claude", "codex", "copilot"] as const;
export type BrowserToolAgent = (typeof BROWSER_TOOL_AGENTS)[number];
/** the shared setting `agentBrowserTools`: an agent that is absent gets none */
export type BrowserToolChoices = Partial<Record<BrowserToolAgent, BrowserToolId>>;

/** the name the tool's MCP server has in the agent, so the user's own servers of the same tool keep theirs */
export const BROWSER_TOOL_SERVER = "ovis-browser";

export const isBrowserToolAgent = (kind: string): kind is BrowserToolAgent => (BROWSER_TOOL_AGENTS as readonly string[]).includes(kind);
const isBrowserTool = (value: unknown): value is BrowserToolId => typeof value === "string" && (BROWSER_TOOL_IDS as readonly string[]).includes(value);

/** the choices kept from a stored value: only a known tool for an agent that takes one */
export function browserToolChoices(value: unknown): BrowserToolChoices {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const choices: BrowserToolChoices = {};
  for (const agent of BROWSER_TOOL_AGENTS) {
    const tool = (value as Record<string, unknown>)[agent];
    if (isBrowserTool(tool)) choices[agent] = tool;
  }
  return choices;
}

/**
 * The command the agent runs for the tool. On Windows `npx` is a batch file, which an agent starts only through cmd.
 * The built-in browser's is the server's own `browser-mcp` entry, shown as `ovis-server browser-mcp` without `builtIn`.
 */
export function browserToolCommand(tool: BrowserToolId, platform: string, builtIn?: BuiltInBrowserLaunch): string[] {
  if (tool === BUILT_IN_BROWSER_TOOL) return builtIn === undefined ? ["ovis-server", "browser-mcp"] : [...builtIn.command, "--socket", builtIn.socket, "--token-file", builtIn.tokenFile];
  const { package: name, version } = BROWSER_TOOLS[tool];
  const npx = ["npx", "-y", `${name}@${version}`, "--isolated"];
  return platform === "win32" ? ["cmd", "/c", ...npx] : npx;
}

/** The MCP config file Claude Code or Copilot reads the tool from; Codex takes it as `-c` settings instead. */
export function browserToolConfig(agent: Exclude<BrowserToolAgent, "codex">, tool: BrowserToolId, platform: string, builtIn?: BuiltInBrowserLaunch): string {
  const [command, ...args] = browserToolCommand(tool, platform, builtIn);
  const server = agent === "claude" ? { type: "stdio", command, args } : { type: "local", command, args, tools: ["*"] };
  return `${JSON.stringify({ mcpServers: { [BROWSER_TOOL_SERVER]: server } }, null, 2)}\n`;
}

/** a TOML literal string: the tool's words never hold a quote (a built-in path that does is refused), and single quotes survive Windows PowerShell's passing on */
const literal = (text: string): string => `'${text}'`;

/** The arguments that give the agent the tool, `file` being where its browserToolConfig was written (unused for Codex). */
export function browserToolArgs(agent: BrowserToolAgent, tool: BrowserToolId, platform: string, file: string, builtIn?: BuiltInBrowserLaunch): string[] {
  if (agent === "claude") return ["--mcp-config", file];
  if (agent === "copilot") return ["--additional-mcp-config", `@${file}`];
  const [command, ...args] = browserToolCommand(tool, platform, builtIn);
  return [
    "-c", `mcp_servers.${BROWSER_TOOL_SERVER}.command=${literal(command!)}`,
    "-c", `mcp_servers.${BROWSER_TOOL_SERVER}.args=[${args.map(literal).join(",")}]`,
  ];
}

/** `args` with the tool's arguments put before a `--` that ends the options (Codex's prompt follows it), else at the end */
export function withBrowserToolArgs(args: readonly string[], added: readonly string[]): string[] {
  const end = args.indexOf("--");
  return end < 0 ? [...args, ...added] : [...args.slice(0, end), ...added, ...args.slice(end)];
}

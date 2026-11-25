import { realpathSync } from "node:fs";
import { parseVersion } from "../../shared/agent-catalog.ts";
import { isBrowserToolAgent } from "../../shared/browser-tools.ts";
import type { Capabilities } from "../../shared/harness-contract.generated.ts";
import { runVersion, VERSION_TIMEOUT_MS } from "../agent-catalog-detect.ts";

const adapters = {
  claude: { command: "claude-agent-acp", pathVar: "CLAUDE_CODE_EXECUTABLE" },
  codex: { command: "codex-acp", pathVar: "CODEX_PATH" },
} as const;
export interface HarnessCommand {
  readonly argv: readonly string[];
  readonly env?: Record<string, string>;
  readonly sessionMeta?: unknown;
}
/** The file a link on PATH names, or null once it is gone. */
const resolved = (path: string | null): string | null => {
  try { return path && realpathSync(path); } catch { return null; }
};
export function resolveHarness(kind: string): HarnessCommand | null {
  switch (kind) {
    case "gjc": case "opencode": case "agy": case "copilot": {
      const path = resolved(Bun.which(kind, { PATH: process.env["PATH"] }));
      if (!path) return null;
      switch (kind) {
        case "gjc": return { argv: [path, "--mode", "acp"] };
        case "opencode": return { argv: [path, "acp"] };
        case "agy": return { argv: [path, "acp", "--disable-telemetry", "--log-file", "/dev/null"], env: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" } };
        case "copilot": return { argv: [path, "--acp", "--stdio", "--no-auto-update"] };
      }
    }
    case "claude": case "codex": {
      const adapter = adapters[kind];
      const script = resolved(Bun.which(adapter.command, { PATH: process.env["PATH"] })), executable = resolved(Bun.which(kind, { PATH: process.env["PATH"] }));
      if (!script || !executable) return null;
      const env = { [adapter.pathVar]: executable };
      return kind === "claude"
        ? { argv: [script, "--hide-claude-auth"], env, sessionMeta: { claudeCode: { options: { allowDangerouslySkipPermissions: false } } } }
        : { argv: [script], env };
    }
    default: return null;
  }
}

/** Report the harness version, not the adapter version. Version discovery never gates launch. */
export async function harnessVersion(kind: string, command: HarnessCommand): Promise<string | undefined> {
  const executable = kind === "claude" || kind === "codex" ? command.env?.[adapters[kind].pathVar] : command.argv[0];
  if (executable) {
    const probe = await runVersion(executable, ["--version"], VERSION_TIMEOUT_MS).catch(() => null);
    if (probe?.exitCode === 0) return parseVersion(probe.stdout) ?? undefined;
  }
  return undefined;
}

// These are ACP mode IDs, not permission settings. Some harnesses can pre-approve actions
// in their ordinary modes without exposing an all-access mode on the wire.
const FULL_ACCESS_MODES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["claude", new Set(["bypassPermissions"])],
  ["codex", new Set(["agent-full-access"])],
  ["copilot", new Set(["autopilot", "allow-all", "https://agentclientprotocol.com/protocol/session-modes#autopilot", "https://agentclientprotocol.com/protocol/session-modes#allow-all"])],
]);
export const isFullAccessMode = (kind: string, mode: string): boolean => FULL_ACCESS_MODES.get(kind)?.has(mode) === true;

/**
 * What `agent_harnesses` announces for one harness on this PC, built in this one place from what Ovis can prove here:
 * an ACP launch it resolves (resolveHarness), an approval hook the hub handles, the browser tool. A flag that is not
 * proven reports its safe value (docs/harness-contract.md, "Capability flags").
 */
export function harnessCapabilities(kind: string, hasHook: boolean): Capabilities {
  const acp = resolveHarness(kind) !== null, browser = isBrowserToolAgent(kind);
  return {
    drive: acp ? ["terminal", "acp"] : ["terminal"], level: acp ? "structured" : "terminal", acp_protocol: acp ? 1 : null,
    approvals: ["keys", ...(hasHook ? ["hook"] : []), ...(acp ? ["acp"] : [])], transcript: acp ? "acp" : "none", turn_end: acp ? "strong" : "weak", turn_end_from: acp ? ["acp"] : ["terminal"],
    model_switch: "none", resume: false, images: false, slash_commands: false, subagents: false, tool_delivery: browser || acp ? ["mcp", "shell"] : [],
    browser_tool: browser, memory_tool: false,
  };
}

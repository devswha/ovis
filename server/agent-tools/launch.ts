import { join } from "node:path";
import { browserToolChoices, browserToolCommand, isBrowserToolAgent, mcpLaunchArgs, mcpLaunchConfig, withBrowserToolArgs } from "../../shared/browser-tools.ts";
import { hcMachine } from "../herdr-core/runtime.ts";
import { capabilities } from "../runtime/capabilities.ts";
import type { AgentToolHub } from "./hub.ts";
import { privateDir, writePrivate } from "./runs.ts";

let hub: AgentToolHub | null = null;
export function useAgentToolHub(current: AgentToolHub | null): void { hub = current; }
export function forgetLocalRun(pane: string): void { if (hcMachine() === null) hub?.runs.forgetTerminal(pane); }
export function launchHarnessTool(pane: string, kind: string, options: { args?: string[]; platform: string; browsers: unknown }) {
  if (!hub || hcMachine() !== null || !capabilities().acpChildren || options.platform === "win32") return null;
  if (!isBrowserToolAgent(kind) || hub.setting.level === "off") return null;
  const r = hub.runs.reserve();
  try {
    const relay = hub.command(r.tokenFile);
    const tools = [{ name: relay.name, command: relay.command, args: relay.args }];
    const browser = browserToolChoices(options.browsers)[kind];
    if (browser) {
      const [command, ...args] = browserToolCommand(browser, options.platform);
      tools.push({ name: "ovis-browser", command, args });
    }
    let file = "";
    if (kind !== "codex") {
      const dir = join(hub.runs.dir, "mcp");
      privateDir(dir);
      file = join(dir, `${r.id}.json`);
      writePrivate(file, mcpLaunchConfig(kind, tools));
    }
    r.bind({ self: pane, depth: 0, started_by: null, root: r.id, harness: kind });
    return { args: withBrowserToolArgs(options.args ?? [], mcpLaunchArgs(kind, tools, file)), cancel: r.cancel, socket: hub.address, tokenFile: r.tokenFile };
  } catch (error) { r.cancel(); throw error; }
}

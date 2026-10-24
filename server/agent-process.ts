import { agentProcesses } from "./conversation.ts";
import type { ProcessInfo } from "./herdr/client.ts";

type ForegroundProcess = NonNullable<ProcessInfo["foreground_processes"]>[number];

/**
 * The agent process in front of a pane: what a pending send (core/pending.ts currentIdentity) and a command
 * outcome (prompt.ts outcomeProcess) are both bound to, picked here so the two cannot drift. `bound` (the process a
 * send was bound to, or the one its launch reported) while herdr still lists it, else the agent's own program
 * (agentProcesses: its native binary before an interpreter or launcher running it), else none. Never the shell.
 */
export function agentProcessInFront(info: ProcessInfo | null | undefined, agent: string | null | undefined, bound?: number | null): ForegroundProcess | null {
  const foreground = info?.foreground_processes ?? [];
  const listed = bound == null ? undefined : foreground.find((entry) => entry.pid === bound);
  return listed ?? (agent ? agentProcesses(foreground, agent)[0] ?? null : null);
}

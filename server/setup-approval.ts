import type { MachineAction, SshTarget } from "../shared/machines.ts";

/** The one install-list line that may skip the approval wait. Copy it from here; do not retype it. */
export const START_BRIDGE_INSTALL = "Start the loopback bridge and, only if absent, the herdr daemon";

export function bridgeInstalls(input: {
  ownUpdate: { latest_version?: string | null } | undefined;
  update: boolean;
  hasDescriptor: boolean;
  hasBundle: boolean;
  hasHerdr: boolean;
  hasJob: boolean;
  usedSecret: boolean;
  bundleDescription: string;
  herdrLine: string;
}): string[] {
  const installs: string[] = [];
  if (input.ownUpdate) installs.push(`Ask this PC's own Ovis to install its update${input.ownUpdate.latest_version ? ` v${input.ownUpdate.latest_version}` : ""} through its own updater, then reconnect (herdr sessions keep running)`);
  if (input.update) installs.push("Download and verify the bridge runtime, then restart this bridge (herdr sessions keep running)");
  if (!input.hasDescriptor && !input.hasBundle) installs.push(input.bundleDescription);
  if (!input.hasDescriptor && !input.hasHerdr) installs.push(input.herdrLine);
  if (!input.hasDescriptor && input.hasJob) installs.push(START_BRIDGE_INSTALL);
  if (input.usedSecret) installs.push("Register a dedicated SSH public key for automatic reconnection");
  return installs;
}

/** What sync should do with one enabled-or-not herdr profile after reconcile. */
export function linkHerdrProfile(
  machine: { action_required?: MachineAction | null; error: string | null; state: string },
  flags: { enabled: boolean; firstSight: boolean; hasTarget: boolean; allowed: boolean; wantsReconnect: boolean },
  first: () => void,
  again: () => void,
): void {
  if (!flags.enabled) {
    machine.action_required = null;
    machine.error = flags.hasTarget ? "Disabled in herdr" : "This saved herdr machine uses an unsupported SSH address or session.";
    return;
  }
  if (flags.firstSight && flags.hasTarget) { first(); return; }
  if (!flags.allowed) {
    if (flags.wantsReconnect || (!machine.action_required && machine.state !== "error")) {
      machine.action_required = "connect";
      machine.error = null;
    }
    return;
  }
  if (flags.wantsReconnect) again();
}

export function acceptFirstSight(state: { allowConnection(id: string, target: SshTarget): void }, persist: () => void, machine: { herdr_profile_id?: string; target?: SshTarget }): void {
  const id = machine.herdr_profile_id;
  const target = machine.target;
  if (!id || !target) return;
  state.allowConnection(id, target);
  persist();
}

/** A failed first look must not keep the reconnect timer: consent was not recorded, so later calls would no-op. `lost()` already advanced generation by one. */
export function releaseUnapprovedFirstSight(
  runtime: { generation: number; retry?: ReturnType<typeof setTimeout>; machine: { enabled: boolean; state: string; action_required?: MachineAction | null } },
  generation: number,
  stopped: boolean,
  allowed: boolean,
): boolean {
  if (runtime.generation !== generation + 1 || stopped || !runtime.machine.enabled || allowed) return false;
  clearTimeout(runtime.retry);
  runtime.retry = undefined;
  if (runtime.machine.state === "reconnecting") runtime.machine.state = "error";
  if (!runtime.machine.action_required) runtime.machine.action_required = "connect";
  return true;
}

/**
 * True when the operator must approve before setup continues.
 * The start-bridge line skips that wait only when it is the entire list and both the bundle and herdr are already on the PC.
 * Any other sentence, including a one-character drift of this one, fails closed and waits.
 */
export function needsApproval(installs: readonly string[], ready: { bundleReady: boolean; herdrPresent: boolean }): boolean {
  if (installs.length === 0) return false;
  return !(installs.length === 1 && installs[0] === START_BRIDGE_INSTALL && ready.bundleReady && ready.herdrPresent);
}

export interface SshFleetRow {
  kind: string;
  enabled: boolean;
  state: string;
  error?: string | null;
  action_required?: string | null;
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value === "";
}

/** Enabled SSH machines, and how many of those are connected with nothing left to do. */
export function sshFleet(machines: readonly SshFleetRow[]): { ssh_total: number; ssh_connected: number } {
  let ssh_total = 0;
  let ssh_connected = 0;
  for (const machine of machines) {
    if (machine.kind !== "ssh" || !machine.enabled) continue;
    ssh_total++;
    if (machine.state === "connected" && blank(machine.error) && blank(machine.action_required)) ssh_connected++;
  }
  return { ssh_total, ssh_connected };
}

/** An empty roster is not a connected fleet. `0 === 0` fails. */
export function fleetAttached(counts: { ssh_total: number; ssh_connected: number }): boolean {
  return counts.ssh_total > 0 && counts.ssh_connected === counts.ssh_total;
}

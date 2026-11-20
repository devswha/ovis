import { describe, expect, it } from "bun:test";
import { START_BRIDGE_INSTALL, fleetAttached, needsApproval, sshFleet } from "./setup-approval.ts";

const ready = { bundleReady: true, herdrPresent: true };

describe("setup approval", () => {
  it("keeps the start-bridge sentence in one place", () => {
    expect(START_BRIDGE_INSTALL).toBe("Start the loopback bridge and, only if absent, the herdr daemon");
  });

  it("skips approval only for that one line when the bundle and herdr are already present", () => {
    expect(needsApproval([START_BRIDGE_INSTALL], ready)).toBe(false);
    expect(needsApproval([], ready)).toBe(false);
    expect(needsApproval([START_BRIDGE_INSTALL + "."], ready)).toBe(true);
    expect(needsApproval([START_BRIDGE_INSTALL, "Register a dedicated SSH public key for automatic reconnection"], ready)).toBe(true);
    expect(needsApproval([START_BRIDGE_INSTALL], { bundleReady: false, herdrPresent: true })).toBe(true);
    expect(needsApproval([START_BRIDGE_INSTALL], { bundleReady: true, herdrPresent: false })).toBe(true);
  });
});

describe("ssh fleet counts", () => {
  const ssh = (patch: Partial<{ enabled: boolean; state: string; error: string | null; action_required: string | null }> = {}) => ({
    kind: "ssh", enabled: true, state: "connected", error: null, action_required: null, ...patch,
  });

  it("counts enabled ssh rows and treats a pending action as not connected", () => {
    const counts = sshFleet([
      ssh(),
      ssh({ action_required: "connect", error: "" }),
      ssh({ state: "error", error: "down" }),
      ssh({ enabled: false }),
      { kind: "local", enabled: true, state: "connected", error: null, action_required: null },
    ]);
    expect(counts).toEqual({ ssh_total: 3, ssh_connected: 1 });
    expect(fleetAttached({ ssh_total: 0, ssh_connected: 0 })).toBe(false);
    expect(fleetAttached(counts)).toBe(false);
    expect(fleetAttached({ ssh_total: 2, ssh_connected: 2 })).toBe(true);
  });
});

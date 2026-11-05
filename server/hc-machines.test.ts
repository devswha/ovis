import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineManager } from "./machines.ts";
import type { CompletionTracker } from "./completion.ts";
import type { HcMachine, MachineBridge } from "./herdr-core/machine-bridge.ts";
import type { PushService } from "./push.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const settled = () => new Promise((resolve) => setImmediate(resolve));

/** A manager reading herdr-core's machines, whose servers are stand-ins: each start and stop is recorded. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-machines-"));
  const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("isolated local offline"); });
  // what a connection reads through the PC's server is not this test's business: it connects
  const observe = spyOn(manager as unknown as { observe(runtime: { machine: { state: string } }): Promise<void> }, "observe").mockImplementation(async (runtime) => { runtime.machine.state = "connected"; });
  const events: string[] = [];
  const start = async (machine: Pick<HcMachine, "id" | "name">): Promise<MachineBridge> => {
    events.push(`start ${machine.name}`);
    return { endpoint: { url: "http://127.0.0.1:1", token: "t" }, exited: new Promise(() => {}), stop: () => events.push(`stop ${machine.name}`) };
  };
  // the watch's own first read (none yet) is in before the test tells the core's list
  manager.watchHcMachines(async () => [], start, 3_600_000);
  await settled();
  cleanups.push(() => { manager.stop(); observe.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
  return { manager, events, dir };
}

const lab: HcMachine = { id: "a32c7763ba582b75", name: "lab", connected: true, why: null };

describe("herdr-core's machines as PCs (#2497)", () => {
  it("shows each machine of the core as a PC of its own, which starts its server and is never saved here", async () => {
    const { manager, events, dir } = await fixture();
    manager.syncHcMachines([lab]);
    await settled();
    expect(manager.list()[1]).toMatchObject({ id: "hc-a32c7763ba582b75", name: "lab", kind: "hc", state: "connected" });
    expect(events).toEqual(["start lab"]);
    expect(() => manager.patch("hc-a32c7763ba582b75", { name: "x" })).toThrow("hc machine");
    expect(() => manager.remove("hc-a32c7763ba582b75")).toThrow("hc machine");
    (manager as unknown as { persist(): void }).persist();
    const saved = join(dir, "machines.json");
    expect(existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : []).toEqual([]);
  });

  it("follows the machine: away, back, renamed (its terminals' addresses change) and removed", async () => {
    const { manager, events } = await fixture();
    manager.syncHcMachines([lab]);
    await settled();
    manager.syncHcMachines([{ ...lab, connected: false, why: "unreachable" }]);
    expect(manager.list()[1]).toMatchObject({ state: "disconnected", error: "herdr-core cannot reach this machine (unreachable)" });
    manager.syncHcMachines([lab]);
    await settled();
    manager.syncHcMachines([{ ...lab, name: "lab2" }]);
    await settled();
    expect(manager.list()[1]).toMatchObject({ id: "hc-a32c7763ba582b75", name: "lab2", state: "connected" });
    manager.syncHcMachines([]);
    expect(manager.list()).toHaveLength(1);
    expect(events).toEqual(["start lab", "stop lab", "start lab", "stop lab", "start lab2", "stop lab2"]);
  });
});

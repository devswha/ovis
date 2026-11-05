import { afterEach, describe, expect, it } from "bun:test";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { PromptMonitor } from "./prompt-monitor.ts";

// ticks are driven by hand: the interval never fires while a test runs
const NEVER_MS = 3_600_000;

/** A herdr whose panes and screens the test sets before each tick. A thrown read stands for a screen that could not be read. */
class FakeHerdr {
  readonly panes = new Map<string, string>();
  readonly screens = new Map<string, string | null | Error>();
  snapshots = 0;
  reads = 0;
  snapshotFails = false;

  reader() {
    return {
      snapshot: async (): Promise<SessionSnapshot> => {
        this.snapshots += 1;
        if (this.snapshotFails) throw new Error("herdr did not answer");
        const panes = [...this.panes].map(([pane_id, agent_status]) => ({ pane_id, agent_status }) as HerdrPane);
        return { panes } as SessionSnapshot;
      },
      read: async (pane: HerdrPane): Promise<string | null> => {
        this.reads += 1;
        const screen = this.screens.get(pane.pane_id) ?? null;
        if (screen instanceof Error) throw screen;
        return screen;
      },
    };
  }
}

const monitors: PromptMonitor[] = [];
afterEach(() => { for (const monitor of monitors.splice(0)) monitor.stop(); });

function setup() {
  const herdr = new FakeHerdr();
  const changes: [string, string][] = [];
  const ended: string[] = [];
  const monitor = new PromptMonitor(herdr.reader(), (paneId, signature) => changes.push([paneId, signature]), (paneId) => ended.push(paneId), NEVER_MS);
  monitors.push(monitor);
  return { herdr, changes, ended, monitor };
}

describe("PromptMonitor", () => {
  it("tells the first read and each change of what the prompt says, and nothing for the same prompt read again", async () => {
    const { herdr, changes, monitor } = setup();
    herdr.panes.set("p1", "idle");
    herdr.screens.set("p1", "trust");
    monitor.watch("p1");
    await monitor.tick();
    await monitor.tick();
    herdr.screens.set("p1", null);
    await monitor.tick();
    herdr.screens.set("p1", "trust");
    await monitor.tick();
    expect(changes.map(([paneId]) => paneId)).toEqual(["p1", "p1", "p1"]);
    const [opened, closed, reopened] = changes.map(([, signature]) => signature);
    expect(closed).not.toBe(opened);
    expect(reopened).toBe(opened);
  });

  it("reads no pane herdr reports working or blocked, and tells the first read after it again", async () => {
    const { herdr, changes, monitor } = setup();
    herdr.panes.set("p1", "idle");
    herdr.screens.set("p1", null);
    monitor.watch("p1");
    await monitor.tick();
    const readsBefore = herdr.reads;
    for (const status of ["working", "blocked"]) {
      herdr.panes.set("p1", status);
      await monitor.tick();
    }
    expect(herdr.reads).toBe(readsBefore);
    herdr.panes.set("p1", "idle");
    await monitor.tick();
    expect(changes).toHaveLength(2);
    expect(changes[1]![1]).toBe(changes[0]![1]);
  });

  it("reads every watched pane from one snapshot a tick, and never runs two ticks at once", async () => {
    const { herdr, changes, monitor } = setup();
    herdr.panes.set("p1", "idle");
    herdr.panes.set("p2", "done");
    monitor.watch("p1");
    monitor.watch("p2");
    // p2 came while p1's first read was under way: the tick after it reads both
    await monitor.tick();
    await Promise.all([monitor.tick(), monitor.tick()]);
    expect(herdr.snapshots).toBe(2);
    expect(changes.map(([paneId]) => paneId).sort()).toEqual(["p1", "p2"]);
  });

  it("ends the watch of a pane that closed", async () => {
    const { herdr, ended, monitor } = setup();
    herdr.panes.set("p1", "idle");
    monitor.watch("p1");
    await monitor.tick();
    herdr.panes.delete("p1");
    await monitor.tick();
    expect(ended).toEqual(["p1"]);
    expect(monitor.size).toBe(0);
  });

  it("ends a watch after 10 failed reads in a row, a read that answers starting the count again", async () => {
    const { herdr, ended, monitor } = setup();
    herdr.panes.set("p1", "idle");
    herdr.screens.set("p1", new Error("pane.read failed"));
    monitor.watch("p1");
    for (let i = 0; i < 9; i++) await monitor.tick();
    herdr.screens.set("p1", null);
    await monitor.tick();
    herdr.screens.set("p1", new Error("pane.read failed"));
    for (let i = 0; i < 9; i++) await monitor.tick();
    expect(ended).toEqual([]);
    // a snapshot herdr did not answer counts as a failed read too
    herdr.snapshotFails = true;
    await monitor.tick();
    expect(ended).toEqual(["p1"]);
    expect(monitor.size).toBe(0);
  });
});

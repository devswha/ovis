import { afterAll, beforeAll, beforeEach, describe, expect, it, jest, type Mock } from "bun:test";

import type { HerdrPane } from "../../shared/protocol.ts";
import { DEFAULT_ALERT_TIMING } from "../push.ts";
import { startFakePushService, type FakePushService } from "../push.fake.ts";
import { claude, handlers, hub } from "./status.fake.ts";

let device: FakePushService;
beforeAll(async () => { device = await startFakePushService(); });
afterAll(() => device.stop());
beforeEach(() => { device.received.length = 0; });

// #4217: the hub's real push service, with the collector's handlers as it wires them
describe("a question's alert still waiting when its pane goes away", () => {
  it.each([
    ["is delivered when the pane stays", () => {}, ["waiting for your input"]],
    ["is called off when the pane closes", () => handlers.onPaneClosed(claude.pane_id), []],
    ["is called off when a snapshot no longer lists the pane (its tab, workspace or worktree closed)", () => handlers.onBaseline([]), []],
  ] as const)("%s", async (_label, away, expected) => {
    const h = hub();
    (h.status.push.onStatus as Mock<typeof h.status.push.onStatus>).mockRestore();
    h.status.push.subscribe(device.subscription);
    const pane = { ...claude, agent_status: "working" } as HerdrPane;
    h.herdrSays(pane);
    handlers.onBaseline([pane]);
    await h.snapshot();
    jest.useFakeTimers();
    try {
      handlers.onStatus(pane.pane_id, "blocked", "claude");
      away();
      jest.advanceTimersByTime(DEFAULT_ALERT_TIMING.short);
    } finally { jest.useRealTimers(); }
    await h.status.push.settled();
    expect(device.received.filter((push) => push.payload.pane_id === pane.pane_id).map((push) => push.payload.body)).toEqual([...expected]);
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import {
  herdrRpc,
  herdrRpcCounts,
  resetHerdrRpcCounts,
  setHerdrRpcCounting,
} from "./herdr/client.ts";

// A path no herdr is listening on: herdrRpc still counts the attempt on entry, which is the
// whole reason the counter is taken there. So none of these cases needs a live herdr — which is
// why they live here rather than in server/herdr/, where the unit lane does not look.
const DEAD_SOCKET = "/tmp/herdr-rpc-count-no-such-socket.sock";
const callDead = (method: string) => herdrRpc(method, {}, DEAD_SOCKET, 200).catch(() => undefined);

afterEach(() => {
  setHerdrRpcCounting(false);
  resetHerdrRpcCounts();
});

describe("herdr rpc counter", () => {
  it("is off by default and stays empty however many calls are made", async () => {
    await callDead("pane.read");
    await callDead("pane.read");
    expect(herdrRpcCounts()).toEqual({});
  });

  it("counts attempts, not successes: a call that fails is still tallied", async () => {
    setHerdrRpcCounting(true);
    await callDead("session.snapshot");
    expect(herdrRpcCounts()).toEqual({ "session.snapshot": 1 });
  });

  it("counts a call refused by the guard before the request is written", async () => {
    setHerdrRpcCounting(true);
    await herdrRpc("pane.read", {}, DEAD_SOCKET, 200, () => false).catch(() => undefined);
    expect(herdrRpcCounts()).toEqual({ "pane.read": 1 });
  });

  it("tallies a known number of calls per method exactly", async () => {
    setHerdrRpcCounting(true);
    await callDead("pane.read");
    await callDead("pane.read");
    await callDead("pane.read");
    await callDead("session.snapshot");
    expect(herdrRpcCounts()).toEqual({ "pane.read": 3, "session.snapshot": 1 });
  });

  it("resets to empty and keeps counting afterwards", async () => {
    setHerdrRpcCounting(true);
    await callDead("pane.read");
    resetHerdrRpcCounts();
    expect(herdrRpcCounts()).toEqual({});
    await callDead("pane.read");
    expect(herdrRpcCounts()).toEqual({ "pane.read": 1 });
  });

  it("hands back a copy: mutating the result cannot corrupt the tally", async () => {
    setHerdrRpcCounting(true);
    await callDead("pane.read");
    const first = herdrRpcCounts();
    (first as { "pane.read": number })["pane.read"] = 999;
    expect(herdrRpcCounts()).toEqual({ "pane.read": 1 });
  });

  it("turning it back off discards the tally and stops counting", async () => {
    setHerdrRpcCounting(true);
    await callDead("pane.read");
    setHerdrRpcCounting(false);
    expect(herdrRpcCounts()).toEqual({});
    await callDead("pane.read");
    expect(herdrRpcCounts()).toEqual({});
  });
});
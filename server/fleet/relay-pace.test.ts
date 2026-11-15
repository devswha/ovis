/**
 * The relay pace of todo 37 (server/fleet/relay-pace.ts, docs/fleet-link.md "The relay pace") on a test clock: the two
 * profiles, the span, stable `pace_slot`s through the fleet store, a next instant that depends only on the slot, and
 * the controller's one bucket of relay sockets with its lanes.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { TestClock } from "../relay/test-helpers.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RELAY_BUDGET, deviceWindowMs, MACHINE_ANSWER_MS, nextPaceInstant, paceSpan, relayPace, RelaySocketBudget } from "./relay-pace.ts";
import { Fleet } from "./sessions.ts";
import { FleetStore } from "./store.ts";
import { bounded, relayFixture } from "../relay/test-helpers.ts";
import { machineConnection, machineKey } from "./test-helpers.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stateDir = () => { const dir = mkdtempSync(join(tmpdir(), "fleet-pace-")); dirs.push(dir); return dir; };

describe("relayPace", () => {
  it("gives the controller 24 a minute and a burst of 4 and the machines 22 for no budget and for 30, all 96 and 22 for 120", () => {
    for (const budget of [undefined, null, DEFAULT_RELAY_BUDGET, 0, 1, -5, 1.5, Number.NaN]) {
      expect(relayPace(budget)).toMatchObject({ per_minute: 24, burst: 4, spacing_ms: 2_500, machine_per_minute: 22, machine_spacing_ms: 60_000 / 22 });
    }
    expect(relayPace(120)).toEqual({ budget: 120, per_minute: 96, burst: 22, spacing_ms: 625, machine_per_minute: 96, machine_spacing_ms: 625 });
    // only the hosted budget slows the machines: a self-run relay naming 60 paces them as the controller
    expect(relayPace(60)).toMatchObject({ per_minute: 48, machine_per_minute: 48 });
    // PACE's range stops at 600 a minute
    expect(relayPace(10_000).per_minute).toBe(600);
  });

  it("has a span of max(OVIS_FLEET_MAX, per_minute): 100 for both profiles at the default fleet size", () => {
    expect(paceSpan(100, relayPace(30).machine_per_minute)).toBe(100);
    expect(paceSpan(100, relayPace(120).per_minute)).toBe(100);
    expect(paceSpan(10, relayPace(120).per_minute)).toBe(96);
    expect(paceSpan(1000, 96)).toBe(1000);
  });

  it("puts a machine's next instant after a loss on its slot's grid, whatever the moment of the loss", () => {
    const pace = { slot: 7, span: 100, spacing_ms: 2_500 };
    const after = (loss: number) => nextPaceInstant(pace, loss);
    // every loss within one cycle before an instant dials at that instant
    const instants = new Set(Array.from({ length: 50 }, (_, index) => after(1_767_225_767_500 - 1 - index * 4_999)));
    expect([...instants]).toEqual([1_767_225_767_500]);
    for (const loss of [0, 1, 17_499, 17_500, 1_767_225_600_000]) {
      const at = after(loss);
      expect(at).toBeGreaterThan(loss);
      expect(at - loss).toBeLessThanOrEqual(250_000);
      expect(((at / 2_500) - 7) % 100).toBe(0);
    }
  });
});

describe("the fleet's pace", () => {
  it("names each machine its store pace_slot, the span and the generation, and raises the generation when the relay's budget changes", async () => {
    const dir = stateDir();
    const store = new FleetStore({ stateDir: dir, max: 100 });
    const [a, b] = await Promise.all([machineKey(), machineKey()]);
    for (const key of [a, b]) { store.add({ machine_id: key.id, public_key: key.spki }); store.setState(key.id, "active"); }
    const fleet = new Fleet({ stateDir: dir, store, wall: () => 1_767_225_600_000, tokenConfigured: true });
    expect(fleet.paceFor(a.id, 12)).toEqual({ generation: 1, per_minute: 22, burst: 4, slot: 0, span: 100, controller_ms: 1_767_225_600_000, rtt_ms: 12 });
    expect(fleet.paceFor(b.id, 80_000).slot).toBe(1);
    expect(fleet.paceFor(b.id, 80_000).rtt_ms).toBe(60_000);
    fleet.setRelayBudget(30);
    expect(fleet.paceFor(a.id, 0).generation).toBe(1);
    fleet.setRelayBudget(120);
    expect(fleet.paceFor(a.id, 0)).toMatchObject({ generation: 2, per_minute: 96, burst: 22, span: 100, slot: 0 });
    // a machine the store has not given a slot yet gets its default one
    const c = await machineKey();
    expect(fleet.paceFor(c.id, 0).slot).toBe(Number.parseInt(c.id.slice(0, 4), 16) % 100);
    await fleet.close();
  });
});

describe("RelaySocketBudget", () => {
  const grant = (budget: RelaySocketBudget, lane: "control" | "default" | "paced", log: string[], name: string) =>
    budget.take(lane, () => log.push(name), () => log.push(`${name}:expired`));

  it("opens control first and devices before machines in their window, then machines first and devices only on a spare token", () => {
    const clock = new TestClock();
    const profile = relayPace(30);
    const budget = new RelaySocketBudget(profile, clock);
    const log: string[] = [];
    budget.proven();
    // the bucket's 4 tokens go to sockets that asked first; then everyone contends for each refill (one every 2.5 s)
    for (let index = 0; index < 4; index++) grant(budget, "default", log, `early${index}`);
    grant(budget, "paced", log, "m0");
    grant(budget, "default", log, "d0");
    grant(budget, "default", log, "d1");
    grant(budget, "control", log, "control");
    clock.advance(profile.spacing_ms);
    clock.advance(profile.spacing_ms);
    clock.advance(profile.spacing_ms);
    expect(log.slice(4).filter((entry) => !entry.endsWith(":expired"))).toEqual(["control", "d0", "d1"]);
    // m0 waited past its 5 s: it is not answered, its machine dials again at its next instant
    expect(log.filter((entry) => entry.startsWith("m0"))).toEqual(["m0:expired"]);
    // past the window a machine takes the next token, and a device only a spare one (two on hand)
    clock.advance(deviceWindowMs(profile));
    const after: string[] = [];
    for (let index = 0; index < 4; index++) grant(budget, "control", [], `drain${index}`);
    grant(budget, "default", after, "late-device");
    grant(budget, "paced", after, "machine");
    clock.advance(profile.spacing_ms);
    expect(after).toEqual(["machine"]);
    clock.advance(profile.spacing_ms);
    expect(after).toEqual(["machine"]);
    clock.advance(profile.spacing_ms);
    expect(after).toEqual(["machine", "late-device"]);
    expect(MACHINE_ANSWER_MS).toBe(5_000);
  });

  it("inside the devices' window gives a token due before the machine's deadline to the device that waits beside it", () => {
    const clock = new TestClock();
    const profile = relayPace(30);
    const budget = new RelaySocketBudget(profile, clock);
    budget.proven();
    for (let index = 0; index < 4; index++) grant(budget, "control", [], `drain${index}`);
    const log: string[] = [];
    // the machine asked first; the next token comes 2.5 s later, inside the machine's 5 s
    grant(budget, "paced", log, "machine");
    clock.advance(1_000);
    grant(budget, "default", log, "device");
    clock.advance(profile.spacing_ms - 1_000);
    expect(log).toEqual(["device"]);
    clock.advance(profile.spacing_ms);
    expect(log).toEqual(["device", "machine:expired"]);
  });

  it("keeps the devices' window at least 31 s: with the fleet flags (13 spacings are 8.1 s) a device still goes first at 30 s, a machine at 31 s", () => {
    const profile = relayPace(120);
    expect(deviceWindowMs(profile)).toBe(31_000);
    const order = (at: number) => {
      const clock = new TestClock();
      const budget = new RelaySocketBudget(profile, clock);
      budget.proven();
      clock.advance(at);
      for (let index = 0; index < profile.burst; index++) grant(budget, "control", [], `drain${index}`);
      const log: string[] = [];
      grant(budget, "paced", log, "machine");
      grant(budget, "default", log, "device");
      clock.advance(profile.spacing_ms);
      return log[0];
    };
    expect(order(30_000 - 625)).toBe("device");
    expect(order(31_000)).toBe("machine");
  });

  it("never opens more than burst + per_minute sockets in any 60 s, however many ask", () => {
    for (const budgetValue of [30, 120]) {
      const clock = new TestClock();
      const profile = relayPace(budgetValue);
      const budget = new RelaySocketBudget(profile, clock);
      for (let tick = 0; tick < 600; tick++) {
        grant(budget, tick % 3 === 0 ? "default" : "control", [], `${tick}`);
        clock.advance(500);
      }
      const granted = budget.granted;
      let most = 0;
      for (const start of granted) most = Math.max(most, granted.filter((at) => at >= start && at < start + 60_000).length);
      expect(most).toBeLessThanOrEqual(profile.burst + profile.per_minute);
      budget.stop();
    }
  });
});

describe("a machine's session hears its pace", () => {
  it("in AUTH_OK's relay_pace, then a PACE with the measured round trip, and a new PACE when the relay names another budget", async () => {
    const fixture = relayFixture();
    try {
      const dir = stateDir();
      const store = new FleetStore({ stateDir: dir, max: 100 });
      const key = await machineKey();
      store.add({ machine_id: key.id, public_key: key.spki });
      store.setState(key.id, "active");
      const fleet = new Fleet({ stateDir: dir, store, wall: () => 1_767_225_600_000, tokenConfigured: true });
      const machine = await machineConnection(fixture, fleet, { machineSessions: fleet });
      await machine.hello();
      const ok = await machine.signIn(key);
      expect(ok.relay_pace).toMatchObject({ generation: 1, per_minute: 22, burst: 4, slot: 0, span: 100, controller_ms: 1_767_225_600_000 });
      const paced = (count: number) => bounded((async () => { while (machine.paces.length < count) await new Promise<void>((resolve) => setImmediate(resolve)); })());
      await paced(1);
      expect(machine.paces[0]).toMatchObject({ generation: 1, slot: 0, span: 100 });
      expect(machine.paces[0]!.rtt_ms).toBeLessThan(60_000);
      fleet.setRelayBudget(120);
      await paced(2);
      expect(machine.paces[1]).toMatchObject({ generation: 2, per_minute: 96, burst: 22, slot: 0 });
      await fleet.close();
    } finally { fixture.close(); }
  });
});

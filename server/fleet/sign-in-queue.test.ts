/**
 * The controller's sign-in queue for machines (server/fleet/sign-in-queue.ts, todo 37): 16 verifications at a time,
 * the rest answered in order, a queued machine never dropped for a newer one, a closed carrier's place freed, a full
 * queue's newcomer told when to come back (close 1013 with `retry_after_ms` on a direct carrier), and a flood of bad
 * signatures that does not starve good ones. The controller's keepalive on a machine session is here too (todo 37,
 * carried from todo 24).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { MuxEngine } from "../../shared/relay-mux-engine.ts";
import { FrameType, decodeFrame } from "../../shared/relay-mux.ts";
import { bounded, deferred, relayFixture, TestClock } from "../relay/test-helpers.ts";
import { verifyMachineAuth } from "./mux-ext.ts";
import { SIGN_IN_CONCURRENCY, SIGN_IN_WAITING, SignInQueue } from "./sign-in-queue.ts";
import { machineConnection, machineKey, memoryDirectory, recordOf, signMachineAuth } from "./test-helpers.ts";

const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

/** A verification the test finishes by hand. */
function held() {
  const gate = deferred<string>();
  let started = false;
  return { gate, get started() { return started; }, job: () => { started = true; return gate.promise; } };
}

describe("SignInQueue", () => {
  it("verifies at most 16 at a time and answers the rest in the order they came", async () => {
    const queue = new SignInQueue();
    const jobs = Array.from({ length: 40 }, () => held());
    const done: number[] = [];
    const runs = jobs.map((entry, index) => {
      const turn = queue.run(entry.job, new AbortController().signal);
      if (turn === "busy") throw new Error("busy");
      return turn.then(() => done.push(index));
    });
    expect(jobs.filter((entry) => entry.started).length).toBe(SIGN_IN_CONCURRENCY);
    expect(queue.size).toEqual({ running: 16, waiting: 24 });
    for (const entry of [...jobs].reverse()) entry.gate.resolve("ok");
    await Promise.all(runs);
    expect(queue.peakRunning).toBe(SIGN_IN_CONCURRENCY);
    expect(jobs.every((entry) => entry.started)).toBe(true);
    expect(done.length).toBe(40);
  });

  it("starts waiting machines strictly first come, first served", async () => {
    const queue = new SignInQueue(1, 10);
    const order: number[] = [];
    const first = held();
    const runs = [queue.run(first.job, new AbortController().signal) as Promise<string>];
    for (let index = 1; index <= 5; index++) runs.push(queue.run(async () => { order.push(index); return "ok"; }, new AbortController().signal) as Promise<string>);
    first.gate.resolve("ok");
    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("never drops a queued machine for a newer one: the newcomer past the waiting places is told busy", async () => {
    const queue = new SignInQueue(SIGN_IN_CONCURRENCY, SIGN_IN_WAITING);
    const jobs = Array.from({ length: SIGN_IN_CONCURRENCY + SIGN_IN_WAITING }, () => held());
    const turns = jobs.map((entry) => queue.run(entry.job, new AbortController().signal));
    expect(turns.every((turn) => turn !== "busy")).toBe(true);
    expect(queue.run(async () => "late", new AbortController().signal)).toBe("busy");
    expect(queue.busy).toBe(1);
    expect(queue.retryAfterMs()).toBe(3_000);
    expect(queue.size).toEqual({ running: SIGN_IN_CONCURRENCY, waiting: SIGN_IN_WAITING });
    for (const entry of jobs) entry.gate.resolve("ok");
    expect((await Promise.all(turns as Promise<string>[])).length).toBe(jobs.length);
  });

  it("holds a direct carrier's machines to SIGN_IN_WAITING places while others wait in the queue's own", async () => {
    const queue = new SignInQueue(1);
    void queue.run(held().job, new AbortController().signal);
    const direct = Array.from({ length: SIGN_IN_WAITING }, () => queue.run(held().job, new AbortController().signal, SIGN_IN_WAITING));
    expect(direct.every((turn) => turn !== "busy")).toBe(true);
    expect(queue.run(held().job, new AbortController().signal, SIGN_IN_WAITING)).toBe("busy");
    // a relay link's machine still waits: its room bounds how many can
    expect(queue.run(held().job, new AbortController().signal)).not.toBe("busy");
    expect(queue.size.waiting).toBe(SIGN_IN_WAITING + 1);
  });

  it("frees the place of a machine whose carrier closed while it waited", async () => {
    const queue = new SignInQueue(1, 2);
    const first = held();
    void queue.run(first.job, new AbortController().signal);
    const leaving = new AbortController();
    const gone = queue.run(async () => "never", leaving.signal) as Promise<string>;
    const stays = queue.run(async () => "stays", new AbortController().signal) as Promise<string>;
    expect(queue.run(async () => "x", new AbortController().signal)).toBe("busy");
    leaving.abort(new Error("carrier closed"));
    await expect(gone).rejects.toThrow("carrier closed");
    expect(queue.size.waiting).toBe(1);
    // its place is free again for a newcomer
    const newcomer = queue.run(async () => "newcomer", new AbortController().signal);
    expect(newcomer).not.toBe("busy");
    first.gate.resolve("ok");
    expect(await stays).toBe("stays");
    expect(await (newcomer as Promise<string>)).toBe("newcomer");
  });

  it("keeps the head and the order when a machine behind the head leaves while waiting", async () => {
    const queue = new SignInQueue(1, 10);
    const running = held();
    void queue.run(running.job, new AbortController().signal);
    const order: string[] = [];
    const waiters = ["w1", "w2", "w3", "w4"].map((name) => {
      const abort = new AbortController();
      const turn = queue.run(async () => { order.push(name); return name; }, abort.signal) as Promise<string>;
      return { name, abort, turn };
    });
    // the second one waiting leaves, not the first
    waiters[1]!.abort.abort(new Error("carrier closed"));
    await expect(waiters[1]!.turn).rejects.toThrow("carrier closed");
    expect(queue.size).toEqual({ running: 1, waiting: 3 });
    running.gate.resolve("ok");
    await Promise.all([waiters[0]!.turn, waiters[2]!.turn, waiters[3]!.turn]);
    expect(order).toEqual(["w1", "w3", "w4"]);
  });

  it("verifies good machines behind a flood of bad signatures, with the CPU it took measured", async () => {
    const queue = new SignInQueue();
    const keys = await Promise.all(Array.from({ length: 8 }, () => machineKey()));
    const directory = memoryDirectory(keys.map((key) => recordOf(key)));
    const nonce = new Uint8Array(32).fill(1);
    const binding = new Uint8Array(32).fill(2);
    const session = { nonce, serverId: "0123456789abcdef0123456789abcdef", binding };
    const good = await Promise.all(keys.map(async (key) => ({ scheme: "machine-key" as const, machine_id: key.id, signature: await signMachineAuth(key, nonce, session.serverId, binding) })));
    const bad = good.map((auth) => ({ ...auth, signature: Buffer.alloc(64, 7).toString("base64url") }));
    const cpu = process.cpuUsage();
    const started = performance.now();
    // 400 bad sign-ins (8 known ids, wrong signatures) arrive first; then the 8 good ones, each in a free waiting place
    const results: Promise<unknown>[] = [];
    let busy = 0;
    for (let round = 0; round < 50; round++) {
      for (const auth of bad) {
        const turn = queue.run(() => verifyMachineAuth(directory, auth, session), new AbortController().signal);
        if (turn === "busy") busy++; else results.push(turn);
      }
      await Promise.all(results.splice(0));
    }
    const goodTurns = good.map((auth) => queue.run(() => verifyMachineAuth(directory, auth, session), new AbortController().signal));
    expect(goodTurns.every((turn) => turn !== "busy")).toBe(true);
    const verified = await Promise.all(goodTurns as Promise<Awaited<ReturnType<typeof verifyMachineAuth>>>[]);
    expect(verified.map((result) => "machineId" in result ? result.machineId : result.cause)).toEqual(keys.map((key) => key.id));
    const used = process.cpuUsage(cpu);
    const ms = (used.user + used.system) / 1000;
    console.log(`SIGN_IN_FLOOD bad=400 good=8 busy=${busy} cpu_ms=${ms.toFixed(1)} wall_ms=${(performance.now() - started).toFixed(1)} per_verify_cpu_ms=${(ms / 408).toFixed(3)}`);
    expect(busy).toBe(0);
  });
});

describe("a machine session on a controller with the queue", () => {
  it("answers a machine whose AUTH finds the queue full with its retry hint, and never one already queued", async () => {
    const fixture = relayFixture();
    fixtures.push(fixture);
    const key = await machineKey();
    const queue = new SignInQueue(1, 0);
    const blocker = held();
    void queue.run(blocker.job, new AbortController().signal);
    const hint = deferred<number>();
    const machine = await machineConnection(fixture, memoryDirectory([recordOf(key)]), {
      machineSessions: { admit: () => ({ committed() {}, advert() {}, ended() {} }), signIns: queue },
      onMachineBusy: (retryAfterMs) => hint.resolve(retryAfterMs),
    });
    await machine.hello();
    await machine.sendAuth(key);
    expect(await bounded(hint.promise)).toBe(1_000);
    expect(machine.session.machineSigningIn).toBe(false);
    blocker.gate.resolve("ok");
  });

  it("refuses resource_exhausted controller_limit where no carrier can say a retry hint (the relay)", async () => {
    const fixture = relayFixture();
    fixtures.push(fixture);
    const key = await machineKey();
    const queue = new SignInQueue(1, 0);
    void queue.run(held().job, new AbortController().signal);
    const machine = await machineConnection(fixture, memoryDirectory([recordOf(key)]), {
      machineSessions: { admit: () => ({ committed() {}, advert() {}, ended() {} }), signIns: queue },
    });
    await machine.hello();
    await machine.sendAuth(key);
    expect(await bounded(machine.error)).toEqual({ code: "resource_exhausted", message: "controller_limit" });
  });
});

describe("the controller's keepalive on a machine session", () => {
  function engine(clock: TestClock) {
    const sent: number[] = [];
    const ended = deferred<string>();
    const mux = new MuxEngine({
      role: "server", clock, send: async (bytes) => { sent.push(decodeFrame(bytes).type); }, close: () => {},
      outboundWireByteLength: (bytes) => bytes.byteLength, routingOverhead: 0, maxWireMessageBytes: 64 * 1024,
      onSession: () => {}, onClose: (error) => ended.resolve(error.code),
    });
    mux.authenticateExtension("0123456789abcdef0123456789abcdef");
    return { mux, sent, ended: ended.promise };
  }

  it("pings a machine silent for 20 s and ends its session timeout when no PONG came 60 s later: a dead machine goes within 80 s", async () => {
    const clock = new TestClock();
    const { sent, ended } = engine(clock);
    clock.advance(19_999);
    await Promise.resolve();
    expect(sent.filter((type) => type === FrameType.PING).length).toBe(0);
    clock.advance(1);
    await Promise.resolve();
    expect(sent.filter((type) => type === FrameType.PING).length).toBe(1);
    clock.advance(60_000);
    expect(await bounded(ended)).toBe("timeout");
  });

  it("measures the round trip PACE names from its PONG", async () => {
    const clock = new TestClock();
    const { mux } = engine(clock);
    const measured = mux.measure();
    clock.advance(37);
    // the probe's PONG, as the machine answers it
    const probe = (mux as unknown as { probe: bigint }).probe;
    const pong = new Uint8Array(16);
    pong.set([1, FrameType.PONG, 0, 0, 0, 0, 0, 0]);
    new DataView(pong.buffer).setBigUint64(8, probe);
    mux.receive(pong);
    expect(await bounded(measured)).toBe(37);
    expect(mux.rttMs).toBe(37);
  });
});

/**
 * The controller's machine sessions and local forwards (server/fleet/sessions.ts, forward.ts) against machines on
 * live RelaySessions of a server started with `port: 0`, each with a store in a mkdtemp state folder. The machine side
 * is the TypeScript stand-in of the link agent (test-helpers.ts pipeToTarget); the Rust agent's run is
 * link-forward.contract.test.ts.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MuxClock } from "../../shared/relay-mux-engine.ts";
import { bounded, deferred, relayFixture, TestClock } from "../relay/test-helpers.ts";
import { HEAD_LIMIT_BYTES, HEAD_WAIT_MS } from "./forward.ts";
import type { PipeAdvert, PipeStream } from "./mux-ext.ts";
import { Fleet, SWITCH_WINDOW_MS } from "./sessions.ts";
import { FleetStore } from "./store.ts";
import { advertFrame, machineConnection, machineKey, pipeToTarget, testAdvert } from "./test-helpers.ts";
import type { MachineKey } from "./test-helpers.ts";

// a quarantine past the switch window makes a synced store write: on a loaded disk it can pass bun's 5 s default
setDefaultTimeout(30_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The tests that use a forward's Unix socket: Windows has none (`native: false`). */
const unixIt = it.skipIf(process.platform === "win32");

async function controller(options: { max?: number; clock?: MuxClock; native?: boolean } = {}) {
  const fixture = relayFixture();
  cleanups.push(() => fixture.close());
  const stateDir = folder("fleet-state-");
  // the store holds more machines than may sign in at once: OVIS_FLEET_MAX lowered after they enrolled
  const store = new FleetStore({ stateDir, max: 100 });
  const fleet = new Fleet({ stateDir, tokenConfigured: true, store, ...options });
  fleet.start();
  cleanups.push(() => fleet.close());
  return {
    fixture, store, fleet,
    async enrol(state: "active" | "pending" = "active"): Promise<MachineKey> {
      const key = await machineKey();
      store.add({ machine_id: key.id, public_key: key.spki, name: "test" });
      if (state === "active") store.setState(key.id, "active");
      return key;
    },
  };
}
type Controller = Awaited<ReturnType<typeof controller>>;

/** A machine signed in on its own session; `onPipe` takes each pipe (default: to `target`). */
async function machine(ctx: Controller, key: MachineKey, options: { target?: number | string; onPipe?: (pipe: PipeStream) => void; endpoints?: ("bridge" | "native")[]; advert?: PipeAdvert } = {}) {
  const opened: PipeStream[] = [];
  const connection = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet }, {
    onPipe: (pipe) => { opened.push(pipe); if (options.onPipe) options.onPipe(pipe); else pipeToTarget(pipe, options.target!); },
  });
  await connection.hello();
  await connection.signIn(key);
  connection.mux.enqueueControl(advertFrame(options.advert ?? testAdvert(options.endpoints)));
  await bounded(connection.mux.measure());
  return { ...connection, opened };
}

/**
 * A first request head carrying `token` as the roster's own client sends it (server/remote-websocket.ts, the fetches of
 * server/machines.ts): what a `bridge` connection presents before the forward makes it a pipe. testAdvert's by default.
 */
const bearerHead = (token = "ab".repeat(32), name = "Authorization") => Buffer.from(`GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n${name}: Bearer ${token}\r\n\r\n`);
const HEAD = bearerHead();

/** A loopback echo server (TCP, or a Unix socket in its own folder) that records every byte it read. */
async function echo(unix = false) {
  const received: Buffer[] = [];
  const sockets: Socket[] = [];
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk) => { received.push(chunk); socket.write(chunk); });
    socket.on("end", () => socket.end());
  });
  const at = unix ? join(folder("fleet-echo-"), "echo.sock") : 0;
  await new Promise<void>((resolve) => { if (typeof at === "string") server.listen(at, resolve); else server.listen(0, "127.0.0.1", resolve); });
  cleanups.push(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return { target: typeof at === "string" ? at : (server.address() as { port: number }).port, received: () => Buffer.concat(received), sockets };
}

/**
 * One local connection: writes `bytes`, ends, and reads until the forward closes; `error` names how it ended badly. A TCP
 * connection first sends `head` (HEAD: the bearer of testAdvert), which an echo answers back and `data` leaves out.
 */
function exchange(at: number | string, bytes: Uint8Array, end = true, head: Buffer | null = typeof at === "number" ? HEAD : null) {
  const socket = typeof at === "number" ? connect({ host: "127.0.0.1", port: at, allowHalfOpen: true }) : connect({ path: at, allowHalfOpen: true });
  const chunks: Buffer[] = [];
  const result = deferred<{ data: Buffer; error: string | undefined }>();
  let error: string | undefined;
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.on("error", (caught: NodeJS.ErrnoException) => { error = caught.code ?? caught.message; });
  socket.on("close", () => {
    const data = Buffer.concat(chunks);
    result.resolve({ data: head && data.subarray(0, head.length).equals(head) ? data.subarray(head.length) : data, error });
  });
  socket.once("connect", () => { socket.write(head ? Buffer.concat([head, bytes]) : bytes); if (end) socket.end(); });
  return { socket, done: bounded(result.promise, 20_000) };
}

const forwardOf = async (ctx: Controller, key: MachineKey) => {
  const forward = await ctx.fleet.forwardReady(key.id);
  if (!forward) throw new Error("no forward");
  return forward;
};

describe("fleet forwards", () => {
  it("gives two machines their own listeners whose connections, interleaved, never reach the other's bridge", async () => {
    const ctx = await controller();
    const [keyA, keyB] = [await ctx.enrol(), await ctx.enrol()];
    const [bridgeA, bridgeB] = [await echo(), await echo()];
    const [machineA, machineB] = [await machine(ctx, keyA, { target: bridgeA.target }), await machine(ctx, keyB, { target: bridgeB.target })];
    const [forwardA, forwardB] = [await forwardOf(ctx, keyA), await forwardOf(ctx, keyB)];
    expect(forwardA.port).not.toBe(forwardB.port);
    const sent: { A: Buffer[]; B: Buffer[] } = { A: [], B: [] };
    const runs = Array.from({ length: 12 }, (_, index) => {
      const which = index % 2 === 0 ? "A" : "B";
      const bytes = Buffer.concat([Buffer.from(`${which}${index}:`), randomBytes(64 * 1024 + index)]);
      sent[which].push(bytes);
      return exchange(which === "A" ? forwardA.port : forwardB.port, bytes).done.then((answer) => ({ answer, bytes }));
    });
    for (const { answer, bytes } of await Promise.all(runs)) {
      expect(answer.error).toBeUndefined();
      expect(answer.data.equals(bytes)).toBe(true);
    }
    const sum = (list: Buffer[]) => list.reduce((total, bytes) => total + bytes.length, 0);
    expect(bridgeA.received().length).toBe(sum(sent.A) + sent.A.length * HEAD.length);
    expect(bridgeB.received().length).toBe(sum(sent.B) + sent.B.length * HEAD.length);
    for (const bytes of sent.A) expect(bridgeB.received().includes(bytes.subarray(0, 4096))).toBe(false);
    for (const bytes of sent.B) expect(bridgeA.received().includes(bytes.subarray(0, 4096))).toBe(false);
    expect([machineA.opened.length, machineB.opened.length]).toEqual([6, 6]);
  });

  unixIt("listens on 127.0.0.1 only, with the Unix socket 0600 in a 0700 folder of its own under the temp folder", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const native = await echo(true);
    await machine(ctx, key, { target: native.target });
    const forward = await forwardOf(ctx, key);
    expect(forward.socketPath).not.toBeNull();
    const socketPath = forward.socketPath!;
    expect((statSync(socketPath).mode & 0o777).toString(8)).toBe("600");
    expect((statSync(dirname(socketPath)).mode & 0o777).toString(8)).toBe("700");
    expect(dirname(dirname(socketPath))).toBe(tmpdir());
    expect(socketPath.length).toBeLessThan(104);
    const bytes = randomBytes(300_000);
    expect((await exchange(socketPath, bytes).done).data.equals(bytes)).toBe(true);
    // the TCP listener is not on any other address
    const local = exchange(forward.port, Buffer.from("x"));
    await new Promise((resolve) => local.socket.once("connect", resolve));
    expect(local.socket.remoteAddress).toBe("127.0.0.1");
    await local.done;
    for (const host of ["::1", ...Object.values((await import("node:os")).networkInterfaces()).flat().filter((entry) => entry && !entry.internal && entry.family === "IPv4").map((entry) => entry!.address)]) {
      const refused = deferred<string>();
      const other = connect({ host, port: forward.port });
      other.on("error", (error: NodeJS.ErrnoException) => refused.resolve(error.code ?? "error"));
      other.on("connect", () => { refused.resolve("connected"); other.destroy(); });
      expect(await bounded(refused.promise), host).not.toBe("connected");
    }
  });

  it("closes a connection at once, with nothing read, while the machine has no session, and keeps no advert after its session ends", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const forward = await forwardOf(ctx, key);
    const before = await exchange(forward.port, Buffer.from("GET /api/health HTTP/1.0\r\n\r\n")).done;
    expect(before.data.length).toBe(0);
    expect(before.error).toBe("ECONNRESET");
    expect(ctx.fleet.online(key.id)).toBe(false);

    const bridge = await echo();
    const connection = await machine(ctx, key, { target: bridge.target });
    expect(ctx.fleet.online(key.id)).toBe(true);
    expect(ctx.fleet.advert(key.id)?.bridge_token).toBe("ab".repeat(32));
    expect((await exchange(forward.port, Buffer.from("up")).done).data.toString()).toBe("up");
    connection.stop();
    await bounded(connection.closed);
    expect(ctx.fleet.sessions).toBe(0);
    expect(ctx.fleet.online(key.id)).toBe(false);
    expect(ctx.fleet.advert(key.id)).toBeUndefined();
    const after = await exchange(forward.port, Buffer.from("GET / HTTP/1.0\r\n\r\n")).done;
    expect(after.data.length).toBe(0);
    expect(after.error).toBe("ECONNRESET");
  });

  unixIt("opens no pipe for an endpoint the machine's latest advert does not name", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const bridge = await echo();
    const connection = await machine(ctx, key, { target: bridge.target, endpoints: ["bridge"] });
    const forward = await forwardOf(ctx, key);
    const native = await exchange(forward.socketPath!, Buffer.from("x")).done;
    expect(native.data.length).toBe(0);
    expect(connection.opened.length).toBe(0);
    expect((await exchange(forward.port, Buffer.from("bridged")).done).data.toString()).toBe("bridged");
    // a newer advert that drops `bridge`: the bridge forward opens nothing from then on
    connection.mux.enqueueControl(advertFrame(testAdvert(["native"])));
    await bounded(connection.mux.measure());
    expect((await exchange(forward.port, Buffer.from("x")).done).data.length).toBe(0);
    expect(connection.opened.length).toBe(1);
  });

  it("answers a local client that wrote and ended before the machine answered the pipe", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const bridge = await echo();
    const held = deferred<PipeStream>();
    const connection = await machine(ctx, key, { onPipe: (pipe) => held.resolve(pipe) });
    const forward = await forwardOf(ctx, key);
    const local = exchange(forward.port, Buffer.from("hello, then END at once"));
    const pipe = await bounded(held.promise);
    // the client wrote and ended before the machine answered; nothing of it may precede PIPE_ACCEPT
    await bounded(connection.session.mux.measure());
    expect(connection.mux.active).toBe(true);
    pipeToTarget(pipe, bridge.target);
    const answer = await local.done;
    expect(answer.data.toString()).toBe("hello, then END at once");
    expect(connection.mux.active).toBe(true);
  });

  it("turns the machine's RESET into a TCP reset of the local connection, and a local connection that goes into RESET cancelled", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const bridge = await echo();
    const machineReset = deferred<void>();
    const disposedWith = deferred<string>();
    let mode: "machine-resets" | "local-goes" = "machine-resets";
    await machine(ctx, key, {
      onPipe: (pipe) => {
        if (mode === "machine-resets") {
          pipe.accept();
          void pipe.readable.getReader().read().then(() => { pipe.reset("upstream_lost"); machineReset.resolve(); });
          return;
        }
        pipeToTarget(pipe, bridge.target);
        const dispose = pipe.onDispose;
        pipe.onDispose = (error) => { disposedWith.resolve(error?.code ?? "none"); return dispose?.(error); };
      },
    });
    const forward = await forwardOf(ctx, key);
    const lost = await exchange(forward.port, Buffer.from("partial answer must not look whole"), false).done;
    await bounded(machineReset.promise);
    expect(lost.error).toBe("ECONNRESET");
    expect(lost.data.length).toBe(0);

    mode = "local-goes";
    const local = exchange(forward.port, Buffer.from("going"), false);
    await bounded(new Promise((resolve) => local.socket.once("data", resolve)));
    local.socket.resetAndDestroy();
    expect(await bounded(disposedWith.promise)).toBe("cancelled");
  });

  unixIt("closes a machine's forwards and resets its pipes at once when it is quarantined, and deletes its socket when removed", async () => {
    const ctx = await controller();
    const [quarantined, removed] = [await ctx.enrol(), await ctx.enrol()];
    const bridge = await echo();
    const first = await machine(ctx, quarantined, { target: bridge.target });
    await machine(ctx, removed, { target: bridge.target });
    const forwardQ = await forwardOf(ctx, quarantined);
    const forwardR = await forwardOf(ctx, removed);
    const open = exchange(forwardQ.port, Buffer.from("x"), false);
    await new Promise((resolve) => open.socket.once("data", resolve));
    ctx.store.setState(quarantined.id, "quarantined");
    expect(await bounded(first.error)).toEqual({ code: "auth_revoked", message: "quarantined" });
    expect((await open.done).error).toBe("ECONNRESET");
    expect(ctx.fleet.forward(quarantined.id)).toBeUndefined();
    await bounded(ctx.fleet.idle());
    expect(existsSync(dirname(forwardQ.socketPath!))).toBe(false);
    expect((await exchange(forwardQ.port, Buffer.from("x")).done).error).toBe("ECONNREFUSED");

    ctx.store.remove(removed.id);
    await bounded(ctx.fleet.idle());
    expect(existsSync(forwardR.socketPath!)).toBe(false);
    expect(existsSync(dirname(forwardR.socketPath!))).toBe(false);
    expect((await exchange(forwardR.port, Buffer.from("x")).done).error).toBe("ECONNREFUSED");
    expect(ctx.fleet.forward(removed.id)).toBeUndefined();
  });

  it("opens only the TCP forward where there is no Unix socket forward (Windows), and nothing is left after it closes", async () => {
    const ctx = await controller({ native: false });
    const key = await ctx.enrol();
    const bridge = await echo();
    await machine(ctx, key, { target: bridge.target, endpoints: ["bridge"] });
    const forward = await forwardOf(ctx, key);
    expect(forward.socketPath).toBeNull();
    expect((await exchange(forward.port, Buffer.from("tcp only")).done).data.toString()).toBe("tcp only");
    ctx.store.remove(key.id);
    await bounded(ctx.fleet.idle());
    expect((await exchange(forward.port, Buffer.from("x")).done).error).toBe("ECONNREFUSED");
  });

  unixIt("opens no forward for a pending machine, and every forward closes with the fleet", async () => {
    const ctx = await controller();
    const pending = await ctx.enrol("pending");
    const active = await ctx.enrol();
    expect(await ctx.fleet.forwardReady(pending.id)).toBeUndefined();
    const forward = await forwardOf(ctx, active);
    await ctx.fleet.close();
    expect(existsSync(dirname(forward.socketPath!))).toBe(false);
    expect((await exchange(forward.port, Buffer.from("x")).done).error).toBe("ECONNREFUSED");
  });
});

describe("the bridge forward's bearer", () => {
  it("closes a second local client without the machine's bridge token before any pipe opens, and lets the token's holder through", async () => {
    const ctx = await controller();
    const [keyA, keyB] = [await ctx.enrol(), await ctx.enrol()];
    const [bridgeA, bridgeB] = [await echo(), await echo()];
    const [tokenA, tokenB] = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
    const a = await machine(ctx, keyA, { target: bridgeA.target, advert: { ...testAdvert(), bridge_token: tokenA } });
    const b = await machine(ctx, keyB, { target: bridgeB.target, advert: { ...testAdvert(), bridge_token: tokenB } });
    const forwardA = await forwardOf(ctx, keyA);
    const refusedHeads = [
      Buffer.from("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"),
      // another machine's token, a token with one character more, the token without its scheme
      bearerHead(tokenB),
      bearerHead(`${tokenA}0`),
      Buffer.from(`GET /api/health HTTP/1.1\r\nAuthorization: ${tokenA}\r\n\r\n`),
      // a head longer than the forward reads, whose token comes past the limit
      Buffer.concat([Buffer.from("GET / HTTP/1.1\r\nX-Pad: "), Buffer.alloc(HEAD_LIMIT_BYTES, 0x61), Buffer.from(`\r\nAuthorization: Bearer ${tokenA}\r\n\r\n`)]),
    ];
    for (const head of refusedHeads) {
      const refused = await exchange(forwardA.port, Buffer.from("must not reach the bridge"), true, head).done;
      expect(refused.data.length).toBe(0);
      expect(["ECONNRESET", "EPIPE"]).toContain(refused.error!);
    }
    expect([a.opened.length, b.opened.length]).toEqual([0, 0]);
    expect(bridgeA.received().length).toBe(0);
    // as Bun's fetch and WebSocket send it, in lower case
    for (const name of ["Authorization", "authorization"]) {
      const head = bearerHead(tokenA, name);
      const through = await exchange(forwardA.port, Buffer.from(`through as ${name}`), true, head).done;
      expect(through.error).toBeUndefined();
      expect(through.data.toString()).toBe(`through as ${name}`);
    }
    expect([a.opened.length, b.opened.length]).toEqual([2, 0]);
    expect(bridgeB.received().length).toBe(0);
  });

  it("closes a connection whose head has not come within HEAD_WAIT_MS before any pipe opens, and lets one finished in time through", async () => {
    const clock = new TestClock();
    const ctx = await controller({ clock });
    const key = await ctx.enrol();
    const bridge = await echo();
    const connection = await machine(ctx, key, { target: bridge.target });
    const forward = await forwardOf(ctx, key);
    const half = HEAD.subarray(0, 20);
    // the forward takes connections in the order they came: once a later one has had its answer, an earlier one's wait has begun
    const barrier = async () => expect((await exchange(forward.port, Buffer.from("barrier")).done).data.toString()).toBe("barrier");

    // a head still coming 1 ms before the bound is let through once it ends
    const late = exchange(forward.port, half, false, null);
    await barrier();
    clock.advance(HEAD_WAIT_MS - 1);
    late.socket.end(Buffer.concat([HEAD.subarray(half.length), Buffer.from("in time")]));
    expect((await late.done).data.toString()).toBe(`${HEAD.toString()}in time`);

    // one whose head has not ended at the bound is closed, with no pipe opened for it
    const stalled = exchange(forward.port, half, false, null);
    await barrier();
    const opened = connection.opened.length;
    clock.advance(HEAD_WAIT_MS);
    const closed = await stalled.done;
    expect(closed.data.length).toBe(0);
    expect(closed.error).toBe("ECONNRESET");
    expect(connection.opened.length).toBe(opened);
  });

  it("follows the machine's newest advert: a replaced token no longer opens a pipe", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const bridge = await echo();
    const [first, second] = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
    const connection = await machine(ctx, key, { target: bridge.target, advert: { ...testAdvert(), bridge_token: first } });
    const forward = await forwardOf(ctx, key);
    expect((await exchange(forward.port, Buffer.from("first"), true, bearerHead(first)).done).data.toString()).toBe("first");
    connection.mux.enqueueControl(advertFrame({ ...testAdvert(), boot_id: "boot-2", bridge_token: second }));
    await bounded(connection.mux.measure());
    expect((await exchange(forward.port, Buffer.from("stale"), true, bearerHead(first)).done).data.length).toBe(0);
    expect((await exchange(forward.port, Buffer.from("second"), true, bearerHead(second)).done).data.toString()).toBe("second");
    expect(connection.opened.length).toBe(2);
  });
});

describe("a pipe on the machine session itself", () => {
  it("sends no PIPE_END before PIPE_ACCEPT for a pipe the controller ended before the machine answered", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const held = deferred<PipeStream>();
    const connection = await machine(ctx, key, { onPipe: (pipe) => held.resolve(pipe) });
    const pipe = connection.session.openPipe("bridge");
    await pipe.end();
    const answer = await bounded(held.promise);
    // a round trip: an END sent beside the open would have reached the machine before the PONG
    await bounded(connection.session.mux.measure());
    expect(connection.frames).not.toContain(0x43);
    expect(connection.mux.active).toBe(true);
    answer.accept();
    // the END follows the ACCEPT: the machine reads the pipe to its end
    const reader = answer.readable.getReader();
    expect((await bounded(reader.read())).done).toBe(true);
    expect(connection.frames).toContain(0x43);
    expect(connection.mux.active).toBe(true);
  });

  it("resets a pipe with a code that is not a pipe's as internal_error on the wire", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const disposed = deferred<string>();
    const connection = await machine(ctx, key, {
      onPipe: (pipe) => { pipe.onDispose = (error) => { disposed.resolve(error?.code ?? "none"); }; pipe.accept(); },
    });
    const pipe = connection.session.openPipe("bridge");
    const accepted = deferred<void>();
    pipe.onAccept = () => accepted.resolve();
    await bounded(accepted.promise);
    connection.session.mux.reset(pipe, "resource_exhausted");
    expect(await bounded(disposed.promise)).toBe("internal_error");
    expect(connection.mux.active).toBe(true);
  });

  it("forgets the machine's advert when its session closes", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const connection = await machine(ctx, key, { target: 1 });
    expect(connection.session.pipeAdvert?.bridge_token).toBe("ab".repeat(32));
    connection.stop();
    await bounded(connection.closed);
    expect(connection.session.mux.active).toBe(false);
    expect(connection.session.pipeAdvert).toBeUndefined();
  });
});

describe("pipes per machine", () => {
  it("holds a 17th connection until a pipe is free, and closes one that waited 30 s", async () => {
    const clock = new TestClock();
    const ctx = await controller({ clock });
    const key = await ctx.enrol();
    const bridge = await echo();
    const connection = await machine(ctx, key, { target: bridge.target });
    const forward = await forwardOf(ctx, key);
    // each local connection the forward takes asks for a pipe; a test waits for that, not for its client's connect
    const asked: (() => void)[] = [];
    const openPipe = ctx.fleet.openPipe.bind(ctx.fleet);
    ctx.fleet.openPipe = (...args) => { const pending = openPipe(...args); asked.shift()?.(); return pending; };
    const nextAsk = () => new Promise<void>((resolve) => { asked.push(resolve); });
    const open = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
      const local = exchange(forward.port, Buffer.from(`pipe ${index}`), false);
      await new Promise((resolve) => local.socket.once("data", resolve));
      return local;
    }));
    const seventeenth = nextAsk();
    const waiting = exchange(forward.port, Buffer.from("seventeenth"));
    await bounded(seventeenth);
    await bounded(connection.session.mux.measure());
    expect(connection.opened.length).toBe(16);
    open[0]!.socket.destroy();
    expect((await waiting.done).data.toString()).toBe("seventeenth");
    expect(connection.opened.length).toBe(17);

    const refill = exchange(forward.port, Buffer.from("refill"), false);
    await new Promise((resolve) => refill.socket.once("data", resolve));
    const asking = nextAsk();
    const late = exchange(forward.port, Buffer.from("too late"));
    // its wait for a free pipe began on the test clock before the clock moves
    await bounded(asking);
    clock.advance(30_000);
    const answer = await late.done;
    expect(answer.data.length).toBe(0);
    expect(connection.opened.length).toBe(18);
    for (const local of [...open, refill]) local.socket.destroy();
  });

  it("tries again when the machine answers RESET refused for a pipe it still counts", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const bridge = await echo();
    let answers = 0;
    const connection = await machine(ctx, key, { onPipe: (pipe) => { if (answers++ === 0) pipe.reset("refused"); else pipeToTarget(pipe, bridge.target); } });
    const forward = await forwardOf(ctx, key);
    expect((await exchange(forward.port, Buffer.from("after a refusal")).done).data.toString()).toBe("after a refusal");
    expect(connection.opened.length).toBe(2);
  });

  it("paces a burst of 120 local connections under the machine engine's 32 opens a second", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const bridge = await echo();
    const connection = await machine(ctx, key, { target: bridge.target });
    const forward = await forwardOf(ctx, key);
    const answers = await Promise.all(Array.from({ length: 120 }, (_, index) => exchange(forward.port, Buffer.from(`burst ${index}`)).done));
    expect(answers.map((answer) => answer.data.toString())).toEqual(Array.from({ length: 120 }, (_, index) => `burst ${index}`));
    expect(connection.mux.active).toBe(true);
    expect(connection.session.mux.active).toBe(true);
  }, 30_000);
});

describe("machine sessions", () => {
  it("lets a second session in for a switch, refuses a third, and quarantines the machine (both sessions end) past the switch window", async () => {
    const clock = new TestClock();
    const ctx = await controller({ clock });
    const key = await ctx.enrol();
    const bridge = await echo();
    const older = await machine(ctx, key, { target: bridge.target });
    const newer = await machine(ctx, key, { target: bridge.target });
    const third = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet });
    await third.hello();
    await third.sendAuth(key);
    expect(await bounded(third.error)).toEqual({ code: "resource_exhausted", message: "controller_limit" });
    // no new pipe while two sessions of the key are signed in: neither is proven the only one yet (todo 31)
    const forward = await forwardOf(ctx, key);
    const waiting = exchange(forward.port, Buffer.from("newest")).done.then((result) => result.data.length ? "answered" : "closed");
    let settled: string | undefined;
    const direct = ctx.fleet.openPipe(key.id, "bridge").then(() => "opened", (error: { reason?: string }) => error.reason ?? "failed");
    void direct.then((outcome) => { settled = outcome; });
    // a PIPE_OPEN would travel before these PINGs on the same channel, and its PIPE_ACCEPT before their PONGs
    for (let round = 0; round < 3; round++) { await bounded(newer.mux.measure()); await bounded(older.mux.measure()); }
    expect(settled).toBeUndefined();
    expect([older.opened.length, newer.opened.length]).toEqual([0, 0]);
    clock.advance(SWITCH_WINDOW_MS - 1);
    expect(newer.session.mux.active).toBe(true);
    const alerts: unknown[] = [];
    ctx.fleet.onAlert((alert) => alerts.push(alert));
    clock.advance(1);
    // a cloned key: the newer session never simply wins, neither stays, and the machine is held for its operator (todo 30)
    expect(await bounded(newer.error)).toEqual({ code: "auth_revoked", message: "quarantined" });
    expect(await bounded(older.error)).toEqual({ code: "auth_revoked", message: "quarantined" });
    expect(ctx.fleet.online(key.id)).toBe(false);
    expect(ctx.fleet.store.get(key.id)?.state).toBe("quarantined");
    expect(alerts).toEqual([{ kind: "quarantined", reason: "two_sessions", machine_id: key.id, slot: null, invite_id: null }]);
    // what waited never reached either session
    expect(await bounded(direct)).toBe("not_active");
    expect(await bounded(waiting)).toBe("closed");
    expect([older.opened.length, newer.opened.length]).toEqual([0, 0]);
  });

  it("keeps the newer session of a switch that ended the older one within the window", async () => {
    const clock = new TestClock();
    const ctx = await controller({ clock });
    const key = await ctx.enrol();
    const older = await machine(ctx, key, { target: 1 });
    const newer = await machine(ctx, key, { target: 1 });
    older.stop();
    await bounded(older.closed);
    clock.advance(SWITCH_WINDOW_MS * 2);
    expect(newer.session.mux.active).toBe(true);
  });

  it("refuses a machine past OVIS_FLEET_MAX with controller_limit, and lets it in once a place is free", async () => {
    const ctx = await controller({ max: 1 });
    const [first, second] = [await ctx.enrol(), await ctx.enrol()];
    const a = await machine(ctx, first, { target: 1 });
    const refused = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet });
    await refused.hello();
    await refused.sendAuth(second);
    expect(await bounded(refused.error)).toEqual({ code: "resource_exhausted", message: "controller_limit" });
    a.stop();
    await bounded(a.closed);
    expect(ctx.fleet.sessions).toBe(0);
    const b = await machine(ctx, second, { target: 1 });
    expect(b.session.mux.active).toBe(true);
  });

  it("refuses a store record whose machine_id is not its key's fingerprint", async () => {
    const ctx = await controller();
    const [key, other] = [await machineKey(), await machineKey()];
    // as a hand-edited store or a directory with no check would give it: the id of one key under another key
    const forged = { machines: () => [{ machine_id: other.id, public_key: key.spki, state: "active" as const }], onChange: () => () => {} };
    const connection = await machineConnection(ctx.fixture, forged, { machineSessions: ctx.fleet });
    await connection.hello();
    await connection.sendAuth(key, { machineId: other.id });
    expect(await bounded(connection.error)).toEqual({ code: "auth_failed", message: "unknown" });
    expect(ctx.fleet.sessions).toBe(0);
  });

  it("ends a sign-in revoked between its signature check and its AUTH_OK, and commits nothing", async () => {
    const ctx = await controller();
    const key = await ctx.enrol();
    const admit = ctx.fleet.admit.bind(ctx.fleet);
    ctx.fleet.admit = (machineId, session) => {
      const admission = admit(machineId, session);
      ctx.store.setState(machineId, "revoked");
      return admission;
    };
    const connection = await machineConnection(ctx.fixture, ctx.fleet, { machineSessions: ctx.fleet });
    await connection.hello();
    await connection.sendAuth(key);
    expect(await bounded(connection.error)).toEqual({ code: "auth_revoked", message: "revoked" });
    expect(connection.frames).not.toContain(0x04);
    expect(ctx.fleet.online(key.id)).toBe(false);
    expect(ctx.fleet.sessions).toBe(0);
  });
});

/**
 * Pipes (docs/fleet-link.md section 2) as the mux engine runs them: a controller engine and a machine engine joined by
 * an in-memory carrier, and a live machine session (server/relay/session.ts, `port: 0`) for the end-to-end and device
 * cases. The refusals of section 2's RESET table and of the pipe rows of the Limits table are generated from the
 * document, so a row added there without a test fails here.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BenchmarkClock } from "../../scripts/relay-mux-benchmark.ts";
import { MuxEngine, MuxStreamError } from "../../shared/relay-mux-engine.ts";
import { decodeFrame, encodeExtensionFrame, encodeFrame, FrameType, isExtensionFrame, LIMITS_V1 } from "../../shared/relay-mux.ts";
import type { ExtensionFrame, MuxFrame, SessionError } from "../../shared/relay-mux.ts";
import { bounded, deferred, relayConnection, relayDevice, relayFixture, TestClock } from "../relay/test-helpers.ts";
import { benchmarkPipes } from "./pipe-benchmark.ts";
import {
  acceptPipe, fleetMuxExtension, helloKind, MAX_PIPE_STREAMS, openPipe, PIPE_ADVERT_BYTES, PIPE_DATA_BYTES, PIPE_WINDOW_BYTES, PipeFrame, pipeMuxExtension,
} from "./mux-ext.ts";
import type { PipeResetCode, PipeStream } from "./mux-ext.ts";
import { machineConnection, machineKey, memoryDirectory, recordOf } from "./test-helpers.ts";

const KiB = 1024;
const MiB = 1024 * KiB;
const MACHINE_ID = "00112233445566778899aabbccddeeff";
const ROOT = join(import.meta.dir, "..", "..");
const doc = readFileSync(join(ROOT, "docs", "fleet-link.md"), "utf8");
/** The rows of a `<!-- contract:<marker> -->` table, cells without their code ticks. */
function table(marker: string): string[][] {
  const lines = doc.split("\n");
  const at = lines.indexOf(`<!-- contract:${marker} -->`);
  if (at < 0) throw new Error(`no table ${marker}`);
  const rows: string[][] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("|")) { if (rows.length) break; continue; }
    rows.push(line.slice(1, -1).split("|").map((cell) => cell.trim().replace(/`/g, "")));
  }
  return rows.slice(2);
}

type End = "controller" | "machine";
const frameOf = (type: number, id: number, payload: unknown): ExtensionFrame => ({ extension: true, type, flags: 0, stream_id: id, payload });
const bytesOf = (frame: MuxFrame | ExtensionFrame) => isExtensionFrame(frame) ? encodeExtensionFrame(frame, pipeMuxExtension) : encodeFrame(frame, pipeMuxExtension);
/** Deterministic bytes that differ at every offset of a fragment, so a reordered or dropped fragment shows. */
function pattern(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) { state = (state * 1103515245 + 12345) >>> 0; bytes[i] = state >>> 24; }
  return bytes;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function readAll(pipe: PipeStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = pipe.readable.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) chunks.push(next.value);
  return Buffer.concat(chunks);
}

/**
 * A signed-in controller and machine joined by an in-memory carrier that delivers in order. The machine takes every
 * pipe to one of `endpoints` and answers it at once unless `answer` is false. `inject` sends raw bytes from one end in
 * the place of one PING that end counts, so receipts stay in step; `mute` stops what an end sends from arriving.
 */
function pair(options: { clock?: TestClock; endpoints?: string[]; answer?: boolean; signedIn?: boolean } = {}) {
  const clock = options.clock ?? new TestClock();
  const closed = { controller: deferred<SessionError>(), machine: deferred<SessionError>() };
  const sent: Record<End, (MuxFrame | ExtensionFrame)[]> = { controller: [], machine: [] };
  const replacements: Record<End, Uint8Array[]> = { controller: [], machine: [] };
  const muted: Record<End, boolean> = { controller: false, machine: false };
  const machinePipes: PipeStream[] = [];
  const pipeArrived: (() => void)[] = [];
  const engines = {} as Record<End, MuxEngine>;
  const make = (end: End) => new MuxEngine({
    role: end === "controller" ? "server" : "client", clock, outboundWireByteLength: (bytes) => bytes.length,
    routingOverhead: 0, maxWireMessageBytes: 64 * KiB, extension: pipeMuxExtension, close: () => {},
    onClose: (error) => closed[end].resolve(error.code),
    send: async (bytes) => {
      const out = bytes[1] === FrameType.PING ? replacements[end].shift() ?? bytes : bytes;
      // a frame a test injects may be one no codec takes: it is logged as it is
      try { sent[end].push(decodeFrame(out, false, pipeMuxExtension)); } catch { sent[end].push({ extension: true, type: out[1] ?? 0, flags: 0, stream_id: 0, payload: out }); }
      const copy = out.slice();
      if (!muted[end]) queueMicrotask(() => engines[end === "controller" ? "machine" : "controller"].receive(copy));
    },
    onExtension: (frame) => {
      const pipe = end === "machine" ? acceptPipe(engines.machine, frame, options.endpoints ?? ["bridge", "native"]) : undefined;
      if (!pipe) { if (frame.type !== PipeFrame.OPEN) engines[end].fail("protocol_error", "Unexpected frame"); return; }
      machinePipes.push(pipe);
      if (options.answer !== false) pipe.accept();
      for (const wake of pipeArrived.splice(0)) wake();
    },
  });
  engines.controller = make("controller");
  engines.machine = make("machine");
  if (options.signedIn !== false) for (const engine of Object.values(engines)) engine.authenticateExtension(MACHINE_ID);
  return {
    ...engines, clock, closed, sent, machinePipes,
    nextPipe: () => bounded(new Promise<PipeStream>((resolve) => {
      const count = machinePipes.length;
      const check = () => { if (machinePipes.length > count) resolve(machinePipes[count]!); else pipeArrived.push(check); };
      pipeArrived.push(check);
    })),
    inject(from: End, bytes: Uint8Array) {
      replacements[from].push(bytes);
      engines[from].enqueueControl({ type: FrameType.PING, flags: 0, stream_id: 0, payload: 0n });
    },
    mute(end: End) { muted[end] = true; },
    /** Lets every queued frame and read go through, until neither end has anything left to send. */
    async settle() {
      for (let turns = 0; turns < 10_000; turns++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (engines.controller.senderIdle && engines.machine.senderIdle) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (engines.controller.senderIdle && engines.machine.senderIdle) return;
        }
      }
      throw new Error("the pair never went quiet");
    },
  };
}
async function openPair(p: ReturnType<typeof pair>, endpoint = "bridge") {
  const arriving = p.nextPipe();
  const controller = openPipe(p.controller, endpoint);
  const accepted = new Promise<void>((resolve) => { controller.onAccept = resolve; });
  const machine = await arriving;
  await bounded(accepted);
  return { controller, machine };
}
const disposal = (pipe: PipeStream) => new Promise<string | undefined>((resolve) => { pipe.onDispose = (error) => resolve(error?.code); });

const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

describe("data", () => {
  it("crosses unchanged in both directions, in fragments of at most 16 KiB", async () => {
    const p = pair();
    const { controller, machine } = await openPair(p);
    const down = pattern(8 * MiB + 123, 1);
    const up = pattern(8 * MiB + 77, 2);
    const [atMachine, atController] = await bounded(Promise.all([
      readAll(machine), readAll(controller),
      controller.write(down).then(() => controller.end()), machine.write(up).then(() => machine.end()),
    ]), 60_000);
    expect(sha256(atMachine)).toBe(sha256(down));
    expect(sha256(atController)).toBe(sha256(up));
    for (const end of ["controller", "machine"] as const) {
      const data = p.sent[end].filter((frame) => frame.type === PipeFrame.DATA).map((frame) => (frame.payload as Uint8Array).length);
      expect(data.every((length) => length >= 1 && length <= PIPE_DATA_BYTES)).toBe(true);
      expect(data.filter((length) => length === PIPE_DATA_BYTES).length).toBe(data.length - 1);
    }
  });

  it("half-closes each way on its own, and the pipe retires once both ends ended and every byte was read", async () => {
    const p = pair();
    const { controller, machine } = await openPair(p);
    const gone = [disposal(controller), disposal(machine)];
    await controller.write(new TextEncoder().encode("ping"));
    await controller.end();
    expect(new TextDecoder().decode(await readAll(machine))).toBe("ping");
    // the machine's direction is still open after the controller's END
    await machine.write(new TextEncoder().encode("pong"));
    expect(p.controller.stats.streams).toBe(1);
    await machine.end();
    expect(new TextDecoder().decode(await readAll(controller))).toBe("pong");
    expect(await bounded(Promise.all(gone))).toEqual([undefined, undefined]);
    await p.settle();
    for (const engine of [p.controller, p.machine]) expect([engine.stats.streams, engine.stats.reservedBytes]).toEqual([0, 0]);
  });

  it("refuses DATA after the sender's END with protocol_error", async () => {
    const p = pair();
    const { controller } = await openPair(p);
    await controller.end();
    await p.settle();
    p.mute("machine");
    p.inject("controller", bytesOf(frameOf(PipeFrame.DATA, 2, new Uint8Array([1]))));
    expect(await bounded(p.closed.machine.promise)).toBe("protocol_error");
  });
});

describe("credit", () => {
  it("blocks a sender at the window until CREDIT, with no busy loop and bounded memory", async () => {
    const p = pair();
    const { controller, machine } = await openPair(p);
    const source = pattern(4 * MiB, 3);
    let written = false;
    const writing = controller.write(source).then(() => { written = true; });
    await p.settle();
    // the window is spent (no full DATA frame fits what is left), the writer waits, and neither end has anything to send
    expect(BigInt(PIPE_WINDOW_BYTES) - controller.sent).toBeLessThan(BigInt(PIPE_DATA_BYTES));
    expect(written).toBe(false);
    expect([p.controller.senderIdle, p.machine.senderIdle]).toEqual([true, true]);
    expect(BigInt(machine.inboundBytes)).toBe(controller.sent);
    expect(p.controller.stats.queuedBytes).toBeLessThanOrEqual(192 * KiB);
    expect(p.controller.stats.accountedBytes).toBeLessThan(PIPE_WINDOW_BYTES + 256 * KiB);
    expect(p.machine.stats.accountedBytes).toBeLessThan(2 * PIPE_WINDOW_BYTES + 64 * KiB);
    const frames = p.sent.controller.length;
    await p.settle();
    expect(p.sent.controller.length).toBe(frames);
    // reading returns CREDIT and the rest goes through, in order
    const [received] = await bounded(Promise.all([readAll(machine), writing.then(() => controller.end())]), 30_000);
    expect(written).toBe(true);
    expect(sha256(received)).toBe(sha256(source));
  });

  it("resets a pipe whose reader takes nothing for 30 s `slow_consumer`, and frees what it held", async () => {
    const p = pair();
    const { controller, machine } = await openPair(p);
    const gone = [disposal(controller), disposal(machine)];
    const writing = controller.write(pattern(2 * MiB, 4)).catch((error: unknown) => error);
    await p.settle();
    expect(BigInt(PIPE_WINDOW_BYTES) - controller.sent).toBeLessThan(BigInt(PIPE_DATA_BYTES));
    p.clock.advance(30_000);
    expect(((await bounded(writing)) as MuxStreamError).code).toBe("slow_consumer");
    expect(await bounded(Promise.all(gone))).toEqual(["slow_consumer", "slow_consumer"]);
    await p.settle();
    for (const engine of [p.controller, p.machine]) {
      expect(engine.active).toBe(true);
      expect([engine.stats.streams, engine.stats.reservedBytes, engine.stats.queuedBytes, engine.stats.inboundBytes]).toEqual([0, 0, 0, 0]);
    }
  });

  it("refuses a second write while one is pending", async () => {
    const p = pair();
    const { controller } = await openPair(p);
    const first = controller.write(new Uint8Array(4));
    await expect(controller.write(new Uint8Array(4))).rejects.toThrow("already pending");
    await first;
  });
});

describe("who opens", () => {
  it("the controller, on even ids from 2, each 2 above the last", async () => {
    const p = pair();
    const pipes = [openPipe(p.controller, "bridge"), openPipe(p.controller, "native"), openPipe(p.controller, "bridge")];
    await p.settle();
    expect(pipes.map((pipe) => pipe.id)).toEqual([2, 4, 6]);
    expect(p.machinePipes.map((pipe) => [pipe.id, pipe.endpoint])).toEqual([[2, "bridge"], [4, "native"], [6, "bridge"]]);
  });

  it("never the machine: its engine cannot open one, and a PIPE_OPEN it sends ends the session protocol_error", async () => {
    const p = pair();
    expect(() => openPipe(p.machine, "bridge")).toThrow("Cannot open a stream");
    p.mute("controller");
    p.inject("machine", bytesOf(frameOf(PipeFrame.OPEN, 2, { endpoint: "bridge" })));
    expect(await bounded(p.closed.controller.promise)).toBe("protocol_error");
  });

  it("nobody before sign-in", () => {
    const p = pair({ signedIn: false });
    expect(() => openPipe(p.controller, "bridge")).toThrow("Cannot open a stream");
  });

  it("ends the id space with GOAWAY id_exhausted at 0x7ffffffe", async () => {
    const p = pair();
    Reflect.set(p.controller, "lastServerOpenId", 0x7ffffffc);
    Reflect.set(p.machine, "lastServerOpenId", 0x7ffffffc);
    const last = openPipe(p.controller, "bridge");
    await p.settle();
    expect(last.id).toBe(0x7ffffffe);
    expect(p.sent.controller.find((frame) => frame.type === FrameType.GOAWAY)?.payload).toEqual({ code: "id_exhausted", last_open_id: 0x7ffffffe, drain_ms: 5000 });
    expect(() => openPipe(p.controller, "bridge")).toThrow("Cannot open a stream");
  });
});

describe("carrier loss", () => {
  it("resets every pipe upstream_lost on both ends, sending nothing", async () => {
    const p = pair();
    const first = await openPair(p, "bridge");
    const second = await openPair(p, "native");
    const pipes = [first.controller, second.controller, first.machine, second.machine];
    const gone = pipes.map(disposal);
    const frames = p.sent.controller.length;
    p.controller.carrierLost();
    p.machine.carrierLost();
    expect(await bounded(Promise.all(gone))).toEqual(["upstream_lost", "upstream_lost", "upstream_lost", "upstream_lost"]);
    expect(p.sent.controller.length).toBe(frames);
    await expect(first.controller.readable.getReader().read()).rejects.toMatchObject({ code: "upstream_lost" });
  });
});

describe("docs/fleet-link.md section 2, RESET codes", () => {
  const rows = table("reset-codes");
  it("lists the five codes the extension takes", () => {
    expect(rows.map((row) => row[0])).toEqual([...pipeMuxExtension.streams!.resets]);
  });
  for (const [code, sentBy] of rows) {
    for (const from of sentBy === "either" ? ["controller", "machine"] as const : [sentBy as End]) {
      it(`${code} from the ${from} ends only that pipe, with that code, on both ends`, async () => {
        const p = pair();
        const pipe = await openPair(p);
        const other = await openPair(p, "native");
        const gone = [disposal(pipe.controller), disposal(pipe.machine)];
        pipe[from].reset(code as PipeResetCode);
        expect(await bounded(Promise.all(gone))).toEqual([code, code]);
        await p.settle();
        expect([p.controller.active, p.machine.active, other.controller.live, other.machine.live]).toEqual([true, true, true, true]);
        expect([p.controller.stats.streams, p.machine.stats.streams]).toEqual([1, 1]);
      });
    }
  }
  it("any other code on a pipe ends the session protocol_error", async () => {
    const p = pair();
    await openPair(p);
    p.mute("controller");
    p.inject("machine", bytesOf({ type: FrameType.RESET, flags: 0, stream_id: 2, payload: { code: "bad_request", message: "" } }));
    expect(await bounded(p.closed.controller.promise)).toBe("protocol_error");
  });
});

describe("docs/fleet-link.md Limits, the pipe rows", () => {
  const rows = table("limits").filter(([limit]) => limit === "max_pipe_streams" || limit!.startsWith("pipe_"));
  const answer = (text: string) => /^(RESET|SESSION_ERROR) ([a-z_]+)$/.exec(text)!.slice(1) as ["RESET" | "SESSION_ERROR", string];
  it("holds the pipe limits with the values the code uses", () => {
    expect(Object.fromEntries(rows.map(([limit, value]) => [limit, Number(value)]))).toEqual({
      max_pipe_streams: MAX_PIPE_STREAMS, pipe_window_bytes: PIPE_WINDOW_BYTES, pipe_data_bytes: PIPE_DATA_BYTES, pipe_advert_bytes: PIPE_ADVERT_BYTES,
    });
  });
  for (const [limit, value, , text] of rows) {
    it(`${limit} ${value}: past it, ${text}`, async () => {
      const [kind, code] = answer(text!);
      const p = pair();
      switch (limit) {
        case "max_pipe_streams": {
          for (let i = 0; i < Number(value); i++) await openPair(p);
          expect(p.controller.stats.reservedBytes).toBe(12 * MiB);
          // the controller opens no 17th, and a machine refuses one that comes
          expect(() => openPipe(p.controller, "bridge")).toThrow(MuxStreamError);
          p.mute("machine");
          p.inject("controller", bytesOf(frameOf(PipeFrame.OPEN, 2 * Number(value) + 2, { endpoint: "bridge" })));
          await p.settle();
          expect(kind).toBe("RESET");
          expect(p.sent.machine.find((frame) => frame.type === FrameType.RESET)?.payload).toEqual({ code, message: "" });
          expect([p.machine.active, p.machine.stats.streams]).toEqual([true, Number(value)]);
          return;
        }
        case "pipe_window_bytes": {
          const { machine } = await openPair(p);
          await machine.write(new Uint8Array(Number(value)));
          await p.settle();
          p.mute("controller");
          p.inject("machine", bytesOf(frameOf(PipeFrame.DATA, 2, new Uint8Array(1))));
          expect(kind).toBe("SESSION_ERROR");
          expect(await bounded(p.closed.controller.promise)).toBe(code as SessionError);
          return;
        }
        case "pipe_data_bytes": {
          await openPair(p);
          const frame = new Uint8Array(8 + Number(value) + 1);
          frame.set([1, PipeFrame.DATA, 0, 0, 0, 0, 0, 2]);
          p.mute("controller");
          p.inject("machine", frame);
          expect(kind).toBe("SESSION_ERROR");
          expect(await bounded(p.closed.controller.promise)).toBe(code as SessionError);
          return;
        }
        case "pipe_advert_bytes": {
          const advert = { endpoints: ["bridge"], runtime_id: "rt", boot_id: "b", bridge_token: "0".repeat(64), health: { runtime: "up", bridge: "up" },
            now: 1, versions: { server: "1", link: "1", agent: "1", runtime: "1" }, pad: "p".repeat(Number(value)) };
          const body = new TextEncoder().encode(JSON.stringify(advert));
          const frame = new Uint8Array(8 + body.length);
          frame.set([1, PipeFrame.ADVERT, 0, 0, 0, 0, 0, 0]);
          frame.set(body, 8);
          p.mute("controller");
          p.inject("machine", frame);
          expect(kind).toBe("SESSION_ERROR");
          expect(await bounded(p.closed.controller.promise)).toBe(code as SessionError);
          return;
        }
        default: throw new Error(`no test for ${limit}`);
      }
    });
  }
});

describe("negotiation", () => {
  it("makes a machine only of a HELLO that offers and requires pipe-stream", () => {
    expect(helloKind(["pipe-stream"], ["pipe-stream"])).toBe("machine");
    expect(helloKind(["pipe-stream"], [])).toBe("protocol_error");
    expect(helloKind(["pipe-stream", "pair-sas"], ["pipe-stream"])).toBe("protocol_error");
    expect(helloKind(["pipe-stream", "other"], ["pipe-stream", "other"])).toBe("unsupported_extension");
    expect(helloKind(["pair-sas"], [])).toBe("device");
  });

  it("names max_pipe_streams 16 after the v1 limits in a fleet controller's WELCOME, which a phone reads as before", async () => {
    const welcome = { type: FrameType.WELCOME, flags: 0, stream_id: 0, payload: {
      protocol: "ovis-mux", version: 1, features: [], limits: LIMITS_V1, nonce: "A".repeat(43), server_version: "0.5.0",
      relay_protocol: 1, min_supported_client: "0.4.21" } } as const;
    const sent: Uint8Array[] = [];
    const engine = (extension: typeof fleetMuxExtension | undefined) => new MuxEngine({
      role: "server", clock: new TestClock(), outboundWireByteLength: (bytes) => bytes.length, routingOverhead: 0,
      maxWireMessageBytes: 64 * KiB, close: () => {}, send: async (bytes) => { sent.push(bytes.slice()); }, ...(extension ? { extension } : {}),
    });
    for (const extension of [fleetMuxExtension, undefined]) {
      const server = engine(extension);
      server.sendSession(welcome);
      await server.flush();
    }
    const [fleet, plain] = sent;
    expect(Object.entries(JSON.parse(new TextDecoder().decode(fleet!.subarray(8))).limits)).toEqual([...Object.entries(LIMITS_V1), ["max_pipe_streams", 16]]);
    expect(decodeFrame(fleet!)).toEqual(decodeFrame(plain!));
    // without the extension the bytes are today's
    expect(plain).toEqual(encodeFrame(welcome));
  });
});

describe("a live machine session", () => {
  it("carries 8 MiB through a pipe the controller opens, echoed back, with the same SHA-256 at each end", async () => {
    const fixture = relayFixture();
    fixtures.push(fixture);
    const key = await machineKey();
    const atMachine = createHash("sha256");
    const connection = await machineConnection(fixture, memoryDirectory([recordOf(key)]), {}, {
      onPipe: (pipe) => {
        pipe.accept();
        void (async () => {
          const reader = pipe.readable.getReader();
          for (let next = await reader.read(); !next.done; next = await reader.read()) {
            atMachine.update(next.value);
            await pipe.write(next.value);
          }
          await pipe.end();
        })();
      },
    });
    await connection.hello();
    await connection.signIn(key);
    const source = pattern(8 * MiB, 5);
    const pipe = connection.session.openPipe("bridge");
    const [echoed] = await bounded(Promise.all([readAll(pipe), pipe.write(source).then(() => pipe.end())]), 60_000);
    expect(atMachine.digest("hex")).toBe(sha256(source));
    expect(sha256(echoed)).toBe(sha256(source));
  });

  it("is the only kind that has pipes: a device session opens none and ends on any pipe frame", async () => {
    for (const bytes of [
      bytesOf(frameOf(PipeFrame.OPEN, 2, { endpoint: "bridge" })),
      bytesOf(frameOf(PipeFrame.DATA, 2, new Uint8Array([1]))),
      bytesOf(frameOf(PipeFrame.ADVERT, 0, { endpoints: ["bridge"], runtime_id: "rt", boot_id: "b", bridge_token: "0".repeat(64),
        health: { runtime: "up", bridge: "up" }, now: 1, versions: { server: "1", link: "1", agent: "1", runtime: "1" } })),
      bytesOf({ type: FrameType.CREDIT, flags: 0, stream_id: 2, payload: 0n }),
    ]) {
      const fixture = relayFixture();
      fixtures.push(fixture);
      const device = await relayDevice(fixture);
      const phone = await relayConnection(fixture, { fleet: memoryDirectory([]) });
      await phone.auth(device);
      expect(() => phone.session.openPipe("bridge")).toThrow(MuxStreamError);
      phone.transformClientFrame = (frame) => frame[1] === FrameType.PING ? bytes : frame;
      phone.mux.ping();
      expect(await bounded(phone.serverError)).toBe("protocol_error");
      expect(phone.frames.some((frame) => frame.type >= 0x40 && frame.type <= 0x4f)).toBe(false);
    }
  });
});

describe("benchmark", () => {
  for (const mode of ["binary", "base64"] as const) it(`keeps terminal echo p95 within 1.05x idle at 50 ms RTT while a pipe carries 64 MiB (${mode})`, async () => {
    const idleClock = new BenchmarkClock();
    const idle = await idleClock.run(benchmarkPipes(idleClock, 50, false, 100, mode));
    const clock = new BenchmarkClock();
    const loaded = await clock.run(benchmarkPipes(clock, 50, true, 100, mode));
    console.log(JSON.stringify({ idleP95Ms: idle.echoP95Ms, ...loaded, latencyRatio: loaded.echoP95Ms / idle.echoP95Ms }));
    expect(loaded.bytes).toBe(64 * MiB);
    expect(loaded.echoSamples).toBeGreaterThan(100);
    expect(loaded.mbPerSecond).toBeGreaterThanOrEqual(5);
    expect(loaded.echoP95Ms).toBeLessThanOrEqual(idle.echoP95Ms * 1.05);
    expect(loaded.peakAccounted).toBeLessThan(32 * MiB);
  }, 60_000);
});

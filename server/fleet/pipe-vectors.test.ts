/**
 * The pipes of docs/fleet-link.md section 2 against server/fleet/vectors/pipe-frames.json. Every case's bytes go
 * through the codec with the fleet extension (server/fleet/mux-ext.ts: the pipe frames when the session selected
 * `pipe-stream`, the sign-in part alone when it did not); an accepted canonical case must come out of the encoder byte
 * for byte. Then the receiving end takes it in the case's state: a live machine session (server/relay/session.ts on a
 * server started with `port: 0`) for what a machine sends its controller, and a machine's own engine fed the
 * controller's frames for what goes the other way. A case no step handles fails, so a vector added later cannot pass
 * untested.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MuxEngine } from "../../shared/relay-mux-engine.ts";
import { decodeFrame, encodeExtensionFrame, encodeFrame, FrameType, isExtensionFrame, MuxProtocolError } from "../../shared/relay-mux.ts";
import type { ExtensionFrame, MuxFrame, SessionError } from "../../shared/relay-mux.ts";
import { bounded, deferred, relayFixture, TestClock } from "../relay/test-helpers.ts";
import { acceptPipe, fleetMuxExtension, PipeFrame, pipeMuxExtension } from "./mux-ext.ts";
import type { PipeAdvert, PipeStream } from "./mux-ext.ts";
import { machineConnection, machineKey, memoryDirectory, recordOf } from "./test-helpers.ts";

type Obj = Record<string, unknown>;
interface Refuse { stage: "decode" | "verify" | "session"; kind: "session_error" | "reset"; code: string }
interface Case {
  name: string; frame: string; type: number; stream_id: number; direction: "machine_to_controller" | "controller_to_machine";
  context: Obj & { state: "before_auth" | "after_auth"; selected: string[] }; bytes: string; canonical?: boolean;
  expect: { parse?: Obj; refuse?: Refuse; effect?: string };
}
const vectors = JSON.parse(readFileSync(join(import.meta.dir, "vectors", "pipe-frames.json"), "utf8")) as { cases: Case[] };
const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const MACHINE_ID = "00112233445566778899aabbccddeeff";

/** The receiving end's codec, as the case's session negotiated it; the controller filters request headers. */
const extensionOf = (entry: Case) => entry.context.selected.includes("pipe-stream") ? pipeMuxExtension : fleetMuxExtension;
const decode = (entry: Case) => decodeFrame(fromHex(entry.bytes), entry.direction === "machine_to_controller", extensionOf(entry));

/** The field name docs/fleet-link.md gives each frame whose payload is one u64. */
const COUNTERS: Record<number, string> = { [FrameType.CREDIT]: "consumed", [FrameType.PING]: "probe", [FrameType.PONG]: "probe", [FrameType.RECEIVED]: "frames" };
/** A decoded frame as the vector writes it: raw payloads as hex, a u64 as a decimal string. */
function parsed(frame: MuxFrame | ExtensionFrame): unknown {
  if (frame.payload instanceof Uint8Array) return { data: hex(frame.payload) };
  if (typeof frame.payload === "bigint") return { [COUNTERS[frame.type]!]: String(frame.payload) };
  return frame.payload;
}
function encode(frame: MuxFrame | ExtensionFrame, entry: Case): Uint8Array {
  return isExtensionFrame(frame) ? encodeExtensionFrame(frame, extensionOf(entry)) : encodeFrame(frame, extensionOf(entry));
}

const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

/** The pipes open before the case's frame: up to `last_pipe_id`, else the case's own pipe for a frame on one. */
const openBefore = (entry: Case) => Number(entry.context["last_pipe_id"] ?? (entry.frame === "PIPE_OPEN" ? 0 : entry.stream_id));

/**
 * A machine's own engine, signed in when the case says so, fed the controller's frames one by one. It accepts each
 * PIPE_OPEN for an endpoint of its advert (and answers it unless the case says the pipe is not accepted yet), and
 * ends the session on any other frame of the extension that reaches it, as a link agent does (section 3).
 */
async function machineEngine(entry: Case) {
  const clock = new TestClock();
  const sent: (MuxFrame | ExtensionFrame)[] = [];
  const pipes = new Map<number, PipeStream>();
  const closed = deferred<SessionError>();
  const advert = (entry.context["advert"] as string[] | undefined) ?? ["bridge", "native"];
  const engine: MuxEngine = new MuxEngine({
    role: "client", clock, outboundWireByteLength: (bytes) => bytes.length, routingOverhead: 0, maxWireMessageBytes: 64 * 1024,
    extension: pipeMuxExtension, close: () => {}, onClose: (error) => closed.resolve(error.code),
    send: async (bytes) => { sent.push(decodeFrame(bytes, false, pipeMuxExtension)); },
    onExtension: (frame) => {
      const pipe = frame.type === PipeFrame.OPEN ? acceptPipe(engine, frame, advert) : undefined;
      if (frame.type !== PipeFrame.OPEN) { engine.fail("protocol_error", "Not a frame for a machine"); return; }
      if (!pipe) return;
      pipes.set(frame.stream_id, pipe);
      if (entry.context["accepted"] !== false) pipe.accept();
    },
  });
  if (entry.context.state === "after_auth") engine.authenticateExtension(MACHINE_ID);
  // frames the machine sent before the case's frame, for a RECEIVED to acknowledge
  for (let sent = 0; sent < Number(entry.context["machine_sent"] ?? 0); sent++) engine.enqueueControl({ type: FrameType.PING, flags: 0, stream_id: 0, payload: BigInt(sent) });
  const feed = (frame: MuxFrame | ExtensionFrame) => engine.receive(encode(frame, entry));
  const last = openBefore(entry);
  // 2^30 opens cannot be fed: the watermark of the id-exhausted case is set as the opens would leave it
  if (last === 0x7ffffffe) Reflect.set(engine, "lastServerOpenId", last);
  else for (let id = 2; id <= last; id += 2) feed({ extension: true, type: PipeFrame.OPEN, flags: 0, stream_id: id, payload: { endpoint: "bridge" } });
  // the controller sends on a pipe only after the machine's PIPE_ACCEPT went out
  await engine.flush();
  const pipe = (id: number) => ({ extension: true as const, flags: 0, stream_id: id });
  if (entry.context["ended_by_sender"]) feed({ ...pipe(entry.stream_id), type: PipeFrame.END, payload: {} });
  for (let left = Number(entry.context["received"] ?? 0); left > 0; left -= 16376) {
    feed({ ...pipe(entry.stream_id), type: PipeFrame.DATA, payload: new Uint8Array(Math.min(left, 16376)) });
  }
  return { engine, clock, sent, pipes, closed: closed.promise, feed };
}

/** What the controller of a live machine session does with a machine's frame in the case's state. */
async function controllerSession(entry: Case) {
  const fixture = relayFixture();
  fixtures.push(fixture);
  const key = await machineKey();
  const machinePipes = new Map<number, PipeStream>();
  const last = openBefore(entry);
  const opened = deferred<void>();
  const connection = await machineConnection(fixture, memoryDirectory([recordOf(key)]), {}, {
    // the machine takes each pipe and answers it only when the case says the pipe is accepted
    onPipe: (pipe) => {
      machinePipes.set(pipe.id ?? 0, pipe);
      if (entry.context["accepted"] === true) pipe.accept();
      if (machinePipes.size === last / 2) opened.resolve();
    },
  });
  await connection.hello();
  if (entry.context.state === "after_auth") await connection.signIn(key);
  const pipes: PipeStream[] = [];
  const disposed = new Map<number, string | undefined>();
  for (let id = 2; id <= last; id += 2) {
    const pipe = connection.session.openPipe("bridge");
    pipe.onDispose = (error) => { disposed.set(id, error?.code); };
    pipes.push(pipe);
  }
  if (pipes.length) await bounded(opened.promise);
  if (entry.context["accepted"] === true) await bounded(new Promise<void>((resolve) => { const pipe = pipes.at(-1)!; if (pipe.accepted) resolve(); else pipe.onAccept = resolve; }));
  const sent = Number(entry.context["sent"] ?? 0);
  if (sent) await bounded(pipes[0]!.write(new Uint8Array(sent)));
  connection.sendBytes(fromHex(entry.bytes));
  return { connection, pipes, disposed };
}

describe("pipe-frames.json", () => {
  it("covers every pipe frame of the document in both directions", () => {
    const frames = new Set(vectors.cases.map((entry) => entry.frame));
    for (const frame of ["PIPE_OPEN", "PIPE_ACCEPT", "PIPE_DATA", "PIPE_END", "PIPE_ADVERT", "CREDIT", "RESET", "GOAWAY"]) expect(frames.has(frame)).toBe(true);
  });

  for (const entry of vectors.cases) {
    it(entry.name, async () => {
      const refuse = entry.expect.refuse;
      if (refuse?.stage === "decode") {
        let error: unknown;
        try { decode(entry); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(MuxProtocolError);
        expect((error as MuxProtocolError).code as string).toBe(refuse.code);
        return;
      }
      const frame = decode(entry);
      expect(frame.type).toBe(entry.type);
      expect(frame.stream_id).toBe(entry.stream_id);
      expect(parsed(frame)).toEqual(entry.expect.parse!);
      // docs/fleet-link.md, "Canonical encoding": an encoder writes exactly these bytes
      if (entry.canonical !== false) expect(hex(encode(frame, entry))).toBe(entry.bytes);

      if (entry.direction === "controller_to_machine") {
        const machine = await machineEngine(entry);
        machine.engine.receive(fromHex(entry.bytes));
        await machine.engine.flush();
        if (refuse?.kind === "session_error") {
          expect(await bounded(machine.closed)).toBe(refuse.code as SessionError);
          return;
        }
        expect(machine.engine.active).toBe(true);
        if (refuse?.kind === "reset") {
          // the machine answers the open with RESET refused and starts nothing for it
          expect(machine.sent.find((sent) => sent.type === FrameType.RESET && sent.stream_id === entry.stream_id)?.payload).toEqual({ code: refuse.code, message: "" });
          expect(machine.pipes.has(entry.stream_id)).toBe(false);
          return;
        }
        switch (entry.frame) {
          case "PIPE_OPEN":
            expect(machine.pipes.get(entry.stream_id)?.endpoint).toBe(entry.expect.parse!["endpoint"] as string);
            expect(machine.sent.some((sent) => sent.type === PipeFrame.ACCEPT && sent.stream_id === entry.stream_id)).toBe(true);
            return;
          case "PIPE_DATA": {
            const reader = machine.pipes.get(entry.stream_id)!.readable.getReader();
            expect(hex((await reader.read()).value!)).toBe(entry.expect.parse!["data"] as string);
            return;
          }
          case "PIPE_END":
            expect((await machine.pipes.get(entry.stream_id)!.readable.getReader().read()).done).toBe(true);
            return;
          case "RESET":
            // the pipe is gone for the machine with the controller's code
            expect(machine.pipes.get(entry.stream_id)?.live).toBe(false);
            expect(machine.engine.stats.streams).toBe(0);
            return;
          case "GOAWAY":
            // the session ends once the drain time passes; the machine dials a new one (todo 24)
            machine.clock.advance(entry.expect.parse!["drain_ms"] as number);
            expect(await bounded(machine.closed)).toBe("timeout");
            return;
          case "PING":
            expect(machine.sent.find((sent) => sent.type === FrameType.PONG)?.payload).toBe(BigInt(entry.expect.parse!["probe"] as string));
            return;
          case "RECEIVED":
            expect(machine.engine.stats.acknowledged).toBe(BigInt(entry.expect.parse!["frames"] as string));
            return;
          default: throw new Error(`no effect checked for ${entry.name}`);
        }
      }

      const controller = await controllerSession(entry);
      if (refuse?.kind === "session_error") {
        expect((await bounded(controller.connection.error)).code).toBe(refuse.code as SessionError);
        return;
      }
      // a later round trip proves the controller read the frame and kept the session
      await bounded(controller.connection.mux.measure());
      expect(controller.connection.session.mux.active).toBe(true);
      const pipe = controller.pipes[0];
      switch (entry.frame) {
        case "PIPE_ACCEPT":
          expect(pipe?.accepted).toBe(true);
          expect([pipe?.sendWindow, pipe?.receiveWindow]).toEqual([786432, 786432]);
          return;
        case "PIPE_DATA":
          expect(pipe?.inboundBytes).toBe(fromHex(entry.expect.parse!["data"] as string).length);
          return;
        case "CREDIT":
          expect(pipe?.peerConsumed).toBe(BigInt(entry.expect.parse!["consumed"] as string));
          return;
        case "RESET":
          expect(controller.disposed.get(entry.stream_id)).toBe(entry.expect.parse!["code"] as string);
          return;
        case "GOAWAY": {
          const watermark = entry.expect.parse!["last_open_id"] as number;
          for (const [id, code] of controller.disposed) expect(id > watermark ? code : "open").toBe(id > watermark ? "refused" : "open");
          expect(controller.disposed.get(Number(entry.context["last_pipe_id"]))).toBe("refused");
          expect(() => controller.connection.session.openPipe("bridge")).toThrow();
          return;
        }
        case "PIPE_ADVERT":
          expect(controller.connection.session.pipeAdvert as PipeAdvert | undefined).toEqual(entry.expect.parse as unknown as PipeAdvert);
          return;
        case "PONG":
          // a PONG the controller did not ask for is ignored: the round trip above found the session as it was
          return;
        case "RECEIVED":
          expect(controller.connection.session.mux.stats.acknowledged >= BigInt(entry.expect.parse!["frames"] as string)).toBe(true);
          return;
        default: throw new Error(`no effect checked for ${entry.name}`);
      }
    });
  }
});

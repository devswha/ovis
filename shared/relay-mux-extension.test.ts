/**
 * The neutral extension hook of the mux (MuxExtension, authenticateExtension) with a made-up extension: an AUTH scheme
 * `test-key`, an AUTH_OK role `tester` and one frame type 0x4e. Without an extension the codec and the engine behave
 * as before; with one, its principal opens no stream and takes no further setup frame.
 */
import { describe, expect, it } from "bun:test";
import { MuxEngine } from "./relay-mux-engine.ts";
import { decodeFrame, encodeExtensionFrame, encodeFrame, FrameType, isExtensionFrame, MuxProtocolError } from "./relay-mux.ts";
import type { ExtensionFrame, MuxExtension, SessionError } from "./relay-mux.ts";

const testExtension: MuxExtension = {
  metadata: (type, input) => {
    if (type === FrameType.AUTH && input.scheme === "test-key") return { scheme: "test-key", id: String(input.id) };
    if (type === FrameType.AUTH_OK && input.role === "tester") return { role: "tester" };
    return undefined;
  },
  frame: (type, _flags, _id, payload) => type === 0x4e ? payload.length : undefined,
  encode: (frame) => new TextEncoder().encode(JSON.stringify(frame.payload)),
};
const raw = (type: number, payload: unknown, streamId = 0) => {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const bytes = new Uint8Array(8 + body.length);
  bytes[0] = 1; bytes[1] = type; new DataView(bytes.buffer).setUint32(4, streamId);
  bytes.set(body, 8);
  return bytes;
};
const codeOf = (run: () => unknown): SessionError | undefined => {
  try { run(); } catch (error) { if (error instanceof MuxProtocolError) return error.code; throw error; }
  return undefined;
};
const testAuth = raw(FrameType.AUTH, { scheme: "test-key", id: "a" });

describe("codec", () => {
  it("refuses an extension's frames when none is given, as before", () => {
    expect(codeOf(() => decodeFrame(testAuth))).toBe("protocol_error");
    expect(codeOf(() => decodeFrame(raw(0x4e, {})))).toBe("protocol_error");
    expect(codeOf(() => decodeFrame(raw(FrameType.AUTH_OK, { session_id: "0".repeat(32), device_id: "0".repeat(16), role: "tester" })))).toBe("protocol_error");
  });
  it("reads them with the extension, and leaves every other frame to the public codec", () => {
    expect(decodeFrame(testAuth, false, testExtension)).toEqual({ extension: true, type: FrameType.AUTH, flags: 0, stream_id: 0, payload: { scheme: "test-key", id: "a" } });
    expect(decodeFrame(raw(0x4e, {}), false, testExtension)).toMatchObject({ extension: true, type: 0x4e, payload: 2 });
    const device = { type: FrameType.AUTH, flags: 0, stream_id: 0, payload: { scheme: "device-key", device_id: "0123456789abcdef", signature: "A".repeat(86) } } as const;
    const decoded = decodeFrame(encodeFrame(device), false, testExtension);
    expect(isExtensionFrame(decoded)).toBe(false);
    expect(decoded).toEqual(device);
  });
  it("refuses what the extension does not read, and the envelope rules still hold", () => {
    expect(codeOf(() => decodeFrame(raw(0x4f, {}), false, testExtension))).toBe("protocol_error");
    expect(codeOf(() => decodeFrame(raw(FrameType.AUTH, { scheme: "other" }), false, testExtension))).toBe("protocol_error");
    expect(codeOf(() => decodeFrame(raw(FrameType.AUTH, { scheme: "test-key", id: "a" }, 1), false, testExtension))).toBe("protocol_error");
    expect(codeOf(() => decodeFrame(raw(FrameType.AUTH, { scheme: "test-key", pad: "p".repeat(1100) }), false, testExtension))).toBe("protocol_error");
  });
  it("encodes only what decodes as the extension's own", () => {
    const frame: ExtensionFrame = { extension: true, type: FrameType.AUTH, flags: 0, stream_id: 0, payload: { scheme: "test-key", id: "a" } };
    expect(encodeExtensionFrame(frame, testExtension)).toEqual(testAuth);
    expect(codeOf(() => encodeExtensionFrame({ ...frame, payload: { scheme: "device-key" } }, testExtension))).toBe("protocol_error");
  });
});

describe("engine", () => {
  function engine(role: "client" | "server", withExtension = true) {
    const closed: SessionError[] = [];
    const delivered: ExtensionFrame[] = [];
    const mux = new MuxEngine({
      role, send: async () => {}, close: () => {}, outboundWireByteLength: (bytes) => bytes.length, routingOverhead: 0, maxWireMessageBytes: 64 * 1024,
      clock: { now: () => 0, setTimeout: () => () => {} },
      ...(withExtension ? { extension: testExtension, onExtension: (frame: ExtensionFrame) => { delivered.push(frame); } } : {}),
      onClose: (error) => { closed.push(error.code); },
    });
    return { mux, closed, delivered };
  }
  const httpOpen = encodeFrame({ type: FrameType.HTTP_OPEN, flags: 0, stream_id: 1, payload: { device_id: "0123456789abcdef", method: "GET", target: "/", headers: [], body: "none" } });

  it("hands the extension's AUTH to the session adapter before sign-in", async () => {
    const server = engine("server");
    server.mux.receive(testAuth);
    await server.mux.flush();
    expect(server.delivered).toHaveLength(1);
    expect(server.closed).toEqual([]);
  });
  it("in the extension state admits no OPEN and no further setup frame", async () => {
    for (const bytes of [httpOpen, testAuth, encodeFrame({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", versions: [1], features: [], required_features: [] } })]) {
      const server = engine("server");
      server.mux.authenticateExtension("0123456789abcdef");
      server.mux.receive(bytes);
      await server.mux.flush();
      expect(server.closed).toEqual(["protocol_error"]);
    }
  });
  it("signs in once: neither state follows the other", () => {
    const server = engine("server");
    server.mux.authenticateExtension("0123456789abcdef");
    expect(() => server.mux.authenticate("0123456789abcdef")).toThrow("Invalid authentication transition");
    const device = engine("server");
    device.mux.authenticate("0123456789abcdef");
    expect(() => device.mux.authenticateExtension("0123456789abcdef")).toThrow("Invalid authentication transition");
  });
  it("lets no client in the extension state open a stream", () => {
    const client = engine("client");
    client.mux.authenticateExtension("0123456789abcdef");
    expect(() => client.mux.openHttp({ target: "/", method: "GET", headers: [], body: "none" })).toThrow("Cannot open a stream");
    expect(() => client.mux.openWs({ target: "/ws", headers: [], protocols: [] })).toThrow("Cannot open a stream");
  });
  it("without an extension refuses a type of 0x40-0x4f as before", async () => {
    const server = engine("server", false);
    server.mux.receive(raw(0x4e, {}));
    await server.mux.flush();
    expect(server.closed).toEqual(["protocol_error"]);
  });
});

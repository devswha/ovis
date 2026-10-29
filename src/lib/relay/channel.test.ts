import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeviceStore } from "../../../server/devices.ts";
import { exportPublicKey, generateKeyPair, openDaemonSecureChannel } from "../../../shared/relay-e2ee.ts";
import type { SecureChannel, Transport } from "../../../shared/relay-e2ee.ts";
import { decodeFrame, encodeFrame, FrameType, LIMITS_V1, MuxProtocolError } from "../../../shared/relay-mux.ts";
import type { MuxFrame } from "../../../shared/relay-mux.ts";
import { MuxEngine } from "../../../shared/relay-mux-engine.ts";
import { openRelayChannel } from "./channel.ts";
import type { RelaySocket } from "./channel.ts";
import { base64url, getDevice } from "./device.ts";
import { MemoryDeviceStore } from "./device.test.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

class FakeSocket implements RelaySocket {
  binaryType: BinaryType = "arraybuffer";
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  closed = false;
  constructor(readonly daemon: Transport) {}
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.closed) throw new Error("Socket closed");
    if (typeof data !== "string" && !(data instanceof ArrayBuffer)) throw new Error("Unexpected carrier type");
    this.daemon.onmessage?.({ data, isBinary: typeof data !== "string" });
  }
  deliver(data: string | ArrayBuffer): void {
    if (!this.closed) this.onmessage?.(new MessageEvent("message", { data }));
  }
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.daemon.onclose?.(code, reason);
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

async function fixture(pairing: boolean, attack?: "welcome" | "nonce" | "ping" | "auth-ok" | "features" | "assigned" | "receipt") {
  const dir = mkdtempSync(join(tmpdir(), "relay-channel-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const registry = new DeviceStore(dir);
  const keys = generateKeyPair();
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.example",
    ...(pairing ? { code: registry.startPairing().code } : {}) };
  const store = new MemoryDeviceStore();
  if (!pairing) {
    const device = await getDevice(offer, store);
    const paired = registry.pairRelay(registry.startPairing().code, device.label, device.public_spki);
    if (!paired) throw new Error("Fixture pairing failed");
    await store.update(offer.server_id, (current) => ({ ...(current ?? device), device_id: paired.device.id }));
  }
  const nonce = new Uint8Array(32).fill(9);
  const trace: string[] = [];
  const authSeen = Promise.withResolvers<void>();
  const allowAuth = Promise.withResolvers<void>();
  const httpSeen = Promise.withResolvers<string>();
  let secure: SecureChannel;
  let server: MuxEngine;
  let socket: FakeSocket;
  const daemon: Transport = {
    onmessage: null, onclose: null, onerror: null,
    send: (data) => socket.deliver(data),
    close: (code, reason) => socket.close(code, reason),
  };
  socket = new FakeSocket(daemon);
  cleanups.push(() => { server?.carrierLost(); socket.close(); });
  const fail = (error: unknown): void => {
    authSeen.reject(error);
    httpSeen.reject(error);
    socket.close(4000);
  };
  // These signals are also present in malformed-input cases that never reach admission.
  void authSeen.promise.catch(() => {});
  void httpSeen.promise.catch(() => {});
  let incoming = Promise.resolve();
  const daemonOpening = openDaemonSecureChannel(daemon, {
    daemonKeyPair: keys, minimumMode: "protected",
    events: { onmessage: (data) => {
      if (!(data instanceof ArrayBuffer)) throw new Error("Expected mux bytes");
      const bytes = new Uint8Array(data);
      const frame = decodeFrame(bytes);
      trace.push(`client:${Object.entries(FrameType).find(([, value]) => value === frame.type)?.[0]}`);
      incoming = incoming.then(async () => { await daemonOpening; server.receive(bytes); }).catch(fail);
    } },
  }).then((channel) => {
    secure = channel;
    server = new MuxEngine({
      role: "server", send: (bytes) => channel.send(bytes.slice().buffer),
      close: () => socket.close(4000),
      clock: { now: () => 0, setTimeout: () => () => {} },
      outboundWireByteLength: (bytes) => channel.outboundWireByteLength(bytes.slice().buffer),
      routingOverhead: 0, maxWireMessageBytes: 65536,
      onHttp: (stream) => { httpSeen.resolve(stream.request.target); stream.headers(200); stream.end(); },
      onSession: (frame) => { void handle(frame).catch(fail); },
    });
  });
  void daemonOpening.catch(() => {});
  const raw = (type: number, payload: unknown): Uint8Array => {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const bytes = new Uint8Array(8 + body.length);
    bytes[0] = 1; bytes[1] = type; bytes.set(body, 8);
    return bytes;
  };
  const handle = async (frame: MuxFrame): Promise<void> => {
    if (frame.type === FrameType.HELLO) {
      if (attack === "receipt") {
        await secure.send(encodeFrame({ type: FrameType.RECEIVED, flags: 0, stream_id: 0, payload: 99n }).slice().buffer);
        return;
      }
      if (attack === "ping") {
        await secure.send(encodeFrame({ type: FrameType.PING, flags: 0, stream_id: 0, payload: 1n }).slice().buffer);
        return;
      }
      if (attack === "auth-ok") {
        await secure.send(encodeFrame({ type: FrameType.AUTH_OK, flags: 0, stream_id: 0,
          payload: { device_id: "ab".repeat(8), session_id: "cd".repeat(16), role: "drive" } }).slice().buffer);
        return;
      }
      const welcome = { protocol: "ovis-mux" as const, version: 1 as const, features: attack === "features" ? ["unoffered"] : [],
        limits: { ...LIMITS_V1, max_streams: 2 }, nonce: attack === "nonce" ? base64url(nonce.slice(1)) : base64url(nonce),
        server_version: "test", relay_protocol: 1 as const, min_supported_client: "0.0.0" };
      trace.push("server:WELCOME");
      if (attack === "welcome" || attack === "nonce") {
        await secure.send(raw(FrameType.WELCOME, attack === "welcome" ? { ...welcome, protocol: "wrong" } : welcome).slice().buffer);
      } else {
        server.sendSession({ type: FrameType.WELCOME, flags: 0, stream_id: 0, payload: welcome });
      }
      return;
    }
    let deviceId: string;
    if (frame.type === FrameType.PAIR) {
      const paired = registry.pairRelay(frame.payload.code, frame.payload.label, frame.payload.public_key);
      if (!paired) throw new Error("Pairing rejected");
      deviceId = paired.device.id;
    } else if (frame.type === FrameType.AUTH) {
      const matched = await registry.matchRelay(frame.payload.device_id, nonce, frame.payload.signature, offer.server_id);
      if (!matched) throw new Error("Authentication rejected");
      deviceId = matched.id;
    } else throw new Error("Unexpected client setup frame");
    authSeen.resolve();
    await allowAuth.promise;
    trace.push("server:AUTH_OK");
    server.sendSession({ type: FrameType.AUTH_OK, flags: 0, stream_id: 0,
      payload: { session_id: "cd".repeat(16), device_id: deviceId, role: "drive" } });
    await server.flush();
    server.authenticate(deviceId);
  };
  const opening = openRelayChannel(offer, { store, socket: (url) => {
    expect(url).toBe(`${offer.relay}/v1/ws?server_id=${offer.server_id}&role=client&v=1`);
    queueMicrotask(() => socket.deliver(JSON.stringify(attack === "assigned" ? { type: "wrong" } : { type: "assigned", connection_id: "ef".repeat(16) })));
    return socket;
  } });
  return { opening, trace, authSeen, allowAuth, httpSeen, socket, store, offer };
}

for (const pairing of [false, true]) {
  it(`sends only HELLO and ${pairing ? "PAIR" : "AUTH"} until AUTH_OK through real Noise and mux`, async () => {
    // Given a real daemon, a real server mux and a relay-shaped in-memory socket.
    const f = await fixture(pairing);
    // When admission is deliberately held at its exact signal.
    await f.authSeen.promise;
    expect(f.trace).toEqual(["client:HELLO", "server:WELCOME", `client:${pairing ? "PAIR" : "AUTH"}`]);
    f.allowAuth.resolve();
    const channel = await f.opening;
    // Then admission persists the id and enables actual application streams.
    expect(channel.device.device_id).toBe((await f.store.get(f.offer.server_id))?.device_id ?? null);
    expect(channel.connectionId).toBe("ef".repeat(16));
    expect(channel.mux.limits.max_streams).toBe(2);
    expect(f.trace.slice(0, 4)).toEqual(["client:HELLO", "server:WELCOME", `client:${pairing ? "PAIR" : "AUTH"}`, "server:AUTH_OK"]);
    console.log(`ORDER: ${f.trace.slice(0, 4).join(" -> ")}; no other client frame before AUTH_OK`);
    channel.mux.openHttp({ method: "GET", target: "/api/test", headers: [], body: "none" });
    expect(await f.httpSeen.promise).toBe("/api/test");
    channel.close();
  });
}

for (const attack of ["welcome", "nonce", "ping", "auth-ok", "features", "assigned", "receipt"] as const) {
  it(`refuses malformed or unexpected ${attack} without sending credentials`, async () => {
    // Given an encrypted server that sends invalid setup traffic.
    const f = await fixture(false, attack);
    // When its invalid frame reaches the client.
    // Then setup rejects, closes, and sends neither AUTH nor automatic mux controls.
    await expect(f.opening).rejects.toBeInstanceOf(MuxProtocolError);
    expect(f.socket.closed).toBe(true);
    expect(f.trace.filter((entry) => entry.startsWith("client:"))).toEqual(attack === "assigned" ? [] : ["client:HELLO"]);
  });
}

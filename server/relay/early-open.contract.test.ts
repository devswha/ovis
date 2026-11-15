/**
 * early_open (todo 38): on a WELCOME that offers it, a phone with a saved device id sends HELLO, AUTH and its first
 * OPEN frames in one flight, and the PC answers AUTH_OK and the first request in one. The PC holds stream frames only
 * after a well-formed AUTH for a device it knows, at most EARLY_OPEN_FRAMES or EARLY_OPEN_BYTES of them, and runs them
 * only in the AUTH_OK commit. The phone and the PC from before early_open are server/relay/pre-early-open/.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import { exportPublicKey, generateKeyPair, openDaemonSecureChannel } from "../../shared/relay-e2ee.ts";
import type { SecureChannel, Transport } from "../../shared/relay-e2ee.ts";
import { openRelayChannel } from "../../shared/relay-channel.ts";
import type { RelayChannel, RelayChannelOptions, RelaySocket } from "../../shared/relay-channel.ts";
import type { RelayDevice, RelayDeviceStore } from "../../shared/relay-device.ts";
import { decodeFrame, encodeFrame, FrameType } from "../../shared/relay-mux.ts";
import type { MuxFrame } from "../../shared/relay-mux.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { handleRequest } from "../dispatch.ts";
import { machineConnection, machineKey, memoryDirectory, recordOf } from "../fleet/test-helpers.ts";
import { openRelayChannel as openOldChannel } from "./pre-early-open/relay-channel.ts";
import { RelaySession as OldRelaySession } from "./pre-early-open/session.ts";
import { RelaySession } from "./session.ts";
import type { RelaySessionOptions } from "./session.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openRelayTransport } from "../../src/lib/relay/transport.ts";
import { bounded, deferred, relayAccountFixture, relayConnection, relayDevice, relayFixture, TestClock } from "./test-helpers.ts";

const SERVER_ID = "0123456789abcdef0123456789abcdef";
type Device = Awaited<ReturnType<typeof relayDevice>>;
type Link = Awaited<ReturnType<typeof relayConnection>>;

const fixtures: ReturnType<typeof relayFixture>[] = [];
function fixture() {
  const value = relayFixture();
  fixtures.push(value);
  return value;
}
afterEach(() => { for (const item of fixtures.splice(0)) item.close(); });

/** The phone's saved key for the PC, as the hosted app keeps it once it paired. */
function savedStore(device: Device, offer: RelayOffer): RelayDeviceStore {
  let saved: RelayDevice | undefined = { server_id: offer.server_id, device_id: device.id, private_key: device.keys.privateKey,
    public_spki: device.publicKey, label: "Phone", server_public_key: offer.server_public_key, relay: offer.relay };
  return {
    get: async () => saved,
    update: async (_id, change) => (saved = change(saved)),
    list: async () => saved ? [saved] : [],
    remove: async () => { saved = undefined; },
  };
}

/**
 * One phone and one PC (`Session` on the fixture's services) on an in-memory carrier that keeps what each side sends
 * until the test delivers it: one delivery is one flight. With `auto`, everything is delivered as it is sent. What
 * the PC sends and receives is decoded, with the client flight each received frame came in.
 */
async function carrier(f: ReturnType<typeof relayFixture>, options: {
  Session?: new (options: RelaySessionOptions) => { receive(data: string | ArrayBuffer): void };
  session?: Partial<RelaySessionOptions>; auto?: boolean; keys?: ReturnType<typeof generateKeyPair>;
} = {}) {
  const keys = options.keys ?? generateKeyPair();
  const auto = options.auto ?? true;
  const offer: RelayOffer = { v: 1, server_id: SERVER_ID, server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.ovis.example" };
  const toPc: (string | ArrayBuffer)[] = [];
  const toPhone: (string | ArrayBuffer)[] = [];
  /** every client flight delivered, as it went */
  const delivered: (string | ArrayBuffer)[][] = [];
  const sent: MuxFrame[] = [];
  const received: { frame: MuxFrame; flight: number }[] = [];
  const watchers = new Set<() => void>();
  const closed = deferred<number>();
  let ended = false;
  let session: { receive(data: string | ArrayBuffer): void; mux?: unknown } | undefined;
  let socket: (RelaySocket & { readyState: number }) | undefined;
  const deliverPc = (): void => {
    const batch = toPc.splice(0);
    if (batch.length === 0) return;
    delivered.push(batch);
    for (const data of batch) daemon.onmessage?.({ data, isBinary: typeof data !== "string" });
    for (const watch of [...watchers]) watch();
  };
  const deliverPhone = (): void => { for (const data of toPhone.splice(0)) socket?.onmessage?.({ data } as MessageEvent); };
  let scheduled = false;
  const changed = (): void => {
    for (const watch of [...watchers]) watch();
    if (!auto || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      while (!ended && (toPc.length > 0 || toPhone.length > 0)) { deliverPc(); deliverPhone(); }
    });
  };
  const end = (code: number, reason: string): void => {
    if (ended) return;
    ended = true;
    closed.resolve(code);
    if (socket) socket.readyState = 2;
    // as a socket does: what was sent before the close arrives first, and the close in a later task
    deliverPhone();
    setImmediate(() => {
      if (socket) socket.readyState = 3;
      socket?.onclose?.({ code, reason } as CloseEvent);
      daemon.onclose?.(code, reason);
    });
  };
  const daemon: Transport = {
    send: (data) => { if (!ended) { toPhone.push(data); changed(); } },
    close: (code = 1000, reason = "") => end(code, reason),
    onmessage: null, onclose: null, onerror: null,
  };
  /** The PC's protected channel, with what it sends decoded on the way out. */
  const observed = (channel: SecureChannel): SecureChannel => new Proxy(channel, {
    get: (target, key) => {
      if (key === "send") return (data: string | ArrayBuffer) => {
        if (typeof data !== "string") { sent.push(decodeFrame(new Uint8Array(data))); changed(); }
        return target.send(data);
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const Session = options.Session ?? RelaySession;
  /** plaintext that came before the session existed: in memory a phone answers faster than any network carries it */
  const early: ArrayBuffer[] = [];
  void openDaemonSecureChannel(daemon, {
    daemonKeyPair: keys,
    events: {
      onmessage: (data) => {
        if (typeof data === "string") { session?.receive(data); return; }
        try { received.push({ frame: decodeFrame(new Uint8Array(data)), flight: delivered.length }); } catch { /* the PC's own codec answers it */ }
        if (session) session.receive(data);
        else early.push(data);
      },
    },
  }).then((channel) => {
    session = new Session({
      channel: observed(channel), services: f.app.context.services, port: f.app.port, serverId: SERVER_ID,
      serverVersion: "0.4.20", minSupportedClient: "0.4.20", routingOverhead: 0, maxWireMessageBytes: 64 * 1024, ...options.session,
    });
    for (const data of early.splice(0)) session.receive(data);
    changed();
  }, () => end(4000, "handshake failed"));
  f.closes.push(() => end(1000, "done"));
  const phoneSocket = (): RelaySocket => {
    const opened: RelaySocket & { readyState: number } = {
      binaryType: "arraybuffer", readyState: 1,
      send: (data) => { if (!ended) { toPc.push(data); changed(); } },
      close: (code = 1000, reason = "") => end(code, reason),
      onmessage: null, onclose: null, onerror: null,
    };
    socket = opened;
    toPhone.push(JSON.stringify({ type: "assigned", connection_id: randomBytes(16).toString("hex") }));
    changed();
    return opened;
  };
  return {
    offer, keys, sent, received, delivered, closed: closed.promise, socket: phoneSocket,
    /** The carrier is lost under both ends, as a dropped network would. */
    drop: () => end(1006, "dropped"),
    get session() { return session; },
    get flights() { return delivered.length; },
    queued: { pc: () => toPc.length, phone: () => toPhone.length },
    deliver: { pc: deliverPc, phone: deliverPhone },
    /** Resolves once `check` holds, re-checked on every send either way; bounded. */
    until(check: () => boolean): Promise<void> {
      if (check()) return Promise.resolve();
      const reached = deferred<void>();
      const watch = (): void => { if (check()) { watchers.delete(watch); reached.resolve(); } };
      watchers.add(watch);
      return bounded(reached.promise);
    },
    /** Sends what an earlier carrier's phone sent, as it was on the wire, in place of a phone. */
    replay(flight: (string | ArrayBuffer)[]) {
      toPc.push(...flight);
      deliverPc();
    },
    open(store: RelayDeviceStore, open: (offer: RelayOffer, options: RelayChannelOptions) => Promise<RelayChannel> = openRelayChannel, early = true) {
      return open(offer, { store, socket: phoneSocket, early });
    },
  };
}

const sentType = (type: number) => (frame: MuxFrame) => frame.type === type;
const openFrame = (deviceId: string, id: number, body: "none" | "stream" = "none"): Uint8Array => encodeFrame({
  type: FrameType.HTTP_OPEN, flags: 0, stream_id: id,
  payload: { device_id: deviceId, method: body === "none" ? "GET" : "POST", target: "/api/health", headers: [], body },
});

/** The request handler the PC would run, counting each call: a refusal must never reach it. */
function counted() {
  let calls = 0;
  return { dispatch: async () => { calls++; return new Response("{}"); }, get calls() { return calls; } };
}

/** Bytes the test phone sends as they are, each in the place of a PING its mux counts, so receipts stay in step. */
function rawSender(link: Link): (bytes: Uint8Array) => void {
  const replacements: Uint8Array[] = [];
  link.transformClientFrame = (bytes) => bytes[1] === FrameType.PING ? replacements.shift() ?? bytes : bytes;
  return (bytes) => {
    replacements.push(bytes);
    link.mux.enqueueControl({ type: FrameType.PING, flags: 0, stream_id: 0, payload: 0n });
  };
}

/** HELLO, then AUTH as `device` signed over `nonce` (this connection's WELCOME nonce unless another is given). */
async function sendAuth(link: Link, device: { id: string; keys: CryptoKeyPair }, nonce?: string): Promise<void> {
  const greeting = await link.hello();
  const signed = Buffer.concat([Buffer.from("ovis-relay-auth/1"), Buffer.from(nonce ?? greeting.nonce, "base64url"), Buffer.from(SERVER_ID)]);
  const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, device.keys.privateKey, signed)).toString("base64url");
  link.mux.sendSession({ type: FrameType.AUTH, flags: 0, stream_id: 0, payload: { scheme: "device-key", device_id: device.id, signature } });
}

/** Keeps the PC's signature check open until released: `verified` once the real check answered. */
function holdVerification(f: ReturnType<typeof relayFixture>) {
  const store = f.app.context.services.devices;
  const real = store.matchRelay.bind(store);
  const release = deferred<void>();
  const verified = deferred<void>();
  spyOn(store, "matchRelay").mockImplementation(async (...args: Parameters<typeof real>) => {
    const match = await real(...args);
    verified.resolve();
    await release.promise;
    return match;
  });
  return { release: () => release.resolve(), verified: verified.promise };
}

/** Bytes of a pipe frame a machine sends (server/fleet/vectors): `name` is the vector's case name. */
function pipeVector(name: string): Uint8Array {
  const folder = join(import.meta.dir, "..", "fleet", "vectors");
  for (const file of readdirSync(folder).filter((entry) => entry.endsWith(".json"))) {
    const found = (JSON.parse(readFileSync(join(folder, file), "utf8")) as { cases: { name: string; bytes?: string }[] }).cases.find((entry) => entry.name === name);
    if (found?.bytes) return Uint8Array.from(Buffer.from(found.bytes, "hex"));
  }
  throw new Error(`no vector ${name}`);
}

describe("a phone with a saved device id", () => {
  it("sends HELLO, AUTH and OPEN in one flight and gets AUTH_OK and its first answer in one", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    /** how many times the PC's engine had authenticated when each request ran */
    const order: number[] = [];
    let authenticate: { mock: { calls: unknown[] } } | undefined;
    const link = await carrier(f, { auto: false, session: { dispatch: (request, context) => { order.push(authenticate?.mock.calls.length ?? -1); return handleRequest(request, context); } } });
    const opening = link.open(savedStore(device, link.offer));
    await link.until(() => link.queued.phone() > 0);
    link.deliver.phone();
    // flight 1: the protected handshake; the PC answers it with a WELCOME that offers early_open
    await link.until(() => link.queued.pc() > 0);
    link.deliver.pc();
    await link.until(() => link.sent.some(sentType(FrameType.WELCOME)));
    const welcome = link.sent.find(sentType(FrameType.WELCOME));
    expect(welcome?.type === FrameType.WELCOME && welcome.payload.early_open).toBe(true);
    link.deliver.phone();
    // the channel is the phone's before the PC has even read its AUTH
    const channel = await bounded(opening);
    expect(link.received.some(({ frame }) => frame.type === FrameType.AUTH)).toBe(false);
    authenticate = spyOn(link.session?.mux as RelaySession["mux"], "authenticate");
    const stream = channel.mux.openHttp({ method: "GET", target: "/api/health", headers: [], body: "none" });
    const status = deferred<number>();
    stream.onHeaders = ({ status: code }) => status.resolve(code);
    await bounded(channel.mux.flush());
    // flight 2: HELLO, AUTH and OPEN together
    link.deliver.pc();
    expect(link.received.filter(({ flight }) => flight === 2).map(({ frame }) => frame.type))
      .toEqual(expect.arrayContaining([FrameType.HELLO, FrameType.AUTH, FrameType.HTTP_OPEN]));
    // the answer comes with no other flight from the phone: AUTH_OK first, then the request's headers
    await link.until(() => link.sent.some(sentType(FrameType.HTTP_HEADERS)));
    expect(link.flights).toBe(2);
    const types = link.sent.map((frame) => frame.type);
    expect(types.indexOf(FrameType.AUTH_OK)).toBeLessThan(types.indexOf(FrameType.HTTP_HEADERS));
    expect(order).toEqual([1]);
    link.deliver.phone();
    expect(await bounded(status.promise)).toBe(200);
    await bounded(channel.admitted ?? Promise.resolve());
    expect(channel.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(channel.role).toBe("drive");
    channel.close();
  });

  it("from before early_open ignores the offer and still signs in", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const link = await carrier(f);
    const channel = await bounded(link.open(savedStore(device, link.offer), openOldChannel));
    const welcome = link.sent.find(sentType(FrameType.WELCOME));
    expect(welcome?.type === FrameType.WELCOME && welcome.payload.early_open).toBe(true);
    expect(channel.device.device_id).toBe(device.id);
    const answered = deferred<number>();
    channel.mux.openHttp({ method: "GET", target: "/api/health", headers: [], body: "none" }).onHeaders = ({ status }) => answered.resolve(status);
    expect(await bounded(answered.promise)).toBe(200);
    channel.close();
  });

  it("signs in to a PC from before early_open as before: the channel is its own only after AUTH_OK", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const link = await carrier(f, { Session: OldRelaySession });
    const channel = await bounded(link.open(savedStore(device, link.offer)));
    expect(link.sent.some((frame) => frame.type === FrameType.WELCOME && frame.payload.early_open !== undefined)).toBe(false);
    expect(link.sent.some(sentType(FrameType.AUTH_OK))).toBe(true);
    expect(channel.sessionId).toMatch(/^[0-9a-f]{32}$/);
    const answered = deferred<number>();
    channel.mux.openHttp({ method: "GET", target: "/api/health", headers: [], body: "none" }).onHeaders = ({ status }) => answered.resolve(status);
    expect(await bounded(answered.promise)).toBe(200);
    // its request came after AUTH_OK reached the phone: never held
    const auth = link.received.find(({ frame }) => frame.type === FrameType.AUTH);
    const open = link.received.find(({ frame }) => frame.type === FrameType.HTTP_OPEN);
    expect(open?.flight ?? 0).toBeGreaterThan(auth?.flight ?? Infinity);
    channel.close();
  });

  it("that was removed is refused with auth_failed when it signed in early, never a lost carrier", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const link = await carrier(f);
    f.app.context.services.devices.revoke(device.id);
    const closed = deferred<Error>();
    const opened = await link.open(savedStore(device, link.offer), (offer, options) => openRelayChannel(offer, { ...options, onClose: (error) => closed.resolve(error) }))
      .then((channel) => { channel.mux.openHttp({ method: "GET", target: "/api/health", headers: [], body: "none" }); return channel; }, (error: unknown) => error as Error);
    const refusal = opened instanceof Error ? opened : await bounded(closed.promise);
    expect(refusal).toMatchObject({ code: "auth_failed" });
    if (!(opened instanceof Error)) expect(await (opened.admitted ?? Promise.resolve()).then(() => null, (error: unknown) => error)).toBe(refusal);
  });

  it("keeps within the bytes its PC holds before AUTH_OK, and every request is answered", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const check = holdVerification(f);
    const link = await carrier(f, { session: { dispatch: async () => new Response("{}") } });
    const channel = await bounded(link.open(savedStore(device, link.offer)));
    // 20 requests of about 16 KiB each: 320 KiB of OPEN frames, past the 256 KiB the PC holds
    const target = `/api/health?${"q".repeat(4000)}`;
    const statuses = Array.from({ length: 20 }, () => {
      const stream = channel.mux.openHttp({ method: "GET", target, headers: [["accept", "a".repeat(12_000)]], body: "none" });
      const status = deferred<number>();
      stream.onHeaders = ({ status: code }) => status.resolve(code);
      return status.promise;
    });
    await bounded(channel.mux.flush());
    await bounded(check.verified);
    const held = link.received.filter(({ frame }) => frame.stream_id !== 0);
    expect(held.length).toBeLessThan(20);
    expect(link.received.filter(({ frame }) => frame.type === FrameType.HTTP_OPEN).length).toBe(held.length);
    check.release();
    expect(await bounded(Promise.all(statuses))).toEqual(Array.from({ length: 20 }, () => 200));
    expect(link.sent.some(sentType(FrameType.SESSION_ERROR))).toBe(false);
    channel.close();
  });

  it("keeps within the frames its PC holds before AUTH_OK: requests opened and dropped do not end the session", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const check = holdVerification(f);
    const link = await carrier(f, { session: { dispatch: async () => new Response("{}") } });
    const channel = await bounded(link.open(savedStore(device, link.offer)));
    // two rounds of 16 requests opened and dropped (64 stream frames), then 4 more: 68 before AUTH_OK
    for (let round = 0; round < 2; round++) {
      const streams = Array.from({ length: 16 }, () => channel.mux.openHttp({ method: "GET", target: "/api/health", headers: [], body: "none" }));
      await bounded(channel.mux.flush());
      for (const stream of streams) stream.reset("cancelled");
    }
    // each of the last four settles: answered, or refused while the PC still retires the dropped ones
    const settled = Array.from({ length: 4 }, () => {
      const stream = channel.mux.openHttp({ method: "GET", target: "/api/health", headers: [], body: "none" });
      const outcome = deferred<string>();
      stream.onHeaders = ({ status }) => outcome.resolve(String(status));
      stream.onDispose = (error) => { if (error) outcome.resolve(error.code); };
      return outcome.promise;
    });
    await bounded(channel.mux.flush());
    await bounded(check.verified);
    expect(link.received.filter(({ frame }) => frame.stream_id !== 0).length).toBe(64);
    check.release();
    for (const outcome of await bounded(Promise.all(settled))) expect(["200", "refused"]).toContain(outcome);
    expect(link.received.filter(({ frame }) => frame.stream_id !== 0).length).toBe(68);
    expect(link.sent.some(sentType(FrameType.SESSION_ERROR))).toBe(false);
    expect(channel.mux.active).toBe(true);
    channel.close();
  });

  it("whose caller did not ask to sign in early waits for AUTH_OK, as before", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const link = await carrier(f);
    const channel = await bounded(link.open(savedStore(device, link.offer), openRelayChannel, false));
    expect(link.sent.some(sentType(FrameType.AUTH_OK))).toBe(true);
    expect(channel.sessionId).toMatch(/^[0-9a-f]{32}$/);
    channel.close();
  });

  it("is not offered early_open while a pairing window is open, and signs in as before", async () => {
    const f = fixture();
    f.app.context.services.relay.approvals.openWindow();
    const device = await relayDevice(f);
    const link = await carrier(f);
    const channel = await bounded(link.open(savedStore(device, link.offer)));
    expect(link.sent.some((frame) => frame.type === FrameType.WELCOME && frame.payload.early_open !== undefined)).toBe(false);
    expect(channel.sessionId).toMatch(/^[0-9a-f]{32}$/);
    channel.close();
  });
});

describe("before the PC verified AUTH", () => {
  it("holds nothing when its WELCOME offered no early_open: an OPEN behind AUTH is protocol_error", async () => {
    const f = fixture();
    f.app.context.services.relay.approvals.openWindow();
    const device = await relayDevice(f);
    const handler = counted();
    holdVerification(f);
    const link = await relayConnection(f, { dispatch: handler.dispatch });
    const send = rawSender(link);
    await sendAuth(link, device);
    expect((await link.welcome).payload.early_open).toBeUndefined();
    send(openFrame(device.id, 1));
    expect(await bounded(link.serverError)).toBe("protocol_error");
    expect(handler.calls).toBe(0);
  });

  it("reads a frame on stream 0 at once while it holds: a second HELLO is protocol_error before AUTH is checked", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const handler = counted();
    holdVerification(f);
    const link = await relayConnection(f, { dispatch: handler.dispatch });
    const send = rawSender(link);
    await sendAuth(link, device);
    send(openFrame(device.id, 1));
    send(encodeFrame({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", versions: [1], features: [], required_features: [] } }));
    expect(await bounded(link.serverError)).toBe("protocol_error");
    expect(handler.calls).toBe(0);
  });

  it("keeps nothing for an id with no row, so one an account pull admits meanwhile signs in again: auth_changed", async () => {
    const { fixture: f, member } = await relayAccountFixture();
    fixtures.push(f);
    const services = f.app.context.services;
    const realHas = services.devices.has.bind(services.devices);
    const realMatch = services.devices.matchRelay.bind(services.devices);
    let admitted = false;
    const pulled = deferred<void>();
    spyOn(services.devices, "has").mockImplementation((id: string) => id === member.id && !admitted ? false : realHas(id));
    spyOn(services.devices, "matchRelay").mockImplementation(async (...args: Parameters<typeof realMatch>) => admitted ? realMatch(...args) : null);
    spyOn(services.accountMailbox, "pullForRefusedSignIn").mockImplementation(async () => { await pulled.promise; admitted = true; });
    const handler = counted();
    const link = await relayConnection(f, { dispatch: handler.dispatch });
    const send = rawSender(link);
    await sendAuth(link, { id: member.id, keys: member.keys });
    send(openFrame(member.id, 1));
    await link.flush();
    pulled.resolve();
    expect(await bounded(link.serverError)).toBe("auth_changed");
    expect(handler.calls).toBe(0);
    expect(link.frames.some((frame) => frame.type === FrameType.AUTH_OK)).toBe(false);
  });

  it("on a fleet controller, holds no pipe frame from a device: it ends the session protocol_error", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const handler = counted();
    holdVerification(f);
    const link = await relayConnection(f, { dispatch: handler.dispatch, fleet: memoryDirectory([]) });
    const send = rawSender(link);
    await sendAuth(link, device);
    expect((await link.welcome).payload.early_open).toBe(true);
    send(pipeVector("pipe/data/largest"));
    expect(await bounded(link.serverError)).toBe("protocol_error");
    expect(handler.calls).toBe(0);
  });
  it("refuses an OPEN before AUTH with protocol_error, on a relay carrier and a direct one", async () => {
    for (const signInOnly of [false, true]) {
      const f = fixture();
      const device = await relayDevice(f);
      const handler = counted();
      const link = await relayConnection(f, { dispatch: handler.dispatch, signInOnly });
      const send = rawSender(link);
      await link.hello();
      send(openFrame(device.id, 1));
      expect(await bounded(link.serverError)).toBe("protocol_error");
      expect(handler.calls).toBe(0);
    }
  });

  it("refuses an OPEN for another device than the AUTH named with protocol_error", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const other = await relayDevice(f);
    const handler = counted();
    const check = holdVerification(f);
    const link = await relayConnection(f, { dispatch: handler.dispatch });
    const send = rawSender(link);
    await sendAuth(link, device);
    send(openFrame(other.id, 1));
    expect(await bounded(link.serverError)).toBe("protocol_error");
    check.release();
    expect(handler.calls).toBe(0);
    expect(link.frames.some((frame) => frame.type === FrameType.AUTH_OK)).toBe(false);
  });

  it(`holds at most 64 frames: the 65th ends the session with resource_exhausted`, async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const handler = counted();
    const check = holdVerification(f);
    const link = await relayConnection(f, { dispatch: handler.dispatch });
    const send = rawSender(link);
    await sendAuth(link, device);
    for (let index = 0; index < 64; index++) send(openFrame(device.id, 2 * index + 1));
    await link.flush();
    expect(link.frames.some((frame) => frame.type === FrameType.SESSION_ERROR)).toBe(false);
    expect(link.session.mux.active).toBe(true);
    send(openFrame(device.id, 129));
    expect(await bounded(link.serverError)).toBe("resource_exhausted");
    check.release();
    expect(handler.calls).toBe(0);
  });

  it("holds at most 256 KiB: past it the session ends with resource_exhausted", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const handler = counted();
    const check = holdVerification(f);
    const link = await relayConnection(f, { dispatch: handler.dispatch });
    const send = rawSender(link);
    await sendAuth(link, device);
    send(openFrame(device.id, 1, "stream"));
    const data = encodeFrame({ type: FrameType.HTTP_DATA, flags: 0, stream_id: 1, payload: new Uint8Array(16_376) });
    for (let index = 0; index < 15; index++) send(data);
    await link.flush();
    expect(link.session.mux.active).toBe(true);
    send(data);
    expect(await bounded(link.serverError)).toBe("resource_exhausted");
    check.release();
    expect(handler.calls).toBe(0);
  });

  it("drops what it held when the device is revoked while it verifies: auth_revoked, and nothing runs", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const handler = counted();
    const check = holdVerification(f);
    const link = await relayConnection(f, { dispatch: handler.dispatch });
    const authenticate = spyOn(link.session.mux, "authenticate");
    const send = rawSender(link);
    await sendAuth(link, device);
    send(openFrame(device.id, 1));
    await link.flush();
    await bounded(check.verified);
    f.app.context.services.devices.revoke(device.id);
    check.release();
    expect(await bounded(link.serverError)).toBe("auth_revoked");
    expect(handler.calls).toBe(0);
    expect(authenticate).not.toHaveBeenCalled();
    expect(link.frames.some((frame) => frame.type === FrameType.AUTH_OK)).toBe(false);
  });

  it("drops what it held when the signature does not hold: auth_failed, and nothing runs", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const handler = counted();
    const link = await relayConnection(f, { dispatch: handler.dispatch });
    const send = rawSender(link);
    await sendAuth(link, device, Buffer.alloc(32).toString("base64url"));
    send(openFrame(device.id, 1));
    expect(await bounded(link.serverError)).toBe("auth_failed");
    expect(handler.calls).toBe(0);
  });

  it("holds nothing for a device it does not know, and refuses it as ever: auth_failed", async () => {
    const f = fixture();
    const stranger = { id: randomBytes(8).toString("hex"), keys: await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) };
    const handler = counted();
    const check = holdVerification(f);
    const link = await relayConnection(f, { dispatch: handler.dispatch });
    const send = rawSender(link);
    await sendAuth(link, stranger);
    send(openFrame(stranger.id, 1));
    await link.flush();
    expect(link.session.mux.active).toBe(true);
    check.release();
    expect(await bounded(link.serverError)).toBe("auth_failed");
    expect(handler.calls).toBe(0);
  });
});

describe("a replayed first flight", () => {
  it("fails on a new connection, and what it would have opened dies with it", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const handler = counted();
    // the phone's whole first flight on one connection, as it went on the wire
    const first = await carrier(f, { session: { dispatch: handler.dispatch } });
    const channel = await bounded(first.open(savedStore(device, first.offer)));
    const answered = deferred<void>();
    channel.mux.openHttp({ method: "GET", target: "/api/health", headers: [], body: "none" }).onHeaders = () => answered.resolve();
    await bounded(answered.promise);
    expect(handler.calls).toBe(1);
    const wire = first.delivered.flat();
    // sent again to the same PC key on a new connection: Noise message 1 starts a handshake with a new PC ephemeral,
    // so nothing after it opens, and the PC reads no frame of it
    const again = await carrier(f, { keys: first.keys, session: { dispatch: handler.dispatch } });
    again.replay(wire);
    expect(await bounded(again.closed)).toBe(1011);
    expect(again.received).toEqual([]);
    expect(again.sent.some(sentType(FrameType.AUTH_OK))).toBe(false);
    // the same frames read in the clear on a new connection: its WELCOME nonce is another, so the AUTH fails
    const plain = await relayConnection(f, { dispatch: handler.dispatch });
    const send = rawSender(plain);
    const auth = first.received.find(({ frame }) => frame.type === FrameType.AUTH)?.frame;
    if (auth?.type !== FrameType.AUTH) throw new Error("no AUTH in the first flight");
    await plain.hello();
    send(encodeFrame(auth));
    send(openFrame(device.id, 1));
    expect(await bounded(plain.serverError)).toBe("auth_failed");
    expect(handler.calls).toBe(1);
    channel.close();
  });
});

describe("never held", () => {
  it("for a machine session, though its WELCOME said early_open: a stream or pipe frame before AUTH_OK ends it", async () => {
    const f = fixture();
    await relayDevice(f);
    const key = await machineKey();
    const fleet = memoryDirectory([recordOf(key)]);
    // the WELCOME goes out before HELLO says who is asking: a machine is offered what a phone is
    const before = await relayConnection(f, { fleet });
    expect((await before.welcome).payload).toMatchObject({ provisional: true, early_open: true });
    for (const frame of [openFrame("0123456789abcdef", 1), pipeVector("pipe/data/largest")]) {
      const machine = await machineConnection(f, fleet);
      await machine.hello();
      await machine.sendAuth(key);
      machine.sendBytes(frame);
      expect((await bounded(machine.error)).code).toBe("protocol_error");
      expect(machine.frames).not.toContain(FrameType.AUTH_OK);
    }
  });
});

describe("the app's relay transport", () => {
  it("sends a reconnect's first request with its AUTH, before the PC answered it", async () => {
    const f = fixture();
    const device = await relayDevice(f);
    const devices = f.app.context.services.devices;
    const realMatch = devices.matchRelay.bind(devices);
    let hold: ReturnType<typeof deferred<void>> | undefined;
    spyOn(devices, "matchRelay").mockImplementation(async (...args: Parameters<typeof realMatch>) => {
      const match = await realMatch(...args);
      await hold?.promise;
      return match;
    });
    const keys = generateKeyPair();
    const links: Awaited<ReturnType<typeof carrier>>[] = [];
    const offer = (await carrier(f, { keys })).offer;
    const store = savedStore(device, offer);
    const transport = await openRelayTransport(offer, {
      clock: new TestClock(), store,
      openChannel: async (channelOffer, options = {}) => {
        const link = await carrier(f, { keys, session: { dispatch: async () => new Response("{}") } });
        links.push(link);
        return openRelayChannel(channelOffer, { ...options, store, socket: link.socket });
      },
    });
    try {
      expect(links).toHaveLength(1);
      // the carrier drops; the reconnect's AUTH is held unanswered on the PC
      hold = deferred<void>();
      const down = deferred<void>();
      const unsubscribe = transport.onRouteChange(() => { if (transport.route === undefined) down.resolve(); });
      links[0]?.drop();
      await bounded(down.promise);
      unsubscribe();
      const up = deferred<void>();
      transport.onRouteChange(() => { if (transport.route !== undefined) up.resolve(); });
      void transport.connect();
      await bounded(up.promise);
      const response = transport.fetch("/api/health");
      const link = links[1];
      if (!link) throw new Error("no reconnect");
      await link.until(() => link.received.some(({ frame }) => frame.type === FrameType.HTTP_OPEN));
      expect(link.sent.some(sentType(FrameType.AUTH_OK))).toBe(false);
      hold.resolve();
      expect((await bounded(response)).status).toBe(200);
    } finally { transport.close(); }
  });
});

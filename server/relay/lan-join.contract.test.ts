/**
 * Joining from a phone on the same Wi-Fi (docs/relay.md, "Joining on the same Wi-Fi"): a comparison of digits over a
 * direct carrier, taken only while this PC's own window holds the LAN join window open, from a peer on this PC's own
 * network, one at a time and once per window, decided on this PC's own window alone, never while locked or strict, and
 * recorded as a pairing at this PC.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { channelBinding, exportPublicKey, generateKeyPair, openClientSecureChannel, openDaemonSecureChannel } from "../../shared/relay-e2ee.ts";
import type { KeyPair, SecureChannel, Transport } from "../../shared/relay-e2ee.ts";
import { decodeFrame, encodeFrame, FrameType, LIMITS_V1, PAIR_INTENT_PC, PAIR_SAS_FEATURE } from "../../shared/relay-mux.ts";
import type { MuxFrame } from "../../shared/relay-mux.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import type { RelayPairingRequest } from "../../shared/machines.ts";
import type { JournalEntry } from "../account/device-journal.ts";
import { loadRelayIdentity } from "./identity.ts";
import { DirectCarrier } from "./direct.ts";
import { lanJoinPeer, LanJoinWindow, LAN_JOIN_WINDOW_MS } from "./lan-join.ts";
import { handleRelayRequest } from "./routes.ts";
import { RelaySession } from "./session.ts";
import { bounded, deferred, relayFixture } from "./test-helpers.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announcement, asksFor, SERVICE_TYPE } from "./lan-advertise.ts";
import type { LanService } from "./lan-advertise.ts";
import { RelayService } from "./service.ts";
import { DirectCarrierUnusableError, openRelayChannel } from "../../shared/relay-channel.ts";
import type { RelayDevice, RelayDeviceStore } from "../../shared/relay-device.ts";
import { validateOffer } from "../../shared/relay-offer.ts";

type Fixture = ReturnType<typeof relayFixture>;
const fixtures: Fixture[] = [];
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const LAN_PHONE = "192.168.1.23";

function fixture(options: Parameters<typeof relayFixture>[1] = { accountOpensAll: false }): Fixture {
  const made = relayFixture(false, options);
  fixtures.push(made);
  return made;
}

function duplex(): [Transport, Transport] {
  const make = (): Transport & { peer?: Transport; closed: boolean } => ({
    onmessage: null, onclose: null, onerror: null, closed: false,
    async send(data) {
      if (this.closed || !this.peer) throw new Error("Closed test transport");
      this.peer.onmessage?.({ data, isBinary: typeof data !== "string" });
    },
    close(code = 1000, reason = "") {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.(code, reason);
      this.peer?.close(code, reason);
    },
  });
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

class Inbox {
  private readonly frames: MuxFrame[] = [];
  private waiter: ((frame: MuxFrame) => void) | undefined;
  push(data: string | ArrayBuffer): void {
    if (typeof data === "string") throw new Error("Unexpected plaintext string");
    const frame = decodeFrame(new Uint8Array(data));
    if (frame.type === FrameType.RECEIVED) return;
    if (this.waiter) { const resolve = this.waiter; this.waiter = undefined; resolve(frame); }
    else this.frames.push(frame);
  }
  next(): Promise<MuxFrame> {
    const queued = this.frames.shift();
    if (queued) return Promise.resolve(queued);
    const next = deferred<MuxFrame>();
    this.waiter = next.resolve;
    return bounded(next.promise);
  }
}

/** This PC's end of one carrier: a direct carrier's session (`signInOnly`), from `lanPeer` when that peer is on its network. */
async function pcEnd(f: Fixture, transport: Transport, keys: KeyPair, carrier: { signInOnly: boolean; lanPeer?: string }) {
  let session: RelaySession | undefined;
  const channel = openDaemonSecureChannel(transport, { daemonKeyPair: keys, events: { onmessage: (data) => session?.receive(data) } });
  return async () => {
    session = new RelaySession({
      channel: await channel, services: f.app.context.services, port: f.app.port,
      serverId: "0123456789abcdef0123456789abcdef", serverVersion: "0.5.11", minSupportedClient: "0.4.20",
      routingOverhead: 0, maxWireMessageBytes: 256 * 1024, ...carrier,
    });
    return session;
  };
}

async function phoneEnd(transport: Transport, serverKey: string) {
  const inbox = new Inbox();
  const opened = deferred<void>();
  const channel = await openClientSecureChannel(transport, {
    daemonPublicKeyB64: serverKey, events: { onopen: () => opened.resolve(), onmessage: (data) => inbox.push(data) },
  });
  await bounded(opened.promise);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  const send = (frame: MuxFrame) => channel.send(encodeFrame(frame).slice().buffer).catch(() => {});
  const binding = (): Uint8Array => { const made = channelBinding(channel); if (!made) throw new Error("No binding"); return made; };
  return {
    channel, inbox, publicKey, send, binding,
    /** `selected`: the PC is expected to select the comparison, so its final WELCOME follows a provisional one. */
    async hello(selected = true, features = [PAIR_SAS_FEATURE, PAIR_INTENT_PC]) {
      await send({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", versions: [1], features, required_features: [] } });
      let welcome = await inbox.next();
      if (welcome.type === FrameType.WELCOME && welcome.payload.provisional && selected) welcome = await inbox.next();
      if (welcome.type !== FrameType.WELCOME) throw new Error(`Expected WELCOME, got ${welcome.type}`);
      return welcome.payload;
    },
    /** Commit, take the challenge, reveal: the digits this phone shows. Throws when the PC ends it before its challenge. */
    async compare(): Promise<string> {
      const nonce = randomPairNonce();
      await send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
        payload: { label: "Wi-Fi phone", public_key: publicKey, commitment: toBase64Url(pairCommitment(binding(), publicKey, nonce)) } });
      const challenge = await inbox.next();
      if (challenge.type !== FrameType.PAIR_CHALLENGE) throw new Error(`Expected PAIR_CHALLENGE, got ${challenge.type === FrameType.SESSION_ERROR ? challenge.payload.code : challenge.type}`);
      await send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
      return pairDigits(binding(), publicKey, nonce, fromBase64Url(challenge.payload.nonce));
    },
    confirm: () => send({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } }),
    async ended(): Promise<string> {
      for (;;) {
        const frame = await inbox.next();
        if (frame.type === FrameType.SESSION_ERROR) return frame.payload.code;
      }
    },
  };
}

/** A phone on a direct carrier of this PC (or, with `relay`, on a relay data socket), its session opened. */
async function phoneOn(f: Fixture, carrier: { signInOnly: boolean; lanPeer?: string } = { signInOnly: true, lanPeer: LAN_PHONE }) {
  const keys = generateKeyPair();
  const [phoneSide, pcSide] = duplex();
  const start = await pcEnd(f, pcSide, keys, carrier);
  const phone = await phoneEnd(phoneSide, exportPublicKey(keys.publicKey));
  const session = await start();
  return { phone, session };
}

function prompts(f: Fixture, check: (list: RelayPairingRequest[]) => boolean): Promise<RelayPairingRequest[]> {
  const found = deferred<RelayPairingRequest[]>();
  const stop = f.app.context.services.relay.approvals.subscribe((list) => { if (check(list)) found.resolve(list); });
  return bounded(found.promise).finally(stop);
}

function everPrompted(f: Fixture): () => boolean {
  let seen = false;
  const stop = f.app.context.services.relay.approvals.subscribe((list) => { if (list.length > 0) seen = true; });
  cleanup.push(stop);
  return () => seen;
}

/** POST a relay control as this PC's own window (`own`) or another window of this PC (a token from elsewhere, a LAN visitor). */
function control(f: Fixture, path: string, own: boolean, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "x-herdr-update": "1", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return handleRelayRequest(request, path, f.app.context, null, own, own);
}

describe("the LAN join window", () => {
  it("is closed until this PC's own window opens it, and ends with the comparison it took", () => {
    let now = 1_000_000;
    let expire: (() => void) | undefined;
    const window = new LanJoinWindow({ now: () => now, setTimer: (run) => { expire = run; return () => { expire = undefined; }; } });
    expect(window.claim("a", () => {})).toBe(false);
    window.open();
    expect(window.claim("a", () => {})).toBe(true);
    // one pending at a time
    expect(window.claim("b", () => {})).toBe(false);
    window.finish("a");
    // a comparison that ended (approved, declined, expired or left) ends the window: no retry in it
    expect(window.claim("c", () => {})).toBe(false);
    window.open();
    now += LAN_JOIN_WINDOW_MS;
    expect(window.claim("d", () => {})).toBe(false);
    expire?.();
    expect(window.isOpen()).toBe(false);
  });

  it("ends what it was showing when the block is left", () => {
    const window = new LanJoinWindow();
    const id = window.open();
    let ended = 0;
    expect(window.claim("a", () => { ended += 1; })).toBe(true);
    window.close("another-window");
    expect(ended).toBe(0);
    window.close(id);
    expect(ended).toBe(1);
    expect(window.available()).toBe(false);
  });
});

describe("who may ask to join", () => {
  it("is a peer on a private network: RFC 1918, link-local, an IPv6 unique local or link-local address", () => {
    for (const address of ["192.168.1.23", "10.0.0.5", "172.16.4.1", "172.31.255.254", "169.254.10.1", "::ffff:192.168.0.9", "fd12:3456::1", "fe80::1%en0"]) {
      expect([address, lanJoinPeer(address)]).toEqual([address, true]);
    }
  });

  it("is never a public, loopback, carrier-grade NAT or tailnet address", () => {
    for (const address of ["8.8.8.8", "127.0.0.1", "::1", "100.101.102.103", "100.64.0.1", "fd7a:115c:a1e0::1234", "2001:db8::1", "172.32.0.1", "", undefined, null, "not-an-address"]) {
      expect([address, lanJoinPeer(address)]).toEqual([address, false]);
    }
  });
});

describe("a comparison on a direct carrier", () => {
  it("is refused before any prompt while no LAN join window is open", async () => {
    const f = fixture();
    const prompted = everPrompted(f);
    const { phone } = await phoneOn(f);
    // the PC selects no comparison for a phone it would refuse
    expect((await phone.hello(false)).features).not.toContain(PAIR_SAS_FEATURE);
    await phone.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "Wi-Fi phone", public_key: phone.publicKey, commitment: toBase64Url(new Uint8Array(32)) } });
    expect(await phone.ended()).toBe("auth_failed");
    expect(prompted()).toBe(false);
  });

  it("is refused from a peer that is not on this PC's network, a relay link included, while the window is open", async () => {
    const f = fixture();
    f.app.context.services.relay.lanJoin.open();
    const prompted = everPrompted(f);
    // a direct carrier whose peer is not a LAN one (public, tailnet, loopback): no lanPeer
    const direct = await phoneOn(f, { signInOnly: true });
    await direct.phone.hello(false);
    await direct.phone.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "Far phone", public_key: direct.phone.publicKey, commitment: toBase64Url(new Uint8Array(32)) } });
    expect(await direct.phone.ended()).toBe("auth_failed");
    // the relay: the LAN window is not the relay's pairing window
    const relayed = await phoneOn(f, { signInOnly: false });
    await relayed.phone.hello();
    await relayed.phone.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "Relay phone", public_key: relayed.phone.publicKey, commitment: toBase64Url(new Uint8Array(32)) } });
    expect(await relayed.phone.ended()).toBe("auth_failed");
    expect(prompted()).toBe(false);
    // and the window still takes the phone on the network
    expect(f.app.context.services.relay.lanJoin.available()).toBe(true);
  });

  it("takes one at a time: a second phone is refused while one waits, and none after the first ended", async () => {
    const f = fixture();
    f.app.context.services.relay.lanJoin.open();
    const first = await phoneOn(f);
    await first.phone.hello();
    const waiting = prompts(f, (list) => list.length === 1);
    await first.phone.compare();
    const [request] = await waiting;
    const second = await phoneOn(f, { signInOnly: true, lanPeer: "192.168.1.24" });
    await second.phone.hello(false);
    await expect(second.phone.compare()).rejects.toThrow("auth_failed");
    // declined: the window ends with it, so the second phone cannot try again in it
    expect((await control(f, "/api/relay/pairing", true, { id: request!.id, decision: "decline" })).status).toBe(200);
    expect(await first.phone.ended()).toBe("auth_failed");
    const third = await phoneOn(f, { signInOnly: true, lanPeer: "192.168.1.24" });
    await third.phone.hello(false);
    await expect(third.phone.compare()).rejects.toThrow("auth_failed");
    expect(f.app.context.services.relay.lanJoin.isOpen()).toBe(false);
  });

  it("ends what it showed when the block is left", async () => {
    const f = fixture();
    const id = f.app.context.services.relay.lanJoin.open();
    const { phone } = await phoneOn(f);
    await phone.hello();
    const waiting = prompts(f, (list) => list.length === 1);
    await phone.compare();
    await waiting;
    const gone = prompts(f, (list) => list.length === 0);
    expect((await control(f, "/api/relay/lan-join/close", true, undefined, { "x-ovis-window": id })).status).toBe(200);
    await gone;
    expect(await phone.ended()).toBe("auth_failed");
  });
});

describe("the digits", () => {
  it("are refused at the reveal when someone in the middle passes the phone's comparison on to this PC", async () => {
    const f = fixture();
    f.app.context.services.relay.lanJoin.open();
    const prompted = everPrompted(f);
    const pcKeys = generateKeyPair();
    const middleKeys = generateKeyPair();
    // phone <-> middle (the middle answers with its own key, as it would put its own in the offer) and middle <-> PC
    const [phoneSide, middleDaemon] = duplex();
    const [middleClient, pcSide] = duplex();
    const start = await pcEnd(f, pcSide, pcKeys, { signInOnly: true, lanPeer: LAN_PHONE });
    let toPc: SecureChannel | undefined;
    let toPhone: SecureChannel | undefined;
    const middleAsPc = openDaemonSecureChannel(middleDaemon, { daemonKeyPair: middleKeys, events: { onmessage: (data) => { void toPc?.send(data as ArrayBuffer).catch(() => {}); } } });
    const phone = await phoneEnd(phoneSide, exportPublicKey(middleKeys.publicKey));
    toPhone = await middleAsPc;
    const opened = deferred<void>();
    toPc = await openClientSecureChannel(middleClient, { daemonPublicKeyB64: exportPublicKey(pcKeys.publicKey),
      events: { onopen: () => opened.resolve(), onmessage: (data) => { void toPhone?.send(data as ArrayBuffer).catch(() => {}); } } });
    await bounded(opened.promise);
    await start();
    await phone.hello();
    await expect(phone.compare().then(() => phone.ended())).resolves.toBe("auth_failed");
    expect(prompted()).toBe(false);
  });

  it("differ between the two screens when someone in the middle runs a comparison of its own with each end", async () => {
    const f = fixture();
    f.app.context.services.relay.lanJoin.open();
    const pcKeys = generateKeyPair();
    const middleKeys = generateKeyPair();
    const [phoneSide, middleDaemon] = duplex();
    const [middleClient, pcSide] = duplex();
    const start = await pcEnd(f, pcSide, pcKeys, { signInOnly: true, lanPeer: LAN_PHONE });
    // the middle plays the PC to the phone: it reads the phone's frames and answers them itself
    const fromPhone = new Inbox();
    const middleAsPc = openDaemonSecureChannel(middleDaemon, { daemonKeyPair: middleKeys, events: { onmessage: (data) => fromPhone.push(data) } });
    const phone = await phoneEnd(phoneSide, exportPublicKey(middleKeys.publicKey));
    const toPhone = await middleAsPc;
    // and the phone to the PC, with a key and nonce of its own
    const middleAsPhone = await phoneEnd(middleClient, exportPublicKey(pcKeys.publicKey));
    await start();
    const pcPrompt = prompts(f, (list) => list.length === 1);
    await middleAsPhone.hello();
    await middleAsPhone.compare();
    const [shown] = await pcPrompt;
    const sendPhone = (frame: MuxFrame) => toPhone.send(encodeFrame(frame).slice().buffer);
    const hello = phone.send({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", versions: [1], features: [PAIR_SAS_FEATURE, PAIR_INTENT_PC], required_features: [] } });
    await fromPhone.next();
    await hello;
    await sendPhone({ type: FrameType.WELCOME, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", version: 1, features: [PAIR_SAS_FEATURE], limits: LIMITS_V1, nonce: toBase64Url(randomPairNonce()), server_version: "0.5.11", relay_protocol: 1, min_supported_client: "0.4.20" } });
    await phone.inbox.next();
    const phoneDigits = phone.compare();
    await fromPhone.next();
    await sendPhone({ type: FrameType.PAIR_CHALLENGE, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(randomPairNonce()) } });
    // the two screens are bound to two handshakes: they show the same digits once in a million tries
    expect(await phoneDigits).not.toBe(shown!.digits);
  });
});

describe("the approval", () => {
  async function waitingJoin(f: Fixture) {
    f.app.context.services.relay.lanJoin.open();
    const { phone } = await phoneOn(f);
    await phone.hello();
    const waiting = prompts(f, (list) => list.length === 1);
    const digits = await phone.compare();
    const [request] = await waiting;
    return { phone, digits, request: request! };
  }

  it("shows the phone's digits, label and address to this PC's own window alone", async () => {
    const f = fixture();
    const { digits, request } = await waitingJoin(f);
    expect(request).toMatchObject({ digits, label: "Wi-Fi phone", lan_address: LAN_PHONE });
    expect(request.local_only).toBeUndefined();
    expect(f.app.context.services.relay.approvals.list(undefined, false)).toEqual([]);
    const toOthers: RelayPairingRequest[][] = [];
    cleanup.push(f.app.context.services.relay.approvals.subscribe((list) => toOthers.push(list), false));
    expect(toOthers).toEqual([[]]);
    expect(f.app.context.services.relay.approvals.remoteList()).toEqual([]);
  });

  it("is refused (403) from any window but this PC's own", async () => {
    const f = fixture();
    const { request } = await waitingJoin(f);
    const answer = await control(f, "/api/relay/pairing", false, { id: request.id, decision: "approve" });
    expect([answer.status, (await answer.json() as { error: { code: string } }).error.code]).toEqual([403, "own_window_required"]);
    expect(f.app.context.services.relay.approvals.list()).toHaveLength(1);
    const opening = await control(f, "/api/relay/lan-join", false, {});
    expect(opening.status).toBe(403);
  });

  it("is refused while this PC is locked, and so is opening the window", async () => {
    const f = fixture();
    const { phone, request } = await waitingJoin(f);
    const state = { locked: true } as ReturnType<NonNullable<typeof f.app.context.services.safetyLog>["state"]>;
    const services = f.app.context.services as { safetyLog: unknown };
    const kept = services.safetyLog;
    services.safetyLog = { state: () => state };
    cleanup.push(() => { services.safetyLog = kept; });
    const answer = await control(f, "/api/relay/pairing", true, { id: request.id, decision: "approve" });
    expect([answer.status, (await answer.json() as { error: { code: string } }).error.code]).toEqual([403, "lan_join_locked"]);
    expect((await control(f, "/api/relay/lan-join", true, {})).status).toBe(403);
    // nothing new is taken while locked either
    await phone.confirm();
    f.app.context.services.relay.lanJoin.open();
    const other = await phoneOn(f, { signInOnly: true, lanPeer: "192.168.1.30" });
    expect((await other.phone.hello(false)).features).not.toContain(PAIR_SAS_FEATURE);
    await expect(other.phone.compare()).rejects.toThrow("auth_failed");
  });

  it("is refused while the PC's store fails closed (strict)", async () => {
    const f = fixture();
    const { request } = await waitingJoin(f);
    const devices = f.app.context.services.devices;
    Object.defineProperty(devices, "failsClosed", { configurable: true, get: () => true });
    cleanup.push(() => { delete (devices as { failsClosed?: boolean }).failsClosed; });
    const answer = await control(f, "/api/relay/pairing", true, { id: request.id, decision: "approve" });
    expect(answer.status).toBe(403);
    expect((await control(f, "/api/relay/lan-join", true, {})).status).toBe(403);
  });

  it("once both said the digits match, records a drive row paired at this PC, journalled and announced", async () => {
    const f = fixture({ accountOpensAll: true });
    const devices = f.app.context.services.devices;
    const notices: JournalEntry[] = [];
    cleanup.push(devices.onNotice((entry) => notices.push(entry)));
    const paired: string[] = [];
    cleanup.push(devices.onPaired((event) => paired.push(event.device_id)));
    const { phone, request } = await waitingJoin(f);
    expect((await control(f, "/api/relay/pairing", true, { id: request.id, decision: "approve" })).status).toBe(200);
    await phone.confirm();
    const admitted = await phone.inbox.next();
    expect(admitted.type).toBe(FrameType.AUTH_OK);
    const deviceId = admitted.type === FrameType.AUTH_OK ? admitted.payload.device_id : "";
    const row = devices.list(null).find((device) => device.id === deviceId);
    expect(row).toMatchObject({ label: "Wi-Fi phone", role: "drive", via_relay: true });
    expect(devices.originOf(deviceId)).toMatchObject({ from: "pc", how: "digits", by: null });
    expect(notices.find((entry) => entry.row === deviceId)).toMatchObject({ kind: "admit", how: "digits" });
    expect(paired).toContain(deviceId);
    // the window ended with its one join
    expect(f.app.context.services.relay.lanJoin.isOpen()).toBe(false);
  });
});

describe("the offer on the network", () => {
  async function carrier(f: Fixture, lanPeer: (address: string) => boolean) {
    const identity = loadRelayIdentity(f.stateDir);
    const direct = new DirectCarrier({ identity, services: f.app.context.services, port: f.app.port,
      addresses: () => ["127.0.0.1"], preferredPort: 0, peerAllowed: () => true, lanJoinPeer: lanPeer, relay: () => "wss://relay.ovis.example" });
    await direct.start();
    cleanup.push(() => direct.stop());
    return { identity, url: `http://127.0.0.1:${direct.port}/v1/offer`, socket: `ws://127.0.0.1:${direct.port}/v1/ws?v=1` };
  }

  function emptyStore(): RelayDeviceStore {
    let saved: RelayDevice | undefined;
    return { get: async () => saved, update: async (_id, change) => (saved = change(saved)), list: async () => saved ? [saved] : [], remove: async () => { saved = undefined; } };
  }

  it("pairs a phone that read it, over that carrier alone, once both said the digits match", async () => {
    const f = fixture();
    const near = await carrier(f, () => true);
    f.app.context.services.relay.lanJoin.open();
    const offer = validateOffer({ ...await (await fetch(near.url)).json() as object, lan: "ws://192.168.1.5:7319" });
    const waiting = prompts(f, (list) => list.length === 1);
    let shown = "";
    const opening = openRelayChannel(offer, { store: emptyStore(), socket: () => new WebSocket(near.socket), direct: offer.lan!, lanJoin: true, label: "Wi-Fi phone", compare: async (digits) => { shown = digits; } });
    const [request] = await waiting;
    expect(request).toMatchObject({ digits: shown, label: "Wi-Fi phone" });
    expect(f.app.context.services.relay.approvals.decide(request!.id, true)).toBe(true);
    const channel = await bounded(opening);
    expect(channel.device.device_id).toBeTruthy();
    expect(f.app.context.services.devices.list(null).some((device) => device.id === channel.device.device_id)).toBe(true);
    channel.close();
    // a client that did not say it joins on the LAN never pairs over a direct carrier
    await expect(openRelayChannel(offer, { store: emptyStore(), socket: () => new WebSocket(near.socket), direct: offer.lan!, compare: async () => {} })).rejects.toBeInstanceOf(DirectCarrierUnusableError);
  });

  it("is never taken with a code, or for a tailnet or public carrier", () => {
    const base = { v: 1, server_id: "0123456789abcdef0123456789abcdef", server_public_key: loadRelayIdentity(fixture().stateDir).public_key, relay: "wss://relay.ovis.example" };
    expect(validateOffer({ ...base, lan: "ws://10.0.0.2:7319" }).lan).toBe("ws://10.0.0.2:7319");
    for (const lan of ["ws://100.100.1.1:7319", "ws://8.8.8.8:7319", "wss://10.0.0.2:7319", 7]) expect(() => validateOffer({ ...base, lan })).toThrow("Invalid offer lan");
    expect(() => validateOffer({ ...base, lan: "ws://10.0.0.2:7319", code: "123456" })).toThrow("Invalid offer lan");
  });

  it("names this PC, its key and its relay only while a phone may join, and only to a peer on its network", async () => {
    const f = fixture();
    const near = await carrier(f, () => true);
    expect((await fetch(near.url)).status).toBe(404);
    f.app.context.services.relay.lanJoin.open();
    const answer = await fetch(near.url);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ v: 1, server_id: near.identity.server_id, server_public_key: near.identity.public_key, relay: "wss://relay.ovis.example" });
    // a browser page never reads it
    expect((await fetch(near.url, { headers: { origin: "http://evil.example" } })).status).toBe(404);
    const far = await carrier(f, () => false);
    expect((await fetch(far.url)).status).toBe(404);
  });
});

describe("telling phones on the network", () => {
  function idleSocket(): WebSocket {
    return Object.assign(new EventTarget(), { binaryType: "arraybuffer", readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onerror: null, onclose: null }) as unknown as WebSocket;
  }

  async function advertisingPc(addresses: readonly string[]) {
    const advertised: LanService[] = [];
    let stops = 0;
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-lan-join-"));
    const service = new RelayService({ stateDir, relay: "wss://relay.test", connect: () => idleSocket(),
      direct: { addresses: () => addresses, preferredPort: 0, peerAllowed: () => true, advertise: (port) => addresses.map(() => `ws://192.168.1.5:${port}`) },
      advertiseLan: (lan) => { advertised.push(lan); return () => { stops += 1; }; } });
    const f = fixture({ stateDir, relay: service });
    expect((await control(f, "/api/relay/start", true)).status).toBe(200);
    await service.setDirect(true);
    return { f, service, advertised, stops: () => stops };
  }

  it("advertises this PC's name and port only while the block is open, and takes it back when it is left", async () => {
    const { f, service, advertised, stops } = await advertisingPc(["127.0.0.1"]);
    cleanup.push(() => service.stop());
    expect(advertised).toEqual([]);
    const opened = await control(f, "/api/relay/lan-join", true, {});
    const body = await opened.json() as { address: string; window_id: string };
    expect(body.address).toMatch(/^192\.168\.1\.5:\d+$/);
    expect(advertised).toHaveLength(1);
    expect(Object.keys(advertised[0]!).sort()).toEqual(["addresses", "name", "port"]);
    expect(advertised[0]).toMatchObject({ port: Number(body.address.split(":")[1]), addresses: ["192.168.1.5"] });
    await control(f, "/api/relay/lan-join/close", true, undefined, { "x-ovis-window": body.window_id });
    expect(stops()).toBe(1);
    expect(advertised).toHaveLength(1);
  });

  it("says the Wi-Fi line is off, and advertises nothing, where this PC listens on no LAN address", async () => {
    const { f, service, advertised } = await advertisingPc([]);
    cleanup.push(() => service.stop());
    const opened = await control(f, "/api/relay/lan-join", true, {});
    expect(await opened.json()).toEqual({ address: null });
    expect(advertised).toEqual([]);
    expect(f.app.context.services.relay.lanJoin.isOpen()).toBe(false);
  });

  it("answers a query for _ovis._tcp with the name, port and addresses, and no secret", () => {
    const service: LanService = { name: "studio.pc", port: 7319, addresses: ["192.168.1.5"] };
    const query = Uint8Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 5, ...new TextEncoder().encode("_ovis"), 4, ...new TextEncoder().encode("_tcp"), 5, ...new TextEncoder().encode("local"), 0, 0, 12, 0, 1]);
    expect(asksFor(query, service, "ovis-1.local")).toBe(true);
    expect(asksFor(Uint8Array.from([...query.subarray(0, 2), 0x84, ...query.subarray(3)]), service, "ovis-1.local")).toBe(false);
    const answer = new TextDecoder("latin1").decode(announcement(service, "ovis-1.local"));
    expect(answer).toContain("studio-pc");
    expect(answer).toContain("_ovis");
    const identity = { server_id: "0123456789abcdef0123456789abcdef" };
    expect(answer).not.toContain(identity.server_id);
    expect(SERVICE_TYPE).toBe("_ovis._tcp.local");
  });
});

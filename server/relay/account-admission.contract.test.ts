/**
 * The shared client (shared/relay-channel.ts) signing in first by the account key on a PC it has nothing saved for, where
 * its caller vouches for the PC's identity (`trustedIdentity`; docs/account.md, "Account members"): through a local
 * relay (relay/bun.ts) to a real `createServer` with its relay on, whose mailbox is the in-memory account service. No
 * app passes the option yet; here the identity is the PC's own offer, which the test got from the PC itself. A device
 * the PC holds by a member's `add` is in at once; one it does not hold compares digits only once the PC refused it; an
 * offer whose key does not give its server_id is refused before any connection; without the account key, without the
 * option, with a code, on a direct carrier or with a pairing saved, the device opens the PC as before.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { startBunRelay } from "../../relay/bun.ts";
import { accountDeviceId, exportAccountKey, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import type { AccountRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { DirectCarrierUnusableError, openRelayChannel, UnsafeRelayDestinationError } from "../../shared/relay-channel.ts";
import type { RelayChannel, RelayChannelOptions, RelaySocket } from "../../shared/relay-channel.ts";
import type { RelayDevice, RelayDeviceStore } from "../../shared/relay-device.ts";
import { exportPublicKey, generateKeyPair, importPublicKey, openClientSecureChannel, openDaemonSecureChannel } from "../../shared/relay-e2ee.ts";
import type { KeyPair, Transport } from "../../shared/relay-e2ee.ts";
import { ACCOUNT_FEATURE, decodeFrame, FrameType, LIMITS_V1, PAIR_INTENT_ACCOUNT, PAIR_INTENT_PC, PAIR_INTENT_VOUCHED, RELAY_PROTOCOL } from "../../shared/relay-mux.ts";
import { MuxEngine } from "../../shared/relay-mux-engine.ts";
import type { SessionFrame } from "../../shared/relay-mux-engine.ts";
import { decodeOffer } from "../../shared/relay-offer.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { createServer } from "../index.ts";
import { RelayService } from "./service.ts";
import { RelaySession, relayClock } from "./session.ts";
import { bounded, deferred } from "./test-helpers.ts";

const ACCOUNT = "acct_1";
/** The relay the PC and its devices are told of; nothing listens there, both reach the local relay instead. */
const RELAY = "wss://relay.test";
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

interface AccountKey { readonly private_key: CryptoKey; readonly public_spki: string }
/** What an AUTH carries besides its scheme: the row it names and the signature over the PC's nonce. */
interface SignIn { readonly device_id: string; readonly signature: string }

async function accountKey(): Promise<AccountKey> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { private_key: keys.privateKey, public_spki: await exportAccountKey(keys.publicKey) };
}

/** A device's saved PCs, in memory, as the hosted app keeps them in IndexedDB. */
function memoryStore(): RelayDeviceStore {
  const saved = new Map<string, RelayDevice>();
  return {
    get: async (id) => saved.get(id),
    update: async (id, change) => { const next = change(saved.get(id)); saved.set(id, next); return next; },
    list: async () => [...saved.values()],
    remove: async (id) => { saved.delete(id); },
  };
}

/** One connection to the relay: the messages each way, the relay's own included. */
interface Wire { sent: number; received: number }

/** A POST over `channel`, as the app sends one through the relay. */
async function post(channel: RelayChannel, target: string, body: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
  const stream = channel.mux.openHttp({ target, method: "POST", headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]], body: "stream" });
  const answered = deferred<Response>();
  stream.onHeaders = ({ status }) => { if (status >= 200) answered.resolve(new Response(stream.noBody ? null : stream.body, { status })); };
  stream.onDispose = (error) => { if (error) answered.reject(error); };
  await stream.sendBody(new Response(JSON.stringify(body)).body ?? new ReadableStream());
  const response = await bounded(answered.promise);
  return { status: response.status, body: await response.json() };
}

/**
 * A PC with its relay on, listed in ACCOUNT's directory at the in-memory account service (which keeps a PC's mailbox only
 * for a PC its account lists), whose mailbox it reads. With `member`, the account's first device (A) paired with the
 * PC's code under its account key and linked its row: the PC is in the account and waits for A's enrollment (`enroll`),
 * as a PC a device just brought in does.
 */
async function accountPc(options: { readonly member: boolean }) {
  const service = new FakeAccountService();
  const token = service.issueToken(ACCOUNT);
  const relay = startBunRelay({ port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 } });
  cleanups.push(() => relay.stop());
  const local = (url: string): string => url.replace(RELAY, `ws://127.0.0.1:${relay.port}`);
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-account-admission-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const synced = deferred<void>();
  const relayService = new RelayService({ stateDir, relay: RELAY, regionalRelays: [], ovisRelays: [], connect: (url) => {
    const socket = new WebSocket(local(url));
    socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve(); });
    return socket;
  } });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false,
    relay: relayService, accountService: { url: "https://account.test", fetch: service.fetch } });
  cleanups.push(async () => { await relayService.shutdown(); app.stop(); });
  const base = `http://127.0.0.1:${app.port}`;
  const relayApi = (path: string) => fetch(`${base}/api/relay/${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
  expect((await relayApi("start")).status).toBe(200);
  await bounded(synced.promise);
  /** A fresh offer with a pairing code, as the PC's QR code carries one. */
  const coded = async (): Promise<RelayOffer> => {
    const offer = decodeOffer((await (await relayApi("offer")).json() as { url: string }).url);
    if (!offer) throw new Error("The PC made no offer");
    return offer;
  };
  const offer = await coded();
  // the PC's own offer, less its code: an identity the test holds from the PC itself, as the option's caller must hold one
  const { code: _code, ...own } = offer;
  const listing = await service.fetch(new Request(`https://account.test/v1/pcs/${offer.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "Desk", public_key: bytesToHex(importPublicKey(offer.server_public_key)), relay: RELAY }) }));
  expect(listing.status).toBe(200);
  /**
   * A device's socket to the relay; each connection's messages are counted in `wires`. With `dropAfter`, the relay drops
   * each connection once it carried that many messages to the device.
   */
  const connect = (wires: Wire[], dropAfter = Number.POSITIVE_INFINITY) => (url: string): RelaySocket => {
    const inner = new WebSocket(local(url));
    inner.binaryType = "arraybuffer";
    const wire: Wire = { sent: 0, received: 0 };
    wires.push(wire);
    const outer: RelaySocket = {
      binaryType: "arraybuffer",
      get readyState() { return inner.readyState; },
      send: (data) => { wire.sent++; inner.send(data); },
      close: (code, reason) => inner.close(code, reason),
      onmessage: null, onclose: null, onerror: null,
    };
    inner.onmessage = (event) => {
      if (wire.received >= dropAfter) { inner.close(4000, "dropped"); return; }
      wire.received++;
      outer.onmessage?.(event);
    };
    inner.onclose = (event) => outer.onclose?.(event);
    inner.onerror = (event) => outer.onerror?.(event);
    return outer;
  };
  const a = await accountKey();
  let member: RelayChannel | undefined;
  if (options.member) {
    const store = memoryStore();
    (await openRelayChannel(offer, { store, socket: connect([]), accountKey: a })).close();
    const signedIn = await openRelayChannel(own, { store, socket: connect([]) });
    cleanups.push(() => signedIn.close());
    const id = signedIn.device.device_id;
    if (id === null) throw new Error("A was not admitted");
    const link = await signAccountRecord({ v: 1, kind: "link", account: ACCOUNT, key: a.public_spki, server_id: offer.server_id, device_id: id,
      old_key: a.public_spki, issued_at: new Date().toISOString(), id: newRecordId(), signer: a.public_spki }, a.private_key);
    expect((await post(signedIn, "/api/account/link", { record: link })).status).toBe(200);
    member = signedIn;
  }
  const asMember = (): RelayChannel => {
    if (!member) throw new Error("This PC has no member");
    return member;
  };
  const approvals = app.context.services.relay.approvals;
  return {
    app, service, offer, own, coded,
    /** A's `add` for `key`, signed as a member adds a device it checked. */
    add: (key: string): Promise<AccountRecord> => signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key, label: "Second device", role: "drive",
      issued_at: new Date().toISOString(), id: newRecordId(), signer: a.public_spki }, a.private_key),
    /** The last part of A's enrollment, which ends the PC's wait for it. */
    enroll: (records: readonly AccountRecord[]) => post(asMember(), "/api/account/enroll", { account: ACCOUNT, records }),
    /** A record left in this PC's mailbox, as a member adding a device on another PC leaves one. */
    leave: (record: AccountRecord) => service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ server_ids: [offer.server_id], record }) })),
    /** What a device posts before it asks to join the account without a code: it waits at the PC with `key`. */
    admit: (key: string) => service.fetch(new Request("https://account.test/v1/admissions", { method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ server_id: offer.server_id, label: "Second device", key }) })),
    /** Once the PC asks nobody: no request for approval on its own screen or to its members. */
    quiet: (): Promise<void> => {
      const done = deferred<void>();
      const check = (): void => { if (approvals.list().length === 0 && approvals.remoteList().length === 0) done.resolve(); };
      const stops = [approvals.subscribe(check), approvals.subscribeRemote(check)];
      return bounded(done.promise).finally(() => { for (const stop of stops) stop(); });
    },
    /** A, through the relay, picks `digits` for the one request the PC shows its members. */
    approve: (digits: string) => {
      const [request] = approvals.remoteList();
      if (!request) throw new Error("Nothing waits for approval");
      return post(asMember(), "/api/relay/pairing", { id: request.id, decision: "approve", digits });
    },
    /**
     * Another end's own client to this PC through the relay, which never signs: it says HELLO, reads the nonce of the
     * PC's WELCOME and sends as its AUTH whatever it is handed. `answer`: what the PC made of that AUTH.
     */
    relaying: async () => {
      const socket = new WebSocket(local(`${RELAY}/v1/ws?server_id=${offer.server_id}&role=client&v=1`));
      socket.binaryType = "arraybuffer";
      cleanups.push(() => socket.close());
      const assigned = deferred<void>();
      const transport: Transport = { onmessage: null, onclose: null, onerror: null, send: (data) => { socket.send(data); }, close: (code, reason) => socket.close(code, reason) };
      let first = true;
      // the relay's assignment comes first; everything after it is the PC's
      socket.onmessage = (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (first) { first = false; assigned.resolve(); return; }
        if (typeof data === "string" || data instanceof ArrayBuffer) transport.onmessage?.({ data, isBinary: typeof data !== "string" });
      };
      socket.onclose = (event) => transport.onclose?.(event.code, event.reason);
      await bounded(assigned.promise);
      const welcome = deferred<string>();
      const answer = deferred<string>();
      let mux: MuxEngine | undefined;
      const channel = await bounded(openClientSecureChannel(transport, { daemonPublicKeyB64: offer.server_public_key, events: {
        onmessage: (data) => {
          if (typeof data === "string") return;
          const bytes = new Uint8Array(data);
          const frame = decodeFrame(bytes);
          if (frame.type === FrameType.SESSION_ERROR) answer.resolve(`refused ${frame.payload.code}`);
          mux?.receive(bytes);
        },
        onclose: () => mux?.carrierLost(),
      } }));
      const engine = new MuxEngine({
        role: "client", clock: relayClock, send: (bytes) => channel.send(bytes.slice().buffer), close: (code) => channel.close(code),
        outboundWireByteLength: (bytes) => channel.outboundWireByteLength(bytes.slice().buffer), routingOverhead: 0, maxWireMessageBytes: 64 * 1024,
        onSession: (frame) => {
          if (frame.type === FrameType.WELCOME) welcome.resolve(frame.payload.nonce);
          if (frame.type === FrameType.AUTH_OK) answer.resolve(`admitted as ${frame.payload.device_id} with ${frame.payload.role}`);
        },
      });
      mux = engine;
      engine.sendSession({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", versions: [1], features: [], required_features: [] } });
      return {
        nonce: await bounded(welcome.promise),
        auth: (signIn: SignIn) => engine.sendSession({ type: FrameType.AUTH, flags: 0, stream_id: 0, payload: { scheme: "device-key", ...signIn } }),
        answer: answer.promise,
      };
    },
    /**
     * B opens the PC with nothing saved for it: by the PC's own offer, less its code, unless another offer is given.
     * `timeline` is each connection it made and the first request for approval the PC raised, in order.
     */
    join: (joining: Partial<RelayChannelOptions> & { readonly offer?: RelayOffer; readonly compares?: boolean; readonly dropAfter?: number } = {}) => {
      const { offer: opened = own, compares = true, dropAfter, ...channelOptions } = joining;
      const store = joining.store ?? memoryStore();
      const timeline: string[] = [];
      const connectedAt: number[] = [];
      const wires: Wire[] = [];
      const digits = deferred<string>();
      const prompted = deferred<void>();
      const abort = new AbortController();
      const raised = (list: readonly unknown[]): void => {
        if (list.length === 0 || timeline.includes("prompt")) return;
        timeline.push("prompt");
        prompted.resolve();
      };
      const stops = [approvals.subscribe(raised), approvals.subscribeRemote(raised)];
      cleanups.push(() => { abort.abort(); for (const stop of stops) stop(); });
      const toRelay = connect(wires, dropAfter);
      const opening = openRelayChannel(opened, {
        store, signal: abort.signal, socket: (url) => { timeline.push("connect"); connectedAt.push(performance.now()); return toRelay(url); },
        ...(compares ? { compare: async (shown: string) => { digits.resolve(shown); } } : {}), ...channelOptions,
      });
      void opening.then((channel) => cleanups.push(() => channel.close()), () => undefined);
      return { store, timeline, connectedAt, wires, digits: digits.promise, prompted: prompted.promise, opening, abort };
    },
  };
}

/**
 * An end that holds `keys`, not the PC's, as a device that opens an offer naming the PC's server_id with another key meets
 * it: each connection gets the WELCOME nonce `nonce` gives (another connection's, to the real PC), and every AUTH that
 * comes in is handed to `onAuth`. It never answers AUTH_OK.
 */
function otherEnd(keys: KeyPair, nonce: Promise<string>, onAuth: (signIn: SignIn) => void): (url: string) => RelaySocket {
  return () => {
    let closed = false;
    const daemon: Transport = { onmessage: null, onclose: null, onerror: null, send: (data) => deliver(data), close: () => socket.close() };
    const socket: RelaySocket = {
      binaryType: "arraybuffer", onmessage: null, onclose: null, onerror: null,
      get readyState() { return closed ? 3 : 1; },
      send: (data) => { if (!closed) daemon.onmessage?.({ data, isBinary: typeof data !== "string" }); },
      close: () => {
        if (closed) return;
        closed = true;
        daemon.onclose?.(4000, "closed");
        socket.onclose?.(new CloseEvent("close", { code: 4000 }));
      },
    };
    const deliver = (data: string | ArrayBuffer): void => { if (!closed) socket.onmessage?.(new MessageEvent("message", { data })); };
    let mux: MuxEngine | undefined;
    let incoming: Promise<void> = Promise.resolve();
    const opening = openDaemonSecureChannel(daemon, { daemonKeyPair: keys, events: {
      onmessage: (data) => {
        if (typeof data === "string") return;
        const bytes = new Uint8Array(data);
        incoming = incoming.then(async () => { await opening; mux?.receive(bytes); }).catch(() => undefined);
      },
    } });
    void opening.then((channel) => {
      const engine = new MuxEngine({
        role: "server", send: (bytes) => channel.send(bytes.slice().buffer), close: () => socket.close(),
        clock: { now: () => 0, setTimeout: () => () => {} }, outboundWireByteLength: (bytes) => channel.outboundWireByteLength(bytes.slice().buffer),
        routingOverhead: 0, maxWireMessageBytes: 64 * 1024,
        onSession: (frame) => {
          if (frame.type === FrameType.HELLO) void nonce.then((shown) => engine.sendSession({ type: FrameType.WELCOME, flags: 0, stream_id: 0, payload: {
            protocol: "ovis-mux", version: 1, features: [], limits: { ...LIMITS_V1 }, nonce: shown, server_version: "other end", relay_protocol: RELAY_PROTOCOL, min_supported_client: "0.0.0" } }));
          if (frame.type === FrameType.AUTH) onAuth({ device_id: frame.payload.device_id, signature: frame.payload.signature });
        },
      });
      mux = engine;
    }, () => undefined);
    queueMicrotask(() => deliver(JSON.stringify({ type: "assigned", connection_id: "ef".repeat(16) })));
    return socket;
  };
}

/** Every PC of this test from now on reads each HELLO without the account features, as a PC from before them selects none. */
function olderPcs(): void {
  const descriptor = Object.getOwnPropertyDescriptor(RelaySession.prototype, "admit");
  const admit: unknown = descriptor?.value;
  if (!descriptor || typeof admit !== "function") throw new Error("RelaySession reads its session frames elsewhere");
  const dropped: readonly string[] = [ACCOUNT_FEATURE, PAIR_INTENT_PC, PAIR_INTENT_ACCOUNT, PAIR_INTENT_VOUCHED];
  Object.defineProperty(RelaySession.prototype, "admit", { configurable: true, writable: true, value(this: RelaySession, frame: SessionFrame) {
    const read = frame.type === FrameType.HELLO ? { ...frame, payload: { ...frame.payload, features: frame.payload.features.filter((feature) => !dropped.includes(feature)) } } : frame;
    return Reflect.apply(admit, this, [read]);
  } });
  cleanups.push(() => Object.defineProperty(RelaySession.prototype, "admit", descriptor));
}

const pulls = (service: FakeAccountService): number => service.requests.filter((request) => request === "POST /v1/pc/mailbox").length;

test("a device the PC holds by a member's add opens it with nothing saved: in at once, with nothing compared and nobody asked", async () => {
  const pc = await accountPc({ member: true });
  const b = await accountKey();
  expect(await pc.enroll([await pc.add(b.public_spki)])).toMatchObject({ status: 200, body: { results: [{ outcome: "applied" }] } });
  // as a device asks to join the account: its admission posted, and a comparison that asks to join, should it come to one
  await pc.admit(b.public_spki);
  const joining = pc.join({ accountKey: b, intent: "account", trustedIdentity: true });
  const first = await bounded(Promise.race([joining.opening.then(() => "admitted"), joining.digits.then((digits) => `asked to compare ${digits}`)]));
  expect(first).toBe("admitted");
  const channel = await joining.opening;
  const id = accountDeviceId(pc.offer.server_id, b.public_spki);
  expect([channel.role, channel.device.device_id]).toEqual(["drive", id]);
  expect(joining.timeline).toEqual(["connect"]);
  expect(pc.app.context.services.relay.approvals.remoteList()).toEqual([]);
  // kept as a pairing is kept: the key the PC admitted, under the id it named, for the relay it came through
  expect(await joining.store.get(pc.offer.server_id)).toMatchObject({ device_id: id, public_spki: b.public_spki, server_public_key: pc.offer.server_public_key, relay: RELAY });
}, 30_000);

test("a key the PC does not hold is refused, then compares digits exactly as without the option", async () => {
  /** B asks to join the account at a PC that does not hold its key, and a member approves: each step it went through. */
  const steps = async (trusted: boolean) => {
    const pc = await accountPc({ member: true });
    await pc.enroll([]);
    const b = await accountKey();
    await pc.admit(b.public_spki);
    const signIns = spyOn(pc.app.context.services.devices, "matchRelay");
    const joining = pc.join({ accountKey: b, intent: "account", ...(trusted ? { trustedIdentity: true } : {}) });
    const digits = await bounded(joining.digits);
    await bounded(joining.prompted);
    const [request] = pc.app.context.services.relay.approvals.remoteList();
    expect((await pc.approve(digits)).status).toBe(200);
    const channel = await bounded(joining.opening);
    const id = accountDeviceId(pc.offer.server_id, b.public_spki);
    return {
      timeline: joining.timeline,
      signedInFirst: signIns.mock.calls.some(([deviceId]) => deviceId === id),
      request: { label: request?.label, intent: request?.intent, key: request?.key === b.public_spki },
      admitted: { role: channel.role, id: channel.device.device_id === id, saved: (await joining.store.get(pc.offer.server_id))?.device_id === id },
    };
  };
  const before = await steps(false);
  expect(before).toEqual({ timeline: ["connect", "prompt"], signedInFirst: false, request: { label: "Device", intent: "account", key: true }, admitted: { role: "drive", id: true, saved: true } });
  // the refused sign-in raised no prompt: the one the member answered came on the connection after it
  expect(await steps(true)).toEqual({ ...before, timeline: ["connect", ...before.timeline], signedInFirst: true });
}, 60_000);

test("only the PC's refusal sends a first sign-in on to pair: a connection that ends any other way is the only one", async () => {
  const pc = await accountPc({ member: true });
  await pc.enroll([]);
  // the relay drops each connection once it carried its assignment and the PC's answer to the handshake
  const joining = pc.join({ accountKey: await accountKey(), intent: "account", trustedIdentity: true, dropAfter: 2 });
  await expect(joining.opening).rejects.toMatchObject({ code: "internal_error" });
  expect(joining.timeline).toEqual(["connect"]);
}, 30_000);

test("a first sign-in by the account key waits for the PC's AUTH_OK, also for a caller that signs in early", async () => {
  const pc = await accountPc({ member: true });
  const b = await accountKey();
  expect(await pc.enroll([await pc.add(b.public_spki)])).toMatchObject({ status: 200 });
  const channel = await bounded(pc.join({ accountKey: b, trustedIdentity: true, early: true }).opening);
  // handed over once AUTH_OK was read: what the PC said of the session is there at once
  expect({ session: /^[0-9a-f]{32}$/.test(channel.sessionId), role: channel.role }).toEqual({ session: true, role: "drive" });
}, 30_000);

test("an offer whose key does not give its server_id is refused before any connection: an end with another key gets no sign-in to pass on", async () => {
  const pc = await accountPc({ member: true });
  const b = await accountKey();
  expect(await pc.enroll([await pc.add(b.public_spki)])).toMatchObject({ status: 200 });
  // the other end's own client to the real PC: it holds that PC's nonce, and signs nothing itself
  const theirs = await pc.relaying();
  const signIns = spyOn(pc.app.context.services.devices, "matchRelay");
  const other = generateKeyPair();
  // the real PC's server_id with the other end's key and relay, as a forged link carries them
  const forged: RelayOffer = { ...pc.own, server_public_key: exportPublicKey(other.publicKey), relay: "wss://relay.other.example" };
  const reached = { connections: 0, auths: 0 };
  const end = otherEnd(other, Promise.resolve(theirs.nonce), (signIn) => { reached.auths++; theirs.auth(signIn); });
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  const opening = openRelayChannel(forged, { store: memoryStore(), accountKey: b, trustedIdentity: true, signal: abort.signal,
    socket: (url) => { reached.connections++; return end(url); } });
  const outcome = await bounded(Promise.race([
    opening.then(() => "opened", (error: unknown) => error instanceof UnsafeRelayDestinationError ? `refused before any connection: ${error.field}` : `ended: ${String(error)}`),
    theirs.answer.then((answer) => `the real PC ${answer}`),
  ]));
  expect({ outcome, ...reached, signInsAtTheRealPc: signIns.mock.calls.length })
    .toEqual({ outcome: "refused before any connection: server_id", connections: 0, auths: 0, signInsAtTheRealPc: 0 });
}, 30_000);

test("the PC's refusal of a first sign-in counts no failed pairing, asks nobody, and reads the mailbox once a minute at most", async () => {
  const pc = await accountPc({ member: true });
  await pc.enroll([]);
  const devices = pc.app.context.services.devices;
  // the enrollment's own pull, then a clean count: one more failure on a path would pause pairing there for ten minutes
  await pc.app.context.services.accountMailbox.settle();
  pc.service.requests.length = 0;
  for (const path of ["code", "account", "vouched"] as const) for (let failure = 0; failure < 19; failure++) devices.noteRelayFailure(path);
  const refused: { readonly ms: number; readonly wire: Wire | undefined }[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    // a caller with nothing to compare digits on: the connection after the refusal ends at the client, sending nothing to pair
    const joining = pc.join({ accountKey: await accountKey(), trustedIdentity: true, compares: false });
    await expect(joining.opening).rejects.toMatchObject({ code: "auth_failed" });
    expect(joining.timeline).toEqual(["connect", "connect"]);
    // from the refused sign-in's connection to the one after it
    const [first = 0, second = 0] = joining.connectedAt;
    refused.push({ ms: Math.round(second - first), wire: joining.wires[0] });
  }
  for (const path of ["code", "account", "vouched"] as const) expect(() => devices.assertRelayPairing(path)).not.toThrow();
  expect(pc.app.context.services.relay.approvals.list()).toEqual([]);
  expect(pc.app.context.services.relay.approvals.remoteList()).toEqual([]);
  // the first refusal read the mailbox; the two within the minute after it asked the account service nothing
  expect(pulls(pc.service)).toBe(1);
  console.log(`REFUSED_FIRST_SIGN_IN ${JSON.stringify(refused)} mailbox_pulls=${pulls(pc.service)}`);
}, 30_000);

test("without the account key, or without the option, a device opens the PC as before: one connection, no sign-in", async () => {
  const pc = await accountPc({ member: true });
  await pc.enroll([]);
  // the owner copied a link without a code: a comparison that pairs this PC only is taken
  pc.app.context.services.relay.approvals.openWindow();
  const signIns = spyOn(pc.app.context.services.devices, "matchRelay");
  const callers: readonly Partial<RelayChannelOptions>[] = [{ trustedIdentity: true }, { accountKey: await accountKey(), intent: "pc" }];
  for (const options of callers) {
    const joining = pc.join(options);
    await bounded(joining.digits);
    await bounded(joining.prompted);
    expect(joining.timeline).toEqual(["connect", "prompt"]);
    joining.abort.abort();
    await expect(joining.opening).rejects.toThrow();
    await pc.quiet();
  }
  expect(signIns).not.toHaveBeenCalled();
}, 30_000);

test("with a code, or with a pairing saved, a device opens the PC as before even with the option, on one connection", async () => {
  const pc = await accountPc({ member: true });
  await pc.enroll([]);
  const b = await accountKey();
  const store = memoryStore();
  const signIns = spyOn(pc.app.context.services.devices, "matchRelay");
  // a code pairs by its code, whatever the key; one the PC no longer takes is tried once, and never again under the key
  const spent = pc.join({ offer: pc.offer, accountKey: b, trustedIdentity: true });
  await expect(spent.opening).rejects.toMatchObject({ code: "auth_failed" });
  expect(spent.timeline).toEqual(["connect"]);
  const coded = pc.join({ offer: await pc.coded(), store, accountKey: b, trustedIdentity: true });
  const paired = await bounded(coded.opening);
  expect(coded.timeline).toEqual(["connect"]);
  expect(signIns).not.toHaveBeenCalled();
  paired.close();
  // the pairing that code saved signs in by its own id, which is not the one an add gives
  const saved = paired.device.device_id;
  if (saved === null) throw new Error("The code saved no pairing");
  expect(saved).not.toBe(accountDeviceId(pc.offer.server_id, b.public_spki));
  const again = pc.join({ store, accountKey: b, trustedIdentity: true });
  expect((await bounded(again.opening)).device.device_id).toBe(saved);
  expect(again.timeline).toEqual(["connect"]);
  expect(new Set(signIns.mock.calls.map(([deviceId]) => deviceId))).toEqual(new Set([saved]));
}, 30_000);

test("a direct carrier still refuses a device with nothing saved before any connection, with the option too", async () => {
  const keys = generateKeyPair();
  const offer: RelayOffer = { v: 1, server_id: deriveServerId(keys.publicKey), server_public_key: exportPublicKey(keys.publicKey), relay: RELAY };
  let connections = 0;
  const opening = openRelayChannel(offer, { store: memoryStore(), accountKey: await accountKey(), trustedIdentity: true, direct: "ws://192.168.1.20:7319",
    socket: () => { connections++; throw new Error("No connection may open"); } });
  await expect(opening).rejects.toBeInstanceOf(DirectCarrierUnusableError);
  expect(connections).toBe(0);
});

test("an older PC, which selects none of the account features, refuses the sign-in at once and then compares digits as before", async () => {
  const pc = await accountPc({ member: false });
  pc.app.context.services.relay.approvals.openWindow();
  olderPcs();
  const timelines: string[][] = [];
  for (const trusted of [true, false]) {
    const joining = pc.join({ accountKey: await accountKey(), intent: "account", ...(trusted ? { trustedIdentity: true } : {}) });
    await bounded(joining.digits);
    await bounded(joining.prompted);
    timelines.push(joining.timeline);
    joining.abort.abort();
    await expect(joining.opening).rejects.toThrow();
    await pc.quiet();
  }
  // with the option, one connection more; then the same comparison, which this PC shows its owner as one for itself alone
  expect(timelines).toEqual([["connect", "connect", "prompt"], ["connect", "prompt"]]);
  // a PC in no account reads no mailbox for a sign-in it refuses
  expect(pulls(pc.service)).toBe(0);
}, 30_000);

test("on a PC still enrolling, the add held back, a first sign-in by the account key is refused and compares digits; once the add applies it is in", async () => {
  const pc = await accountPc({ member: true });
  const b = await accountKey();
  // A added B on another PC: the add reaches this one by its mailbox, while this PC still waits for A's enrollment
  expect((await pc.leave(await pc.add(b.public_spki))).status).toBe(200);
  await pc.admit(b.public_spki);
  const waiting = pc.join({ accountKey: b, intent: "account", trustedIdentity: true });
  await bounded(waiting.digits);
  await bounded(waiting.prompted);
  // the person gives up on the comparison: the open ends there, with no connection after it
  waiting.abort.abort();
  await expect(waiting.opening).rejects.toThrow();
  expect(waiting.timeline).toEqual(["connect", "connect", "prompt"]);
  expect(pc.app.context.services.devices.hasKey(b.public_spki)).toBe(false);
  // A's enrollment ends: the add the PC read and held back applies, and B is in with nothing compared
  expect((await pc.enroll([])).status).toBe(200);
  const joining = pc.join({ accountKey: b, intent: "account", trustedIdentity: true });
  expect((await bounded(joining.opening)).device.device_id).toBe(accountDeviceId(pc.offer.server_id, b.public_spki));
  expect(joining.timeline).toEqual(["connect"]);
}, 30_000);

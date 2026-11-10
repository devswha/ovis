import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../../relay/bun.ts";
import { passPolicy } from "../../relay/pass.ts";
import { openClientSecureChannel } from "../../shared/relay-e2ee.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import { decodeOffer } from "../../shared/relay-offer.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { MuxEngine } from "../../shared/relay-mux-engine.ts";
import type { SessionFrame } from "../../shared/relay-mux-engine.ts";
import { decodeFrame, FrameType } from "../../shared/relay-mux.ts";
import type { SessionError } from "../../shared/relay-mux.ts";
import { RELAY_NEW_SESSIONS_CLOSE, RELAY_NEW_SESSIONS_REFUSED, signRelayPass } from "../../shared/relay-pass.ts";
import { proofKey, serverChallenge, verifyServerProof } from "../../shared/relay-server-proof.ts";
import { createServer } from "../index.ts";
import { RelayService } from "./service.ts";
import { relayClock } from "./session.ts";
import { bounded, deferred } from "./test-helpers.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const KID = "0badc0de";
type Mode = "off" | "grace" | "enforce";

/**
 * A Bun relay with passes in `mode`, an account service that signs this PC the pass `signing` says, and a PC on both.
 * `enforceAt` is the relay's RELAY_PASS_ENFORCE_AT: far ahead unless the test names one.
 */
async function fixture(mode: Mode, newSessions: boolean | undefined, enforceAt = "2099-01-01T00:00:00Z") {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pass = await passPolicy({ RELAY_PASS_MODE: mode, RELAY_PASS_ENFORCE_AT: enforceAt, RELAY_PASS_KEYS: `${KID}:${Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("")}` });
  const allow = { async limit() { return { success: true }; } };
  const relay = startBunRelay({ port: 0, pass, limiters: { perAddress: allow, global: allow } });
  cleanup.push(() => relay.stop());
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-new-session-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const origin = `wss://127.0.0.1:${relay.port}`;
  const challenges = new Map<string, string>();
  /** what the passes the service signs say of new client sessions (undefined: a v1 pass) */
  const signing: { newSessions: boolean | undefined } = { newSessions };
  /** each pass is issued a second after the one before, so the relay takes the latest as the one that decides */
  let issued = 0;
  const accountFetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const body = await request.json() as Record<string, string>;
    if (path === "/v1/pc/challenge") {
      const id = crypto.randomUUID().replace(/-/g, "");
      const { expected, frame } = serverChallenge(proofKey(body["public_key"])!, { server_id: body["server_id"]!, role: "account", connection_id: id });
      challenges.set(id, expected);
      return Response.json({ challenge_id: id, frame });
    }
    const expected = challenges.get(body["challenge_id"] ?? "");
    challenges.delete(body["challenge_id"] ?? "");
    if (!expected || !verifyServerProof(body["proof"], expected)) return Response.json({ error: { code: "proof_invalid" } }, { status: 401 });
    if (body["account"] !== "acct_1") return Response.json({ error: { code: "not_listed" } }, { status: 403 });
    const options = signing.newSessions === undefined ? {} : { newSessions: signing.newSessions };
    return Response.json({ pass: await signRelayPass(pair.privateKey, KID, body["server_id"]!, Math.floor(Date.now() / 1000) + issued++, undefined, options), expires_in: 172_800, refresh_in: 43_200 });
  };
  /** what the PC sent on its control sockets after the proof, and who waits for one of them */
  const sentOnControl: string[] = [];
  const awaited: { check: (frame: string) => boolean; resolve: () => void }[] = [];
  const syncs: { connection_ids: string[] }[] = [];
  let synced = deferred<void>();
  const controls: WebSocket[] = [];
  const connect = (url: string, extra?: Record<string, string>) => {
    const target = new URL(url);
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`, (extra ? { headers: extra } : undefined) as unknown as string[]);
    if (!target.searchParams.has("connection_id") && !target.searchParams.has("warm")) {
      controls.push(socket);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          sentOnControl.push(data);
          for (const waiter of awaited.splice(0)) { if (waiter.check(data)) waiter.resolve(); else awaited.push(waiter); }
        }
        send(data);
      };
      socket.addEventListener("message", (event) => {
        const value = typeof event.data === "string" ? JSON.parse(event.data) as { type?: string; connection_ids?: string[] } : null;
        if (value?.type === "sync") { syncs.push({ connection_ids: value.connection_ids ?? [] }); synced.resolve(); }
      });
    }
    return socket;
  };
  // the retry after a lost control socket comes at its soonest (0.8 s), with no jitter
  const service = new RelayService({ stateDir, relay: origin, regionalRelays: [], connect, random: () => 0, accountService: "https://account.test", accountFetch, ovisRelays: [origin], pairCodeRelay: origin });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, relay: service });
  cleanup.push(async () => { await service.shutdown(); app.stop(); });
  const base = `http://127.0.0.1:${app.port}`;
  const nameAccount = async (account: string) => {
    const response = await fetch(`${base}/api/account/relay-account`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ account }) });
    expect(response.status).toBe(204);
  };
  /** The next frame the PC sends on a control socket that `check` takes. */
  const sent = (check: (frame: string) => boolean) => {
    const done = deferred<void>();
    awaited.push({ check, resolve: () => done.resolve() });
    return bounded(done.promise);
  };
  await nameAccount("acct_1");
  expect((await fetch(`${base}/api/relay/start`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } })).status).toBe(200);
  await bounded(synced.promise);
  return {
    relayPort: relay.port, app, service, sentOnControl, syncs, signing, controls, sent,
    get synced() { return bounded(synced.promise); },
    expectSync() { synced = deferred<void>(); },
    newSessionFrames: () => sentOnControl.filter((frame) => frame.includes('"new_session"')),
    async offer(): Promise<RelayOffer> {
      const response = await fetch(`${base}/api/relay/offer`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
      expect(response.status).toBe(200);
      const offer = decodeOffer((await response.json() as { url: string }).url);
      if (!offer) throw new Error("Offer missing");
      return offer;
    },
    /** Has the PC ask for its pass again, as the service signs it now, and waits until it reached the relay. */
    async renew(next: boolean | undefined) {
      signing.newSessions = next;
      const renewed = sent((frame) => frame.includes('"relay_pass"'));
      // another account (which does not list this PC), then back: the PC asks again
      await nameAccount("acct_2");
      await nameAccount("acct_1");
      await renewed;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A phone on the relay: the protected handshake and HELLO, then PAIR with `code`, or AUTH as `device`, or nothing
 * (`squat`). Each promise settles only when that thing happens.
 */
async function phone(f: Fixture, offer: RelayOffer, step: { code: string } | { device: { id: string; keys: CryptoKeyPair } } | "squat") {
  const socket = new WebSocket(`ws://127.0.0.1:${f.relayPort}/v1/ws?server_id=${offer.server_id}&role=client&v=1`);
  socket.binaryType = "arraybuffer";
  const assigned = deferred<string>();
  const closed = deferred<{ code: number; reason: string }>();
  const transport: Transport = {
    onmessage: null, onclose: null, onerror: null,
    send: (data) => { socket.send(data); }, close: (code, reason) => socket.close(code, reason),
  };
  /** the relay's own word to this client (`assigned`): all a client that knows the server_id alone hears from it */
  const fromRelay: string[] = [];
  socket.onmessage = (event) => {
    if (typeof event.data === "string" && event.data.includes('"assigned"')) {
      fromRelay.push(event.data);
      assigned.resolve((JSON.parse(event.data) as { connection_id: string }).connection_id);
      return;
    }
    transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
  };
  socket.onclose = (event) => { transport.onclose?.(event.code, event.reason); closed.resolve({ code: event.code, reason: event.reason }); };
  socket.onerror = () => transport.onerror?.(new Error("Test client connection failed"));
  cleanup.push(() => socket.close());
  const connectionId = await bounded(assigned.promise);
  const welcome = deferred<Extract<SessionFrame, { type: typeof FrameType.WELCOME }>>();
  const admitted = deferred<{ device_id: string }>();
  const error = deferred<SessionError>();
  let mux: MuxEngine | undefined;
  const channel = await bounded(openClientSecureChannel(transport, {
    daemonPublicKeyB64: offer.server_public_key,
    events: {
      onmessage: (data) => {
        if (typeof data === "string") throw new Error("Unencrypted application message");
        const frame = decodeFrame(new Uint8Array(data));
        if (frame.type === FrameType.SESSION_ERROR) error.resolve(frame.payload.code);
        mux?.receive(new Uint8Array(data));
      },
      onclose: () => mux?.carrierLost(),
    },
  }));
  mux = new MuxEngine({
    role: "client", clock: relayClock, send: (bytes) => channel.send(bytes.slice().buffer),
    close: (code) => channel.close(code), outboundWireByteLength: (bytes) => channel.outboundWireByteLength(bytes.slice().buffer),
    routingOverhead: 0, maxWireMessageBytes: 64 * 1024,
    onSession: (frame) => {
      if (frame.type === FrameType.WELCOME) welcome.resolve(frame);
      if (frame.type === FrameType.AUTH_OK) { mux?.authenticate(frame.payload.device_id); admitted.resolve(frame.payload); }
    },
  });
  const engine = mux;
  engine.sendSession({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", versions: [1], features: [], required_features: [] } });
  const greeting = (await bounded(welcome.promise)).payload;
  const keys = typeof step === "object" && "device" in step ? step.device.keys
    : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  if (typeof step === "object" && "code" in step) {
    engine.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0,
      payload: { code: step.code, label: "New phone", public_key: Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url") } });
  } else if (typeof step === "object") {
    const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey,
      Buffer.concat([Buffer.from("ovis-relay-auth/1"), Buffer.from(greeting.nonce, "base64url"), Buffer.from(offer.server_id)]))).toString("base64url");
    engine.sendSession({ type: FrameType.AUTH, flags: 0, stream_id: 0, payload: { scheme: "device-key", device_id: step.device.id, signature } });
  }
  return {
    connectionId, keys, fromRelay, socket,
    closed: bounded(closed.promise), error: bounded(error.promise),
    admitted: bounded(admitted.promise).then((principal) => ({ id: principal.device_id, keys })),
    /** Whichever comes first: admission, a session error, or the socket's close. */
    outcome: () => bounded(Promise.race([
      admitted.promise.then(() => "admitted" as const), error.promise, closed.promise.then((event) => event.code),
    ])),
  };
}

const deviceCount = (f: Fixture) => f.app.context.services.devices.list(null).length;

test("a new phone with a code that holds is named to the relay and closed 4403; no device is made and the code is not spent", async () => {
  const f = await fixture("enforce", false);
  const offer = await f.offer();
  const before = deviceCount(f);
  const named = f.sent((frame) => frame.includes('"new_session"'));
  const p = await phone(f, offer, { code: offer.code ?? "" });
  expect(await p.closed).toEqual({ code: RELAY_NEW_SESSIONS_CLOSE, reason: RELAY_NEW_SESSIONS_REFUSED });
  await named;
  // the PC named exactly this client, once
  expect(f.newSessionFrames()).toEqual([JSON.stringify({ type: "new_session", connection_id: p.connectionId })]);
  expect(deviceCount(f)).toBe(before);
  // the code was neither spent nor counted as a failed pairing: it still pairs (asked of the store, which has no relay to refuse it)
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  expect(f.app.context.services.devices.pairRelay(offer.code ?? "", "Later phone", publicKey)).not.toBeNull();
});

test("a device this PC knows signs in and stays, and a session already open stays, while a new phone is refused", async () => {
  // new sessions are allowed at first, so a phone pairs
  const f = await fixture("enforce", true);
  const first = await f.offer();
  const known = await phone(f, first, { code: first.code ?? "" });
  const device = await known.admitted;
  // then the account passes its limit: the pass the PC renews with says no new sessions
  await f.renew(false);
  expect(f.service.status().pass?.new_sessions).toBe(false);
  // the known device on a new socket (a reconnect) signs in
  const again = await phone(f, first, { device });
  expect((await again.admitted).id).toBe(device.id);
  // a phone this PC does not know is refused
  const offer = await f.offer();
  const stranger = await phone(f, offer, { code: offer.code ?? "" });
  expect((await stranger.closed).code).toBe(RELAY_NEW_SESSIONS_CLOSE);
  // only the stranger was named, and both of the known device's sockets are still open
  expect(f.newSessionFrames()).toEqual([JSON.stringify({ type: "new_session", connection_id: stranger.connectionId })]);
  expect(known.socket.readyState).toBe(WebSocket.OPEN);
  expect(again.socket.readyState).toBe(WebSocket.OPEN);
});

test("a client that only knows the server_id learns nothing of the limit: a wrong code fails as ever and nothing is named", async () => {
  const f = await fixture("enforce", false);
  const offer = await f.offer();
  // connected and greeted, never pairing: nothing is said at socket open
  const squatter = await phone(f, offer, "squat");
  // a code that does not hold is an ordinary failed pairing
  const guesser = await phone(f, offer, { code: "0".repeat((offer.code ?? "").length) });
  expect(await guesser.error).toBe("auth_failed");
  expect((await guesser.closed).code).not.toBe(RELAY_NEW_SESSIONS_CLOSE);
  expect(f.newSessionFrames()).toEqual([]);
  // the relay told neither of them anything but its connection id: nothing of the pass
  for (const client of [squatter, guesser]) expect(client.fromRelay.map((frame) => Object.keys(JSON.parse(frame) as object))).toEqual([["type", "connection_id"]]);
  expect(squatter.socket.readyState).toBe(WebSocket.OPEN);
});

test("a new phone that arrived while the PC was away is named and refused once the PC is back", async () => {
  const f = await fixture("enforce", false);
  const offer = await f.offer();
  const before = deviceCount(f);
  // the PC's control socket is lost; the relay has seen it go once the close is answered
  const control = f.controls.at(-1)!;
  const gone = deferred<void>();
  control.addEventListener("close", () => gone.resolve());
  f.expectSync();
  control.close();
  await bounded(gone.promise);
  // the phone connects with no PC there: it waits in the room
  const waiting = phone(f, offer, { code: offer.code ?? "" });
  await f.synced;
  const p = await waiting;
  // the PC heard of it in `sync` when it came back, not in a `connected`
  expect(f.syncs.at(-1)?.connection_ids).toEqual([p.connectionId]);
  expect(await p.closed).toEqual({ code: RELAY_NEW_SESSIONS_CLOSE, reason: RELAY_NEW_SESSIONS_REFUSED });
  expect(f.newSessionFrames()).toEqual([JSON.stringify({ type: "new_session", connection_id: p.connectionId })]);
  expect(deviceCount(f)).toBe(before);
});

test("a relay in grace past its enforce_at enforces: a new phone is refused", async () => {
  const f = await fixture("grace", false, "2020-01-01T00:00:00Z");
  const offer = await f.offer();
  const p = await phone(f, offer, { code: offer.code ?? "" });
  expect((await p.closed).code).toBe(RELAY_NEW_SESSIONS_CLOSE);
  expect(f.newSessionFrames().length).toBe(1);
});

for (const scenario of [
  { name: "a pass that allows new sessions", mode: "enforce", newSessions: true },
  { name: "a v1 pass", mode: "enforce", newSessions: undefined },
  { name: "a relay in grace before its enforce_at", mode: "grace", newSessions: false },
  { name: "a relay with passes off", mode: "off", newSessions: false },
] as const) {
  test(`with ${scenario.name}, a new phone pairs and the PC names nobody`, async () => {
    const f = await fixture(scenario.mode, scenario.newSessions);
    const offer = await f.offer();
    const before = deviceCount(f);
    const p = await phone(f, offer, { code: offer.code ?? "" });
    expect(await p.outcome()).toBe("admitted");
    expect(deviceCount(f)).toBe(before + 1);
    expect(f.newSessionFrames()).toEqual([]);
  });
}

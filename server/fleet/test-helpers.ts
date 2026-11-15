/**
 * A fleet machine's side of one carrier for tests, built from the parts shared/relay-channel.ts is built from (the
 * protected channel of shared/relay-e2ee.ts and the mux engine), with the fleet extension: the protected handshake,
 * HELLO, a `machine-key` sign-in, the pipes its controller opens, and any bytes a test makes it send. The controller is
 * a RelaySession on a server started with `port: 0` (server/relay/test-helpers.ts relayFixture).
 */
import { channelBinding, exportPublicKey, generateKeyPair, openClientSecureChannel, openDaemonSecureChannel } from "../../shared/relay-e2ee.ts";
import { MuxEngine } from "../../shared/relay-mux-engine.ts";
import type { SessionFrame } from "../../shared/relay-mux-engine.ts";
import { decodeFrame, FrameType, isExtensionFrame } from "../../shared/relay-mux.ts";
import type { SessionError } from "../../shared/relay-mux.ts";
import { bounded, deferred, DuplexTransport } from "../relay/test-helpers.ts";
import type { relayFixture } from "../relay/test-helpers.ts";
import { RelaySession, relayClock } from "../relay/session.ts";
import type { RelaySessionOptions } from "../relay/session.ts";
import { enrollMessage, inviteKey } from "./invites.ts";
import { createOwnerKey } from "./owner.ts";
import type { OwnerBlock } from "./owner.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptPipe, EnrollFrame, enrollFrame, FLEET_STATE, FLEET_STATE_FEATURE, machineAuthFrame, machineAuthMessage, machineFingerprint, MACHINE_KEY, PACE_FEATURE, PACE_FRAME, PipeFrame, pipeMuxExtension } from "./mux-ext.ts";
import type { Enroll, EnrollOk, FleetDirectory, FleetState, MachineAuthOk, MachineRecord, MachineState, PipeAdvert, PipeStream, RelayPace } from "./mux-ext.ts";
/** What a test machine of this tree announces in AUTH: it reads PACE (todo 37) and FLEET_STATE (todo 31). */
export const CURRENT_FEATURES: readonly string[] = [PACE_FEATURE, FLEET_STATE_FEATURE];
import type { Transport } from "../../shared/relay-e2ee.ts";
import { connect as connectTarget } from "node:net";
import type { Socket } from "node:net";

export const SERVER_ID = "0123456789abcdef0123456789abcdef";

export interface MachineKey { readonly id: string; readonly spki: string; readonly privateKey: CryptoKey }

/** A machine key: a fresh one, or the test-only key of a vector file (its private scalar and SPKI). */
export async function machineKey(scalarHex?: string, spki?: string): Promise<MachineKey> {
  if (scalarHex === undefined || spki === undefined) {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const der = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
    return { id: machineFingerprint(der), spki: Buffer.from(der).toString("base64url"), privateKey: keys.privateKey };
  }
  const der = Buffer.from(spki, "base64url");
  const jwk = { kty: "EC", crv: "P-256", d: Buffer.from(scalarHex, "hex").toString("base64url"),
    x: der.subarray(27, 59).toString("base64url"), y: der.subarray(59, 91).toString("base64url") };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { id: machineFingerprint(der), spki, privateKey };
}

/** An in-memory fleet store; `set` changes a machine's state and tells every watcher. */
export function memoryDirectory(records: MachineRecord[]): FleetDirectory & { set(id: string, state: MachineState | null): void } {
  let current = [...records];
  const watchers = new Set<() => void>();
  return {
    machines: () => current,
    onChange(change) { watchers.add(change); return () => { watchers.delete(change); }; },
    set(id, state) {
      current = state === null ? current.filter((record) => record.machine_id !== id)
        : current.map((record) => record.machine_id === id ? { ...record, state } : record);
      for (const watcher of [...watchers]) watcher();
    },
  };
}
export const recordOf = (key: MachineKey, state: MachineState = "active"): MachineRecord => ({ machine_id: key.id, public_key: key.spki, state });

/** Signs the AUTH message of docs/fleet-link.md section 1.5 with `key`. */
export async function signMachineAuth(key: MachineKey, nonce: Uint8Array, serverId: string, binding: Uint8Array): Promise<string> {
  const message = new Uint8Array(machineAuthMessage(nonce, serverId, binding));
  return Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, message)).toString("base64url");
}

/** Turns the fleet of `stateDir` on, as `ovis-server fleet owner` does (its phrase is not kept): minting needs it. */
export function turnFleetOn(stateDir: string): void {
  createOwnerKey(join(stateDir, "fleet", "owner.json"));
}

/** An owner block for `controller` signed by a fresh test owner key: what an installer copies into fleet.json. */
export function testOwner(controller: { readonly server_id: string; readonly server_public_key: string }): OwnerBlock {
  const dir = mkdtempSync(join(tmpdir(), "fleet-test-owner-"));
  try { return createOwnerKey(join(dir, "owner.json")).key.block(controller); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

/** What a test machine needs of an invite file to enrol: its id and secret (docs/fleet-link.md section 4). */
export interface InviteSecret { readonly id: string; readonly secret: string }

/** ENROLL as `key` with `invite` over `binding`; any signed part can be replaced to make a signature for something else. */
export function signEnroll(key: MachineKey, invite: InviteSecret, binding: Uint8Array, change: { signedSpki?: string; secret?: string; id?: string } = {}): Enroll {
  const id = change.id ?? invite.id;
  const message = enrollMessage(binding, Buffer.from(change.signedSpki ?? key.spki, "base64url"), id);
  const signature = inviteKey(Buffer.from(change.secret ?? invite.secret, "base64url"), id).sign(message);
  return { invite_id: id, machine_public_key: key.spki, signature: Buffer.from(signature).toString("base64url"), now: Math.floor(Date.now() / 1000) };
}

/** An advert naming `endpoints`, with test-only secrets (docs/fleet-link.md section 1.8). */
export function testAdvert(endpoints: readonly ("bridge" | "native")[] = ["bridge", "native"]): PipeAdvert {
  return {
    endpoints: [...endpoints], runtime_id: "rt-test", boot_id: "boot-1",
    ...(endpoints.includes("bridge") ? { bridge_token: "ab".repeat(32) } : {}),
    ...(endpoints.includes("native") ? { native_bearer: "ovb_test-bearer" } : {}),
    health: { runtime: "up", bridge: "up" }, now: Math.floor(Date.now() / 1000),
    versions: { server: "0.5.0", link: "0.5.0", agent: "0.5.0", runtime: "0.9.1" },
  };
}
export const advertFrame = (advert: PipeAdvert) => ({ extension: true as const, type: PipeFrame.ADVERT, flags: 0, stream_id: 0, payload: advert });

/**
 * What the link agent does with a pipe it took, in TypeScript for tests: a connection to `target` (a TCP port or a Unix
 * socket path), PIPE_ACCEPT once it is up, bytes copied both ways with each end kept apart, RESET `upstream_lost` when
 * the target fails, and the target's connection ended when the pipe is reset.
 */
export function pipeToTarget(pipe: PipeStream, target: number | string, connected?: (socket: Socket) => void): void {
  const socket = typeof target === "number" ? connectTarget({ host: "127.0.0.1", port: target, allowHalfOpen: true }) : connectTarget({ path: target, allowHalfOpen: true });
  let over = false;
  pipe.onDispose = (error) => { over = true; if (error) socket.destroy(); };
  socket.on("error", () => { if (!over) pipe.reset("upstream_lost"); });
  socket.on("close", () => { if (!over) pipe.reset("upstream_lost"); });
  socket.once("connect", () => {
    connected?.(socket);
    pipe.accept();
    let writing = Promise.resolve();
    socket.on("data", (chunk: Buffer) => {
      socket.pause();
      writing = writing.then(() => pipe.write(chunk)).then(() => { socket.resume(); }, () => { socket.destroy(); });
    });
    socket.once("end", () => { writing = writing.then(() => pipe.end()).catch(() => { socket.destroy(); }); });
    void (async () => {
      try {
        for await (const chunk of pipe.readable) if (!socket.write(chunk)) await new Promise((resolve) => socket.once("drain", resolve));
        socket.end();
      } catch { socket.destroy(); }
    })();
  });
}

/**
 * A fleet machine on any carrier (a relay client socket, a direct carrier, an in-process pair): the protected handshake
 * against `serverPublicKey`, HELLO as a machine, AUTH `machine-key`, and each pipe its controller opens handed to
 * `onPipe` (refused when the machine has none).
 */
export async function machineClient(transport: Transport, serverPublicKey: string, serverId: string, onPipe?: (pipe: PipeStream) => void) {
  /** every PACE the controller sent (todo 37) */
  const paces: RelayPace[] = [];
  /** Each GOAWAY the controller sent, as read. */
  const goaways: { readonly code: string; readonly drain_ms: number; readonly reason?: string }[] = [];
  const welcome = deferred<Uint8Array>();
  const admitted = deferred<MachineAuthOk>();
  const enrolled = deferred<EnrollOk>();
  const error = deferred<{ code: SessionError; message: string }>();
  const closed = deferred<void>();
  const states: FleetState[] = [];
  let signedIn = false;
  let mux: MuxEngine | undefined;
  let helloSent = false;
  const channel = await bounded(openClientSecureChannel(transport, {
    daemonPublicKeyB64: serverPublicKey,
    events: {
      onmessage: (data) => {
        if (typeof data === "string") throw new Error("Unexpected plaintext string");
        const bytes = new Uint8Array(data);
        const frame = decodeFrame(bytes, false, pipeMuxExtension);
        if (!isExtensionFrame(frame) && frame.type === FrameType.SESSION_ERROR) error.resolve(frame.payload);
        if (!isExtensionFrame(frame) && frame.type === FrameType.GOAWAY) goaways.push(frame.payload);
        mux?.receive(bytes);
      },
      onclose: () => { mux?.carrierLost(); closed.resolve(); },
    },
  }));
  const engine: MuxEngine = new MuxEngine({
    role: "client", clock: relayClock, send: (bytes) => channel.send(bytes.slice().buffer),
    close: (code) => channel.close(code), outboundWireByteLength: (bytes) => channel.outboundWireByteLength(bytes.slice().buffer),
    routingOverhead: 0, maxWireMessageBytes: 64 * 1024, extension: pipeMuxExtension,
    onSession: (frame) => { if (frame.type === FrameType.WELCOME) welcome.resolve(Buffer.from(frame.payload.nonce, "base64url")); },
    onExtension: (frame) => {
      if (frame.type === PipeFrame.OPEN) {
        const pipe = onPipe ? acceptPipe(engine, frame, ["bridge", "native"]) : undefined;
        if (pipe) onPipe!(pipe);
        return;
      }
      if (frame.type === EnrollFrame.ENROLL_OK) { enrolled.resolve(frame.payload as EnrollOk); return; }
      // the newest FLEET_STATE is kept, as the link agent keeps it, and presented at the next sign-in (todo 31)
      if (frame.type === FLEET_STATE && signedIn) { states.push(frame.payload as FleetState); return; }
      if (frame.type === PACE_FRAME) { paces.push(frame.payload as RelayPace); return; }
      if (frame.type !== FrameType.AUTH_OK) { engine.fail("protocol_error", "Not a frame for a machine"); return; }
      const ok = frame.payload as MachineAuthOk;
      engine.authenticateExtension(ok.machine_id);
      signedIn = true;
      admitted.resolve(ok);
    },
  });
  mux = engine;
  const hello = () => {
    if (helloSent) return;
    helloSent = true;
    engine.sendSession({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", versions: [1], features: ["pipe-stream"], required_features: ["pipe-stream"] } });
  };
  return {
    mux: engine, channel, admitted: admitted.promise, enrolled: enrolled.promise, error: error.promise, closed: closed.promise, paces, goaways,

    /** Every FLEET_STATE the controller sent, oldest first. */
    states,
    /** HELLO (once) and ENROLL with `invite` as `key`; ENROLL_OK or the refusal follows on `enrolled` or `error`. */
    async enroll(key: MachineKey, invite: InviteSecret): Promise<void> {
      hello();
      await bounded(welcome.promise);
      const binding = channelBinding(channel);
      if (!binding) throw new Error("No channel binding");
      engine.enqueueControl(enrollFrame(signEnroll(key, invite, binding)));
    },
    /**
     * HELLO (once) and AUTH; resolves once the AUTH went out (AUTH_OK or the refusal follows on `admitted` or `error`).
     * `features`: what the agent announces (this one reads PACE and FLEET_STATE); null leaves the field out, as an agent
     * before todo 37. `seen`: the FLEET_STATE it kept (todo 31).
     */
    async signIn(key: MachineKey, features: readonly string[] | null = CURRENT_FEATURES, seen?: FleetState): Promise<void> {
      hello();
      const nonce = await bounded(welcome.promise);
      // a real carrier's channel opens after it was handed back: its binding is known once WELCOME came through it
      const binding = channelBinding(channel);
      if (!binding) throw new Error("No channel binding");
      engine.sendSession(machineAuthFrame({ scheme: MACHINE_KEY, machine_id: key.id, signature: await signMachineAuth(key, nonce, serverId, binding), ...features ? { features } : {}, ...(seen ? { seen_state: seen } : {}) }));
    },
    /** Sends `advert` and resolves once the controller has read it (a PING answered behind it). */
    async advertise(advert: PipeAdvert): Promise<void> {
      engine.enqueueControl(advertFrame(advert));
      await bounded(engine.measure());
    },
  };
}

/**
 * `machine.endpoints`: what the machine takes a pipe to (both by default); `machine.onPipe` gets each pipe it takes,
 * not yet answered (without it, each is accepted at once).
 */
export async function machineConnection(fixture: ReturnType<typeof relayFixture>, fleet: FleetDirectory | null,
  options: Partial<Omit<RelaySessionOptions, "channel" | "services" | "fleet">> = {},
  machine: { readonly endpoints?: readonly string[]; readonly onPipe?: (pipe: PipeStream) => void } = {}) {
  const clientTransport = new DuplexTransport();
  const daemonTransport = new DuplexTransport();
  clientTransport.peer = daemonTransport;
  daemonTransport.peer = clientTransport;
  fixture.closes.push(() => clientTransport.close());
  const keys = generateKeyPair();
  let session: RelaySession | undefined;
  let client: MuxEngine | undefined;
  const error = deferred<{ code: SessionError; message: string }>();
  const closed = deferred<void>();
  const welcome = deferred<Extract<SessionFrame, { type: typeof FrameType.WELCOME }>>();
  const admitted = deferred<MachineAuthOk>();
  const enrolled = deferred<EnrollOk>();
  const frames: number[] = [];
  const states: FleetState[] = [];
  let connectionSignedIn = false;
  /** every PACE the controller sent (todo 37) */
  const paces: RelayPace[] = [];
  /** Each GOAWAY the controller sent, as read. */
  const goaways: { readonly code: string; readonly last_open_id: number; readonly drain_ms: number; readonly reason?: string }[] = [];
  /** Bytes a test sends: each rides out in place of one PING the engine counts, so receipts stay in step. */
  const replacements: Uint8Array[] = [];
  const daemonOpening = openDaemonSecureChannel(daemonTransport, {
    daemonKeyPair: keys,
    events: { onmessage: (data) => session?.receive(data) },
  });
  const channel = await openClientSecureChannel(clientTransport, {
    daemonPublicKeyB64: exportPublicKey(keys.publicKey),
    events: {
      onmessage: (data) => {
        if (typeof data === "string") throw new Error("Unexpected plaintext string");
        const bytes = new Uint8Array(data);
        const frame = decodeFrame(bytes, false, pipeMuxExtension);
        frames.push(frame.type);
        if (!isExtensionFrame(frame) && frame.type === FrameType.SESSION_ERROR) error.resolve(frame.payload);
        if (!isExtensionFrame(frame) && frame.type === FrameType.GOAWAY) goaways.push(frame.payload);
        client?.receive(bytes);
      },
      onclose: () => { client?.carrierLost(); closed.resolve(); },
    },
  });
  const daemon = await daemonOpening;
  session = new RelaySession({
    channel: daemon, services: fixture.app.context.services, port: fixture.app.port,
    serverId: SERVER_ID, serverVersion: "0.4.20", minSupportedClient: "0.4.20",
    routingOverhead: 0, maxWireMessageBytes: 256 * 1024, ...options, ...(fleet ? { fleet } : {}),
  });
  client = new MuxEngine({
    role: "client", clock: relayClock,
    send: (bytes) => channel.send((bytes[1] === FrameType.PING ? replacements.shift() ?? bytes : bytes).slice().buffer),
    close: (code) => channel.close(code), outboundWireByteLength: (bytes) => channel.outboundWireByteLength(bytes.slice().buffer),
    routingOverhead: 0, maxWireMessageBytes: 256 * 1024, extension: pipeMuxExtension,
    onSession: (frame) => { if (frame.type === FrameType.WELCOME) welcome.resolve(frame); },
    onExtension: (frame) => {
      if (frame.type === PipeFrame.OPEN) {
        const pipe = acceptPipe(mux, frame, machine.endpoints ?? ["bridge", "native"]);
        if (pipe && machine.onPipe) machine.onPipe(pipe);
        else pipe?.accept();
        return;
      }
      if (frame.type === EnrollFrame.ENROLL_OK) { enrolled.resolve(frame.payload as EnrollOk); return; }
      if (frame.type === FLEET_STATE && connectionSignedIn) { states.push(frame.payload as FleetState); return; }
      if (frame.type === PACE_FRAME) { paces.push(frame.payload as RelayPace); return; }
      if (frame.type !== FrameType.AUTH_OK) { mux.fail("protocol_error", "Not a frame for a machine"); return; }
      const ok = frame.payload as MachineAuthOk;
      client?.authenticateExtension(ok.machine_id);
      connectionSignedIn = true;
      admitted.resolve(ok);
    },
  });
  const mux = client;
  const binding = channelBinding(channel);
  if (!binding) throw new Error("No channel binding");
  const beforeClose = <T>(event: Promise<T>): Promise<T> => Promise.race([
    event, closed.promise.then(() => { throw new Error("Carrier closed before the answer"); }),
  ]);
  return {
    session, mux, channel, frames, states, binding, error: error.promise, closed: closed.promise, paces, goaways, admitted: admitted.promise, enrolled: enrolled.promise,
    /** ENROLL as built (signEnroll over this session's binding unless `enroll` is given whole). */
    sendEnroll(key: MachineKey, invite: InviteSecret, change: Parameters<typeof signEnroll>[3] & { enroll?: Enroll } = {}) {
      mux.enqueueControl(enrollFrame(change.enroll ?? signEnroll(key, invite, binding, change)));
    },
    /** ENROLL, then AUTH once ENROLL_OK came; resolves with AUTH_OK. */
    async enrollAndSignIn(key: MachineKey, invite: InviteSecret) {
      this.sendEnroll(key, invite);
      await bounded(beforeClose(enrolled.promise));
      return this.signIn(key);
    },
    /** HELLO as a machine (`pipe-stream` offered and required) unless told otherwise; resolves with the WELCOME nonce. */
    async hello(features: readonly string[] = ["pipe-stream"], required: readonly string[] = features) {
      mux.sendSession({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", versions: [1], features, required_features: required } });
      return Buffer.from((await bounded(beforeClose(welcome.promise))).payload.nonce, "base64url");
    },
    /** AUTH `machine-key` as `key`; any of the signed parts can be replaced to make a signature for something else. */
    async sendAuth(key: MachineKey, change: { nonce?: Uint8Array; serverId?: string; binding?: Uint8Array; machineId?: string; features?: readonly string[] | null; seen?: FleetState } = {}) {
      const nonce = change.nonce ?? Buffer.from((await bounded(beforeClose(welcome.promise))).payload.nonce, "base64url");
      const signature = await signMachineAuth(key, nonce, change.serverId ?? options.serverId ?? SERVER_ID, change.binding ?? binding);
      const features = change.features === undefined ? CURRENT_FEATURES : change.features;
      mux.sendSession(machineAuthFrame({ scheme: MACHINE_KEY, machine_id: change.machineId ?? key.id, signature, ...features ? { features } : {}, ...(change.seen ? { seen_state: change.seen } : {}) }));
    },
    /** AUTH and its AUTH_OK; `features` as sendAuth's (null: an agent before todo 37), `seen` the FLEET_STATE it kept. */
    async signIn(key: MachineKey, features?: readonly string[] | null, seen?: FleetState) {
      await this.sendAuth(key, { ...(features === undefined ? {} : { features }), ...(seen ? { seen } : {}) });
      return bounded(beforeClose(admitted.promise));
    },
    /** Sends `bytes` as they are, in the place of one counted frame. */
    sendBytes(bytes: Uint8Array) {
      replacements.push(bytes);
      mux.enqueueControl({ type: FrameType.PING, flags: 0, stream_id: 0, payload: 0n });
    },
    stop() { clientTransport.close(); },
    /** The carrier goes half-open: from now on every frame either way is swallowed and nothing closes (a NAT rebinding, a dead link). */
    blackhole() {
      clientTransport.send = async () => {};
      daemonTransport.send = async () => {};
    },
  };
}

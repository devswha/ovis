import { randomBytes } from "node:crypto";
import { channelBinding } from "../../shared/relay-e2ee.ts";
import type { SecureChannel } from "../../shared/relay-e2ee.ts";
import { commitmentHolds, fromBase64Url, PAIR_APPROVAL_MS, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import { MuxEngine, MuxStreamError } from "../../shared/relay-mux-engine.ts";
import type { HttpStream, MuxClock, SessionFrame, WsStream } from "../../shared/relay-mux-engine.ts";
import type { ExtensionFrame } from "../../shared/relay-mux.ts";
import { asMachineAuth, EnrollFrame, enrollOkFrame, fleetMuxExtension, fleetStateFrame, FLEET_STATE_FEATURE, GOAWAY_CONFIRMED, helloKind, machineAuthOkFrame, machineRevoked, openPipe, PACE_FEATURE, paceFrame, PipeFrame, pipeMuxExtension, verifyMachineAuth } from "../fleet/mux-ext.ts";
import type { Enroll, FleetDirectory, FleetState, MachineCause, PipeAdvert, PipeStream, RelayPace } from "../fleet/mux-ext.ts";
import type { SignInQueue } from "../fleet/sign-in-queue.ts";
import { ACCOUNT_FEATURE, decodeFrame, DIRECT_CARRIER, DIRECT_TAILNET, EARLY_OPEN_BYTES, EARLY_OPEN_FRAMES, FrameType, LARGE_WS_MESSAGES, LIMITS_V1, PAIR_INTENT_ACCOUNT, PAIR_INTENT_PC, PAIR_INTENT_VOUCHED, PAIR_SAS_FEATURE, RELAY_HINTS, RELAY_PROTOCOL, REQUEST_HEADERS, RESPONSE_HEADERS, SERVER_TIME_HEADER, WS_CONTINUATION_CAPACITY } from "../../shared/relay-mux.ts";
import type { HeaderList, SessionError } from "../../shared/relay-mux.ts";
import { PairingRateLimitedError, type DeviceMatch, type PairingPath } from "../devices.ts";
import { accountDeviceId } from "../../shared/account-records.ts";
import { SIGN_IN_WAIT_MS } from "../account/mailbox.ts";
import { handleRequest } from "../dispatch.ts";
import type { RequestServices, ServerContext } from "../dispatch.ts";
import type { EventStreamBudget } from "../machine-api.ts";
import { VirtualSocket, type RelaySocketHandlers } from "./virtual-socket.ts";

export const RELAY_ORIGIN = "https://relay.ovis.invalid";
const SOURCE_LIMIT = 3 * 1024 * 1024;
const SESSION_LIMIT = 32 * 1024 * 1024;
/** How long a machine session that signed in `pending` drains after its batch is confirmed (it holds no pipe). */
export const PENDING_GOAWAY_DRAIN_MS = 1_000;
export const relayClock: MuxClock = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

/** Shared by HTTP and the WebSocket adapter; client identity headers never become Request headers. */
export function relayHeaders(list: HeaderList): Headers {
  const headers = new Headers();
  const allowed: readonly string[] = REQUEST_HEADERS;
  for (const [name, value] of list) if (allowed.includes(name)) headers.append(name, value);
  headers.set("origin", RELAY_ORIGIN);
  headers.set("sec-fetch-site", "same-origin");
  headers.set("accept-encoding", "identity");
  return headers;
}

export interface RelaySessionOptions {
  readonly channel: SecureChannel;
  readonly services: RequestServices;
  /** The server's listening port, resolved after binding (including port: 0). */
  readonly port: number;
  readonly serverId: string;
  readonly serverVersion: string;
  readonly minSupportedClient: string;
  readonly routingOverhead: number;
  readonly maxWireMessageBytes: number;
  readonly clock?: MuxClock;
  readonly dispatch?: typeof handleRequest;
  /** The core's SocketLike handlers. Without either adapter, WS_OPEN is refused. */
  readonly websocket?: RelaySocketHandlers;
  /** Owns the upgrade and socket lifecycle, including stream disposal. Absent adapters refuse WS_OPEN. */
  readonly onWs?: (stream: WsStream, exchange: RelayWebSocketRequest) => void;
  readonly onClose?: (code: SessionError) => void;
  /** The client signed in or paired: from here on the carrier counts as a device's session. */
  readonly onAuthenticated?: (deviceId: string) => void;
  /** The signed-in client opened its first stream: this carrier is the one it kept, not a racing one it drops (server/relay/admissions.ts). */
  readonly onChosen?: () => void;
  /** The relays a phone that offered RELAY_HINTS is told in AUTH_OK, the preferred one first. */
  readonly relayHints?: () => readonly string[];
  /**
   * This PC's direct carriers (server/relay/direct.ts), told in AUTH_OK to a phone that offered DIRECT_CARRIER;
   * with `tailnet` (it also offered DIRECT_TAILNET) its Tailscale one too.
   */
  readonly directCarriers?: (tailnet: boolean) => readonly string[];
  /**
   * A carrier that came straight to this PC rather than through the relay: devices sign in on it, and
   * nothing pairs (a code or a comparison), so pairing and its guesses stay on the relay.
   */
  readonly signInOnly?: boolean;
  /**
   * Asked once a pairing on this carrier would make a device new to this PC (a code that holds, or a comparison both
   * people confirmed), before the device is made: true when its relay refuses new client sessions to this PC now
   * (server/relay/link.ts). The session then makes no device and says nothing more: the relay closes the client.
   */
  readonly refuseNewDevice?: () => boolean;
  /**
   * The fleet machines this PC controls (docs/fleet-link.md): with it, a HELLO that offers `pipe-stream` starts a machine
   * session signed in by `machine-key`. Without it the codec takes no fleet frame and such a HELLO is refused as today.
   */
  readonly fleet?: FleetDirectory;
  /**
   * The fleet's live machine sessions (server/fleet/sessions.ts), asked once a machine's AUTH verified and before its
   * AUTH_OK: a cause refuses the sign-in. Without it a verified machine is signed in uncounted (the codec tests).
   */
  readonly machineSessions?: MachineSessions;
  /** A machine signed in on this carrier (its AUTH_OK committed): from here on it is a machine's session, never a device's. */
  readonly onMachine?: (machineId: string) => void;
  /**
   * This PC's direct carriers for a fleet machine (server/fleet/direct.ts machineCarriers), named in its AUTH_OK `direct`
   * so the link agent saves them; never told to a device.
   */
  readonly machineCarriers?: () => readonly string[];
  /** A carrier on a bridge adapter (server/relay/direct.ts): only a fleet machine signs in on it; a device's AUTH, PAIR or PAIR_REQUEST is refused `auth_failed`. */
  readonly machinesOnly?: boolean;
  /**
   * The fleet's invites (server/fleet/sessions.ts, server/fleet/invites.ts): with it, a machine session may send one
   * ENROLL before its AUTH (docs/fleet-link.md section 4). Without it an ENROLL is refused `auth_failed` `unknown`.
   */
  readonly enrolment?: MachineEnrolment;
  /** Where the carrier came from, on a direct carrier (its source address): ENROLL's own budget is kept per address. */
  readonly source?: string;
  /**
   * The fleet's sign-in queue was full when this machine's AUTH came (todo 37): a direct carrier says `retry_after_ms`
   * and closes 1013 (server/relay/direct.ts). Without it the machine is refused `resource_exhausted` `controller_limit`.
   */
  readonly onMachineBusy?: (retryAfterMs: number) => void;
  /** Places a machine may wait in the sign-in queue: SIGN_IN_WAITING on a direct carrier; the queue's own otherwise. */
  readonly machineWaitingPlaces?: number;
}

/** What an ENROLL is checked against (server/fleet/invites.ts FleetInvites.enroll). */
export interface MachineEnrolment {
  enroll(request: Enroll, context: { readonly binding: Uint8Array; readonly source?: string }): Promise<{ readonly machineId: string } | { readonly code: SessionError; readonly cause: MachineCause }>;
  /** As FleetDirectory.held: an ENROLL then ends `fleet_token_required` before the invite is looked at. */
  held?(): boolean;
}

/** What a machine session tells the fleet once admitted: its commit, each advert, its end (called once, whatever ends it). */
export interface MachineAdmission {
  committed(): void;
  advert(advert: PipeAdvert): void;
  ended(): void;
  /** The session was ended with `cause` in its SESSION_ERROR (before `ended`): why this machine is gone, for its row. */
  refused?(cause: MachineCause): void;
  /** The session was told to go (GOAWAY after its batch was confirmed) and the machine signs in again: it is no longer the machine's session. */
  superseded?(): void;
}
export interface MachineSessions {
  /**
   * `seen` is the AUTH's `seen_state` as it came (todo 31): the fleet checks it against its witness, and may refuse the
   * sign-in `restored` or `revoked` before it counts the session.
   */
  admit(machineId: string, session: RelaySession, seen?: FleetState): MachineAdmission | { readonly code: SessionError; readonly cause: MachineCause };
  /** Whether `machineId` is a key the fleet removed (its witness lists it): refused `auth_revoked` even with no record left. */
  removed?(machineId: string): boolean;
  /** The queue every machine AUTH is verified through (server/fleet/sign-in-queue.ts); verified at once without it. */
  readonly signIns?: SignInQueue;
  /** The relay pace AUTH_OK names for this machine, `rttMs` the round trip measured so far (todo 37). */
  paceFor?(machineId: string, rttMs: number): RelayPace | undefined;
}

export interface RelayWebSocketRequest {
  readonly request: Request;
  readonly context: ServerContext;
  upgrade?: Parameters<ServerContext["upgrade"]>[1];
}

/**
 * One protected carrier, one immutable principal, no replay. The carrier wires its plaintext
 * onmessage callback to receive(); construction requires the Noise handshake to have completed.
 */
export class RelaySession {
  readonly mux: MuxEngine;
  readonly sessionId = randomBytes(16).toString("hex");
  private state: "hello" | "auth" | "pair-commit" | "pair-wait" | "verifying" | "refused" | "ready" | "machine" | "closed" = "hello";
  /** The HELLO offered `pipe-stream` on a PC with a fleet: a machine session, never a device's. */
  private machine = false;
  /** The signed-in machine's latest PIPE_ADVERT, in memory only and gone with the session (docs/fleet-link.md section 1.8). */
  private advert: PipeAdvert | undefined;
  /** The fleet's count of this machine session, from its admission until it ends. */
  private admission: MachineAdmission | undefined;
  /** This machine session enrolled (ENROLL_OK went out): one ENROLL per session, and AUTH follows. */
  private enrolled = false;
  private readonly nonce = randomBytes(32);
  /** This session's channel binding, when the phone offered pairing by comparing digits and this PC selected it. */
  private sasBinding: Uint8Array | undefined;
  /**
   * What a comparison on this session asks for, as selected in WELCOME: `pc` unless the phone offered
   * `pair-intent-account`, or another PC of the account's server offered `pair-intent-pc-vouched` (`vouched`).
   */
  private intent: "pc" | "account" | "vouched" = "pc";
  /** A WELCOME went out: the provisional one before HELLO, or the answer to it. */
  private welcomed = false;
  /** When the first WELCOME went out: a machine's AUTH signs its nonce, so the AUTH comes a round trip later at least. */
  private welcomedAt: number | undefined;
  /** Ends a machine's wait in the sign-in queue when its carrier closes. */
  private signInAbort: AbortController | undefined;
  /** The provisional WELCOME said `early_open`: a phone may send its first stream frames right behind AUTH. */
  private earlyOpen = false;
  /**
   * From a well-formed AUTH (offered early_open) until its AUTH_OK commit: the stream frames that came behind it,
   * kept only when the device it names has a row here (`known`), and counted either way against EARLY_OPEN_FRAMES
   * and EARLY_OPEN_BYTES. None of them is read before the commit; a session that ends drops them.
   */
  private held: { readonly device: string; readonly known: boolean; readonly frames: ArrayBuffer[]; count: number; bytes: number } | undefined;
  /** A pairing by comparing digits under way; `ended` once it made a device or counted as a failure. */
  private sas: {
    label: string; publicKey: string; commitment: Uint8Array; pcNonce: Uint8Array; expiresAt: number;
    phoneConfirmed: boolean; approved: boolean; approvedBy?: string; ended: boolean; membersOnly: boolean; localOnly: boolean; /** approvals.closes when it was taken */ closes: number; withdraw?: () => void; cancelDeadline?: () => void; stopRevokeAll?: () => void; stopApprover?: () => void;
  } | undefined;
  private device: DeviceMatch | undefined;
  /** The key this session's device signed in or paired with: a `link` must start from it (docs/account.md). */
  private key = "";
  /** Whether the device signed in with AUTH, the only admission that proves it holds its key. */
  private keyProven = false;
  private hinting = false;
  /** the phone offered DIRECT_CARRIER and this PC has carriers to name */
  private directing = false;
  /** the phone also offered DIRECT_TAILNET: it can open a carrier on this PC's Tailscale address */
  private tailnet = false;
  /** the phone offered SERVER_TIME_HEADER: one that did not refuses the header */
  private serverTime = false;
  private unwatch: (() => void) | undefined;
  private sourceBytes = 0;
  private readonly clock: MuxClock;
  private readonly activity = new Map<number, () => void>();
  private readonly sockets = new Map<WsStream, VirtualSocket | undefined>();
  private readonly requests = new Set<HttpStream>();
  private chosen = false;

  constructor(private readonly options: RelaySessionOptions) {
    if (!options.channel.isOpen() || options.channel.securityMode() !== "protected") {
      throw new Error("Relay sessions require an open protected channel");
    }
    this.clock = options.clock ?? relayClock;
    this.mux = new MuxEngine({
      role: "server", clock: this.clock,
      send: (bytes) => {
        this.touch(bytes);
        return options.channel.send(bytes.slice().buffer);
      },
      outboundWireByteLength: (bytes) => options.channel.outboundWireByteLength(bytes.slice().buffer),
      routingOverhead: options.routingOverhead, maxWireMessageBytes: options.maxWireMessageBytes,
      // The dispatcher sets the route's budget, including overrides selected from a request body.
      requestTimeoutMs: () => 0,
      filterRequestHeaders: true,
      ...(options.fleet ? {
        extension: fleetMuxExtension,
        onExtension: (frame: ExtensionFrame) => {
          if (frame.type === PipeFrame.ADVERT && this.state === "machine") {
            this.advert = frame.payload as PipeAdvert;
            this.admission?.advert(this.advert);
            return;
          }
          if (frame.type === EnrollFrame.ENROLL) { void this.machineEnroll(frame.payload as Enroll).catch(() => this.close("internal_error")); return; }
          void this.machineSignIn(frame).catch(() => this.close("internal_error"));
        },
      } : {}),
      close: (code) => options.channel.close(code),
      onClose: (error) => {
        this.state = "closed";
        this.signInAbort?.abort(new Error("carrier closed"));
        this.advert = undefined;
        this.admission?.ended();
        this.admission = undefined;
        this.held = undefined;
        this.endPairing(false);
        this.unwatch?.();
        this.unwatch = undefined;
        options.onClose?.(error.code);
      },
      onSession: (frame) => {
        void this.admit(frame).catch((error: unknown) => {
          if (error instanceof PairingRateLimitedError) this.mux.fail("auth_failed", error.message);
          else this.close("internal_error");
        });
      },
      onHttp: (stream) => { this.choose(); void this.http(stream); },
      onWs: (stream) => {
        const device = this.principal();
        if (!device) { stream.reset("refused"); return; }
        this.choose();
        if (!options.onWs && !options.websocket) { stream.reset("refused"); return; }
        this.sockets.set(stream, undefined);
        const abort = new AbortController();
        let timer: (() => void) | undefined;
        const exchange: RelayWebSocketRequest = {
          request: new Request(RELAY_ORIGIN + stream.request.target, {
            headers: relayHeaders(stream.request.headers), signal: abort.signal,
          }),
          context: this.context(device, (_request, seconds) => {
            timer?.();
            timer = seconds > 0 ? this.clock.setTimeout(() => stream.reset("upstream_lost"), seconds * 1000) : undefined;
          }, (_request, upgrade) => {
            if (!stream.live || this.state !== "ready") return false;
            exchange.upgrade = upgrade;
            return true;
          }),
        };
        stream.onDispose = () => {
          timer?.();
          abort.abort();
          exchange.upgrade?.data.relay?.close();
          this.sockets.delete(stream);
        };
        if (options.onWs) options.onWs(stream, exchange);
        else void this.websocket(stream, exchange);
      },
    });
    options.channel.onClose(() => this.mux.carrierLost());
    // A WELCOME with no feature rides right behind the protected handshake's answer, so a phone signing in
    // gets its nonce one round trip sooner. It is provisional: HELLO is still required, and checked, before
    // AUTH or PAIR, and a HELLO that offers pairing by comparing digits gets the final WELCOME. Only while no
    // comparison can be under way: a phone from before `provisional` reads the first WELCOME as the answer.
    if (!options.services.relay.approvals.windowOpen()) this.welcome([], true);
  }

  private welcome(features: readonly string[], provisional: boolean): void {
    this.welcomed = true;
    this.welcomedAt ??= this.clock.now();
    this.mux.sendSession({
      type: FrameType.WELCOME, flags: 0, stream_id: 0,
      payload: {
        protocol: "ovis-mux", version: 1, features, limits: LIMITS_V1,
        nonce: this.nonce.toString("base64url"), server_version: this.options.serverVersion,
        relay_protocol: RELAY_PROTOCOL, min_supported_client: this.options.minSupportedClient,
        // only the provisional WELCOME offers early_open: it goes out before HELLO, so a phone signs in on it
        ...(provisional ? { provisional: true as const, early_open: true as const } : {}),
      },
    });
    if (provisional) this.earlyOpen = true;
  }

  /** What the signed-in machine last advertised, or undefined before its first PIPE_ADVERT. */
  get pipeAdvert(): PipeAdvert | undefined { return this.advert; }

  /** The controller's relay identity this session signs machines in for: the FLEET_STATE tag names it. */
  get serverId(): string { return this.options.serverId; }

  /** Sends FLEET_STATE (docs/fleet-link.md section 1.7) to this signed-in machine; nothing on any other session. */
  sendFleetState(state: FleetState): void {
    if (this.state === "machine" && this.fleetStateFeature && this.mux.active) this.mux.enqueueControl(fleetStateFrame(state));
  }
  private fleetStateFeature = false;

  /** Opens a pipe to this signed-in machine's `endpoint` (docs/fleet-link.md section 2); the controller is the only opener. */
  openPipe(endpoint: string): PipeStream {
    if (this.state !== "machine") throw new MuxStreamError("refused");
    return openPipe(this.mux, endpoint);
  }

  /** A sign-in or pairing is being checked, or its AUTH_OK waits to be sent. */
  get verifying(): boolean { return this.state === "verifying"; }
  /** Whether this carrier came straight to this PC (server/relay/direct.ts) rather than through the relay. */
  get direct(): boolean { return this.options.signInOnly === true; }
  /** A machine whose AUTH waits in the fleet's sign-in queue or is being verified: it keeps its place against newcomers. */
  get machineSigningIn(): boolean { return this.machine && this.state === "verifying"; }

  /**
   * The machine's agent announced `pace` in its AUTH (todo 37): it reads PACE frames. An older agent refuses one as a
   * protocol error, so it gets none and keeps its session; AUTH_OK's `relay_pace` goes to every agent.
   */
  get readsPace(): boolean { return this.paceFeature; }
  private paceFeature = false;

  /** Sends a signed-in machine its relay pace (PACE, docs/fleet-link.md section 1, todo 37). */
  sendPace(pace: RelayPace): void {
    if (this.state === "machine" && this.mux.active) this.mux.enqueueControl(paceFrame(pace));
  }

  /** Both ends are comparing digits: admission waits for people, up to PAIR_APPROVAL_MS. */
  get pairing(): boolean { return this.state === "pair-commit" || this.state === "pair-wait"; }

  get bufferedBytes(): number { return this.sourceBytes + this.mux.stats.bufferedBytes; }

  receive(data: string | ArrayBuffer): void {
    if (typeof data === "string") { this.close("protocol_error"); return; }
    if (this.held) { this.hold(data); return; }
    const bytes = new Uint8Array(data);
    this.mux.receive(bytes);
    for (const socket of this.sockets.values()) socket?.drain();
    if (this.mux.active) this.touch(bytes);
  }

  /**
   * A frame while AUTH is verified on a session that offered early_open. One on stream 0 is read as ever (a second
   * AUTH, HELLO or PAIR is refused there). A stream frame is not read: an OPEN must name the device AUTH named, and
   * past EARLY_OPEN_FRAMES or EARLY_OPEN_BYTES the session ends.
   */
  private hold(data: ArrayBuffer): void {
    const held = this.held;
    if (!held || !this.mux.active) return;
    const bytes = new Uint8Array(data);
    if (bytes.byteLength < 8 || new DataView(data).getUint32(4) === 0) { this.mux.receive(bytes); return; }
    let frame;
    try { frame = decodeFrame(bytes, true); } catch { this.close("protocol_error"); return; }
    if ((frame.type === FrameType.HTTP_OPEN || frame.type === FrameType.WS_OPEN) && frame.payload.device_id !== held.device) { this.close("protocol_error"); return; }
    if (held.count >= EARLY_OPEN_FRAMES || held.bytes + bytes.byteLength > EARLY_OPEN_BYTES) { this.close("resource_exhausted"); return; }
    held.count++;
    held.bytes += bytes.byteLength;
    if (held.known) held.frames.push(data);
  }

  private touch(bytes: Uint8Array): void {
    if (bytes.byteLength >= 8) this.activity.get(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4))?.();
  }

  close(code: SessionError = "auth_revoked"): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.held = undefined;
    this.endPairing(false);
    this.unwatch?.();
    this.unwatch = undefined;
    if (code !== "auth_revoked" && code !== "auth_changed") { this.mux.fail(code, code); return; }
    // Stop application work now, but let the known WS policy close reach the peer before
    // SESSION_ERROR tears down the carrier. WsStream bounds both draining and the close exchange.
    for (const stream of this.requests) stream.reset("cancelled");
    const closing: Promise<void>[] = [];
    for (const [stream, socket] of this.sockets) {
      if (!socket) { stream.reset("cancelled"); continue; }
      closing.push(socket.closed);
      socket.close(1008, "Device access revoked");
    }
    // An aborting CLOSE notifies locally before its urgent frame is submitted.
    if (closing.length) void Promise.all(closing).then(() => this.mux.flush()).then(() => this.mux.fail(code, code));
    else this.mux.fail(code, code);
  }

  /** The pairing would have made a device while new client sessions are refused: nothing is answered from here on. */
  private get refused(): boolean { return this.state === "refused"; }

  /** The device store's last question before a pairing makes a device (server/devices.ts pairRelay): false makes none. */
  private readonly admitNewDevice = (): boolean => {
    if (!this.options.refuseNewDevice?.()) return true;
    this.state = "refused";
    return false;
  };

  /** Ends a machine session with `code` and its cause in SESSION_ERROR's message (docs/fleet-link.md section 1). */
  closeMachine(code: SessionError, cause: MachineCause): void { this.refuseMachine(code, cause); }

  /** Whether this controller's fleet is held for want of a token (server/fleet/gate.ts). */
  private fleetHeld(): boolean {
    return this.options.fleet?.held?.() === true || this.options.enrolment?.held?.() === true;
  }

  /** A refusal that names its cause in SESSION_ERROR's message (docs/fleet-link.md section 1), on a session that holds no stream. */
  private refuseMachine(code: SessionError, cause: MachineCause): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.unwatch?.();
    this.unwatch = undefined;
    this.admission?.refused?.(cause);
    this.mux.fail(code, cause);
  }

  /**
   * `verify` in its turn of the fleet's sign-in queue (server/fleet/sign-in-queue.ts), or at once without one. Undefined
   * when the queue was full (the machine was told so: 1013 with `retry_after_ms` on a direct carrier, else
   * `resource_exhausted` `controller_limit`) or the carrier closed while it waited.
   */
  private async inQueue<T>(verify: () => Promise<T>): Promise<T | undefined> {
    const queue = this.options.machineSessions?.signIns;
    if (!queue) return verify();
    this.signInAbort = new AbortController();
    const turn = queue.run(verify, this.signInAbort.signal, this.options.machineWaitingPlaces);
    if (turn === "busy") {
      // the queue keeps every machine already in it: this newcomer comes back later
      if (this.options.onMachineBusy) { this.state = "closed"; this.options.onMachineBusy(queue.retryAfterMs()); }
      else this.refuseMachine("resource_exhausted", "controller_limit");
      return undefined;
    }
    try { return await turn; } catch { return undefined; }
  }

  /**
   * A new machine enrols (docs/fleet-link.md section 4): once, after a machine's HELLO and before its AUTH, never on a
   * device's session. The invites decide; a refusal ends the session with its cause, ENROLL_OK leaves it waiting for AUTH.
   */
  private async machineEnroll(request: Enroll): Promise<void> {
    if (!this.machine || this.state !== "auth" || this.enrolled) { this.close("protocol_error"); return; }
    const enrolment = this.options.enrolment;
    if (!enrolment) { this.refuseMachine("auth_failed", "unknown"); return; }
    // no token on this controller: nothing about the invite is read or counted (server/fleet/gate.ts)
    if (this.fleetHeld()) { this.refuseMachine("auth_failed", "fleet_token_required"); return; }
    const binding = channelBinding(this.options.channel);
    if (!binding) { this.refuseMachine("auth_failed", "signature"); return; }
    this.state = "verifying";
    // one turn of the sign-in queue, as an AUTH takes (todo 37): every signature check counts against its bound
    const result = await this.inQueue(() => enrolment.enroll(request, { binding, ...(this.options.source === undefined ? {} : { source: this.options.source }) }));
    if (result === undefined || !this.mux.active || this.state !== "verifying") return;
    if ("code" in result) { this.refuseMachine(result.code, result.cause); return; }
    this.enrolled = true;
    this.state = "auth";
    this.mux.enqueueControl(enrollOkFrame({ machine_id: result.machineId }));
  }

  /**
   * A machine signs in (docs/fleet-link.md section 1.5): never through the device store, never as a device. The AUTH_OK
   * commit makes the engine's second authenticated state, in which no HTTP or WS stream opens and no setup frame is taken.
   */
  private async machineSignIn(frame: ExtensionFrame): Promise<void> {
    const fleet = this.options.fleet;
    const auth = asMachineAuth(frame);
    this.paceFeature = auth?.features?.includes(PACE_FEATURE) ?? false;
    // an agent from before todo 31 reads FLEET_STATE as a protocol error: it gets one only when its AUTH says it reads it
    this.fleetStateFeature = auth?.features?.includes(FLEET_STATE_FEATURE) ?? false;
    if (!fleet || !auth || this.state !== "auth") { this.close("protocol_error"); return; }
    if (!this.machine) { this.refuseMachine("auth_failed", "wrong_scheme"); return; }
    if (this.fleetHeld()) { this.refuseMachine("auth_failed", "fleet_token_required"); return; }
    this.state = "verifying";
    const authAt = this.clock.now();
    const result = await this.inQueue(() => verifyMachineAuth(fleet, auth, { nonce: this.nonce, serverId: this.options.serverId, binding: channelBinding(this.options.channel) }));
    if (result === undefined || !this.mux.active || this.state !== "verifying") return;
    if ("code" in result) {
      // a key the fleet removed stays refused auth_revoked, also once its record is gone (todo 31)
      if (result.cause === "unknown" && this.options.machineSessions?.removed?.(auth.machine_id)) { this.refuseMachine("auth_revoked", "revoked"); return; }
      this.refuseMachine(result.code, result.cause);
      return;
    }
    const machineId = result.machineId;
    const publicKey = fleet.machines().find((record) => record.machine_id === machineId)?.public_key ?? "";
    const revoked = () => machineRevoked(fleet, machineId, publicKey);
    const pendingNow = () => fleet.machines().find((record) => record.machine_id === machineId)?.state === "pending";
    // AUTH_OK says `pending` while the owner has not confirmed the machine's batch (docs/fleet-link.md section 1.6).
    // Once confirmed, the session goes (GOAWAY) so the machine signs in again and hears it is no longer pending; it
    // has no pipe to lose: none opens to a pending machine.
    let toldPending = pendingNow();
    const confirmed = () => {
      if (!toldPending || this.state !== "machine" || pendingNow()) return;
      toldPending = false;
      // before GOAWAY goes: the roster stops showing it and no new pipe picks it while it drains
      this.admission?.superseded?.();
      this.mux.goAway("shutdown", PENDING_GOAWAY_DRAIN_MS, GOAWAY_CONFIRMED);
    };
    this.unwatch = fleet.onChange(() => {
      const cause = revoked();
      if (cause) { this.refuseMachine("auth_revoked", cause); return; }
      confirmed();
    });
    // counted from here (so two machines verified at once cannot both take the last place), released when it ends
    const admission = this.options.machineSessions?.admit(machineId, this, auth.seen_state);
    if (admission && "code" in admission) { this.refuseMachine(admission.code, admission.cause); return; }
    this.admission = admission;
    // As for a device: the commit runs before the sink, and the machine is checked once more right there.
    const direct = this.options.machineCarriers?.() ?? [];
    // the first round trip: WELCOME out to AUTH in, which also holds the machine's signing (an upper bound is safe)
    const pace = this.options.machineSessions?.paceFor?.(machineId, Math.max(0, authAt - (this.welcomedAt ?? authAt)));
    this.mux.enqueueControl(machineAuthOkFrame({ session_id: this.sessionId, machine_id: machineId, role: "machine", ...pace ? { relay_pace: pace } : {}, ...direct.length ? { direct: [...direct] } : {}, ...toldPending ? { pending: true } : {} }), undefined, () => {
      const cause = revoked();
      if (cause) { this.refuseMachine("auth_revoked", cause); return; }
      this.mux.authenticateExtension(machineId);
      this.state = "machine";
      this.admission?.committed();
      this.options.onMachine?.(machineId);
      confirmed();
    });
  }

  private async admit(frame: SessionFrame): Promise<void> {
    if (this.refused) return;
    // a machine is never a device: no device sign-in and no pairing, so no approval prompt and no failure counted
    if (this.machine && (frame.type === FrameType.AUTH || frame.type === FrameType.PAIR || frame.type === FrameType.PAIR_REQUEST)) {
      this.refuseMachine("auth_failed", "wrong_scheme");
      return;
    }
    switch (frame.type) {
      case FrameType.HELLO: {
        if (this.state !== "hello") { this.close("protocol_error"); return; }
        if (!frame.payload.versions.includes(1)) { this.close("unsupported_version"); return; }
        const kind = this.options.fleet ? helloKind(frame.payload.features, frame.payload.required_features) : "device";
        if (kind !== "device") {
          if (kind !== "machine") { this.close(kind); return; }
          this.machine = true;
          this.mux.useExtension(pipeMuxExtension);
          this.state = "auth";
          if (!this.welcomed) this.welcome([], false);
          return;
        }
        // selected only where it can finish: a protected channel to bind the digits to
        if (frame.payload.features.includes(PAIR_SAS_FEATURE) && !this.options.signInOnly) this.sasBinding = channelBinding(this.options.channel);
        // relay hints are answered in AUTH_OK, not WELCOME: a provisional WELCOME goes out before HELLO is read
        this.hinting = this.options.relayHints !== undefined && frame.payload.features.includes(RELAY_HINTS);
        this.directing = this.options.directCarriers !== undefined && frame.payload.features.includes(DIRECT_CARRIER);
        this.tailnet = this.directing && frame.payload.features.includes(DIRECT_TAILNET);
        // a large session's snapshot goes in one message only to a phone that takes it (#2773)
        const large = frame.payload.features.includes(LARGE_WS_MESSAGES);
        if (large) this.mux.sendLargeMessages();
        this.serverTime = frame.payload.features.includes(SERVER_TIME_HEADER);
        // an intent is selected only with pair-sas, and only the one offered (docs/account.md, "Negotiation")
        const intents = frame.payload.features.filter((f) => f === PAIR_INTENT_PC || f === PAIR_INTENT_ACCOUNT || f === PAIR_INTENT_VOUCHED);
        if (intents.length > 1) { this.close("protocol_error"); return; }
        const selected = [...this.sasBinding ? [PAIR_SAS_FEATURE, ...intents] : [], ...frame.payload.features.includes(ACCOUNT_FEATURE) ? [ACCOUNT_FEATURE] : []];
        // a feature the phone requires has to be one this PC takes on this channel
        if (frame.payload.required_features.some((feature) => !selected.includes(feature) && !(feature === RELAY_HINTS && this.hinting) && !(feature === DIRECT_CARRIER && this.directing) && !(feature === DIRECT_TAILNET && this.tailnet) && !(feature === LARGE_WS_MESSAGES && large))) { this.close("unsupported_extension"); return; }
        this.state = "auth";
        if (this.sasBinding && intents[0] === PAIR_INTENT_ACCOUNT) this.intent = "account";
        if (this.sasBinding && intents[0] === PAIR_INTENT_VOUCHED) this.intent = "vouched";
        // after a provisional WELCOME (nothing selected), another goes out only when this one selects something
        if (!this.welcomed || selected.length > 0) this.welcome(selected, false);
        return;
      }
      case FrameType.AUTH: case FrameType.PAIR: {
        if (this.state !== "auth") { this.close("protocol_error"); return; }
        // refused before the code is looked at: nothing is spent or counted
        if (frame.type === FrameType.PAIR && this.options.signInOnly) { this.close("auth_failed"); return; }
        // a bridge adapter's carrier is for fleet machines only: a device signs in nowhere it could not before. Refused at its
        // AUTH, not its HELLO, so the refusal is read before the carrier closes (a close with unread data resets on Windows)
        if (this.options.machinesOnly) { this.close("auth_failed"); return; }
        this.state = "verifying";
        const devices = this.options.services.devices;
        if (this.options.services.serveOnly) { this.close("auth_failed"); return; }
        // held from here, before anything is awaited: what came behind AUTH in its flight is not read before AUTH_OK
        if (frame.type === FrameType.AUTH && this.earlyOpen) {
          this.held = { device: frame.payload.device_id, known: devices.has(frame.payload.device_id), frames: [], count: 0, bytes: 0 };
        }
        if (frame.type === FrameType.AUTH && !await this.pullForRefusedSignIn(frame.payload.device_id, frame.payload.signature)) return;
        this.keyProven = frame.type === FrameType.AUTH;
        const device = frame.type === FrameType.AUTH
          ? await devices.matchRelay(frame.payload.device_id, this.nonce, frame.payload.signature, this.options.serverId)
          : devices.pairRelay(frame.payload.code, frame.payload.label, frame.payload.public_key, undefined, this.admitNewDevice)?.device;
        // no auth_failed: the code held and was not spent, and the relay closes this client for the pass
        if (this.refused) return;
        this.enter(device);
        return;
      }
      case FrameType.PAIR_REQUEST: {
        // a direct carrier pairs nothing, whatever was offered: refused as a sign-in failure, before the binding is looked at
        if (this.options.signInOnly) { this.close("auth_failed"); return; }
        if (this.state !== "auth" || !this.sasBinding) { this.close("protocol_error"); return; }
        if (this.options.services.serveOnly) { this.close("auth_failed"); return; }
        // nobody asked for a link lately: refused before any prompt, and not counted, since no person was asked,
        // unless it is an account join the account service has seen (accountJoin, docs/account.md design 5.3).
        // Another PC of the account's server is taken only that way, window or not: its admission is its whole invitation
        let membersOnly = false;
        // taken under the PC's own add-me screen: this comparison stays the PC's to decide, whenever its digits show
        const localOnly = this.options.services.relay.approvals.localOnlyOpen();
        if (this.intent === "vouched" || !this.options.services.relay.approvals.windowOpen()) {
          this.state = "verifying";
          if (!await this.accountJoin(frame.payload.public_key)) { this.close("auth_failed"); return; }
          if (!this.mux.active) return;
          membersOnly = true;
        }
        this.options.services.devices.assertRelayPairing(this.path);
        this.state = "pair-commit";
        this.sas = {
          label: frame.payload.label, publicKey: frame.payload.public_key, commitment: fromBase64Url(frame.payload.commitment),
          pcNonce: randomPairNonce(), expiresAt: Date.now() + PAIR_APPROVAL_MS, phoneConfirmed: false, approved: false, ended: false, membersOnly, localOnly, closes: this.options.services.relay.approvals.closes,
        };
        // past the comparison's deadline the session ends with `timeout` and its prompt goes at once;
        // the mux's own setup deadline stays just behind it as the backstop
        this.sas.cancelDeadline = this.clock.setTimeout(() => { if (this.pairing) this.close("timeout"); }, PAIR_APPROVAL_MS);
        // revoking every device also ends a comparison under way, even one the owner already approved
        this.sas.stopRevokeAll = this.options.services.devices.onRevokeAll(() => { if (this.pairing) this.close("auth_failed"); });
        this.mux.extendSetup(PAIR_APPROVAL_MS + 1_000);
        this.mux.sendSession({ type: FrameType.PAIR_CHALLENGE, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(this.sas.pcNonce) } });
        return;
      }
      case FrameType.PAIR_REVEAL: {
        const sas = this.sas;
        if (this.state !== "pair-commit" || !sas || !this.sasBinding) { this.close("protocol_error"); return; }
        const phoneNonce = fromBase64Url(frame.payload.nonce);
        if (!commitmentHolds(sas.commitment, this.sasBinding, sas.publicKey, phoneNonce)) { this.close("auth_failed"); return; }
        // the window it was taken under was closed while this phone held its reveal: no prompt after a close
        // (a join shown to account members only never depended on the window)
        if (!sas.membersOnly && this.options.services.relay.approvals.closes !== sas.closes) { this.close("auth_failed"); return; }
        // a pause that began while this phone held its reveal still keeps its prompt off the owner's screen
        this.options.services.devices.assertRelayPairing(this.path);
        const asked = this.options.services.relay.approvals.ask(sas.label,
          pairDigits(this.sasBinding, sas.publicKey, phoneNonce, sas.pcNonce), sas.expiresAt,
          // a PC vouched for is asked as "pair this PC": it joins this PC alone, and the approver's app signs nothing for it;
          // marked vouched, so that app shows who is asking and checks the admission, as for an account join
          { intent: this.intent === "account" ? "account" : "pc", key: sas.publicKey, deviceId: accountDeviceId(this.options.serverId, sas.publicKey), membersOnly: sas.membersOnly, localOnly: sas.localOnly, vouched: this.intent === "vouched" });
        if (!asked) { this.close("auth_failed"); return; }
        this.state = "pair-wait";
        sas.withdraw = asked.withdraw;
        void asked.decision.then((decision) => {
          if (this.sas !== sas || this.state !== "pair-wait") return;
          if (!decision.approved) { this.close("auth_failed"); return; }
          sas.approved = true;
          sas.approvedBy = decision.by?.id;
          // an approver revoked or given another role before the phone confirms takes the approval with it, for good
          if (decision.by) sas.stopApprover = this.options.services.devices.onRevoke(decision.by.id, () => { if (this.pairing) this.close("auth_failed"); });
          this.finishPairing();
        }).catch(() => this.close("internal_error"));
        return;
      }
      case FrameType.PAIR_CONFIRM: {
        if (this.state !== "pair-wait" || !this.sas || this.sas.phoneConfirmed) { this.close("protocol_error"); return; }
        this.sas.phoneConfirmed = true;
        this.finishPairing();
        return;
      }
      case FrameType.WELCOME: case FrameType.AUTH_OK: case FrameType.PAIR_CHALLENGE:
        this.close("protocol_error");
    }
  }

  private hints(): { relays?: readonly string[]; direct?: readonly string[] } {
    const relays = this.hinting ? this.options.relayHints?.() ?? [] : [];
    const direct = this.directing ? this.options.directCarriers?.(this.tailnet) ?? [] : [];
    return { ...relays.length ? { relays } : {}, ...direct.length ? { direct } : {} };
  }

  /** Both people said the digits match: the phone on its screen, the owner on this PC. */
  private finishPairing(): void {
    const sas = this.sas;
    if (!sas || !sas.phoneConfirmed || !sas.approved || this.state !== "pair-wait") return;
    // an answer that lands after the deadline, before its timer ran, makes no device either
    if (Date.now() > sas.expiresAt) { this.close("timeout"); return; }
    // approved on this PC, then the window it was taken under was closed before the phone confirmed: no device after a close
    if (!sas.membersOnly && this.options.services.relay.approvals.closes !== sas.closes) { this.close("auth_failed"); return; }
    this.state = "verifying";
    // a member's remote approval never lets in a key this PC holds back (removed elsewhere, or a remove for it waits here);
    // only a pairing approved on this PC itself does
    if (sas.approvedBy !== undefined && this.options.services.accountMailbox.gates().held(sas.publicKey)) { this.close("auth_failed"); return; }
    let device: DeviceMatch | undefined;
    try { device = this.options.services.devices.pairRelayApproved(sas.label, sas.publicKey, { path: this.path, id: accountDeviceId(this.options.serverId, sas.publicKey), ...(sas.approvedBy === undefined ? {} : { addedBy: sas.approvedBy }) }, undefined, this.admitNewDevice)?.device; }
    catch (error) {
      if (error instanceof PairingRateLimitedError) { this.close("auth_failed"); return; }
      throw error;
    }
    // pairRelayApproved counted a refused key itself
    this.endPairing(true);
    if (this.refused) return;
    this.enter(device);
  }

  /** Once per comparison: one that made no device counts against relay pairing (server/devices.ts). */
  private endPairing(counted: boolean): void {
    const sas = this.sas;
    if (!sas || sas.ended) return;
    sas.ended = true;
    sas.cancelDeadline?.();
    sas.stopRevokeAll?.();
    sas.stopApprover?.();
    sas.withdraw?.();
    if (!counted) this.options.services.devices.noteRelayFailure(this.path);
  }

  /**
   * An account join outside the pairing window (docs/account.md, design 5.3), or another PC of the account
   * vouched for: only with the account or vouched intent, on a PC in an account with a member to approve, for a
   * key the account service has a fresh admission for, at most 5 a minute between them. Never counted as a
   * failed pairing: nobody was asked.
   */
  private async accountJoin(key: string): Promise<boolean> {
    const { devices, relay, accountMailbox } = this.options.services;
    const allowed = () => (this.intent === "account" || this.intent === "vouched") && devices.account() !== null && devices.hasAccountApprover();
    if (!allowed()) return false;
    // a pull may take a while: the comparison's own deadline starts now
    this.mux.extendSetup(PAIR_APPROVAL_MS + 1_000);
    if (!await accountMailbox.admitted(key) || !allowed()) return false;
    // counted only once admitted, so refused strangers cannot spend the PC's joins
    return relay.approvals.takeAccountJoin();
  }

  /**
   * A sign-in a PC in an account would refuse: a member may have added the device on another PC a
   * moment ago, so the PC reads its mailbox first (at most once a minute and for at most 5 seconds,
   * server/account/mailbox.ts); the caller then checks the sign-in as ever. Whatever fails, an id with
   * no row here or a signature that does not hold, takes this same way, so how long the refusal takes
   * does not tell which ids have a row. A sign-in that holds calls nothing. False when the session
   * ended meanwhile.
   */
  private async pullForRefusedSignIn(deviceId: string, signature: string): Promise<boolean> {
    const { devices, accountMailbox } = this.options.services;
    if (devices.account() === null) return true;
    if (await devices.matchRelay(deviceId, this.nonce, signature, this.options.serverId) !== null) return this.mux.active;
    // the pull may take a while: the session's own deadline starts after it
    this.mux.extendSetup(SIGN_IN_WAIT_MS + 10_000);
    await accountMailbox.pullForRefusedSignIn();
    return this.mux.active;
  }

  /** Which failure count this session's comparison spends (server/devices.ts PairingPath). */
  private get path(): PairingPath { return this.intent === "account" ? "account" : this.intent === "vouched" ? "vouched" : "code"; }

  /** A verified AUTH, PAIR or approved comparison becomes this session's one principal. */
  private enter(device: DeviceMatch | null | undefined): void {
    const devices = this.options.services.devices;
    if (!this.mux.active) return;
    if (!device) { this.close("auth_failed"); return; }
    const unrevoke = devices.onRevoke(device.id, () => this.close(devices.has(device.id) ? "auth_changed" : "auth_revoked"));
    // a link moves the row to another key: a session signed in with the one it had ends, all but the linking one
    const unlinked = devices.onLinked(device.id, (sessionId) => { if (sessionId !== this.sessionId) this.close("auth_changed"); });
    this.unwatch = () => { unrevoke(); unlinked(); };
    if (!devices.has(device.id) || !this.mux.active) { this.unwatch(); return; }
    if (devices.list(null).find((current) => current.id === device.id)?.role !== device.role) {
      this.close("auth_changed");
      return;
    }
    this.device = Object.freeze(device);
    // a key sent with a code or a comparison was never signed with: nothing account-side may rest on it
    this.key = this.keyProven ? devices.relayKeyOf(device.id) ?? "" : "";
    // The commit callback runs before the sink: synchronous carriers can immediately OPEN.
    // Until then OPEN is still unauthenticated, even while AUTH_OK waits behind receipt credit.
    this.mux.enqueueControl({
      type: FrameType.AUTH_OK, flags: 0, stream_id: 0,
      payload: { session_id: this.sessionId, device_id: device.id, role: device.role, ...this.hints() },
    }, undefined, () => {
      if (!devices.has(device.id)) { this.close("auth_revoked"); return; }
      // stream frames came for a device that had no row when AUTH came (an account pull let it in since): they were
      // not kept, so the phone's streams cannot start where it thinks; it signs in again, and then they are held
      if (this.held && !this.held.known && this.held.count > 0) { this.close("auth_changed"); return; }
      const held = this.held?.frames ?? [];
      this.held = undefined;
      this.mux.authenticate(device.id);
      this.state = "ready";
      this.options.onAuthenticated?.(device.id);
      // what came behind AUTH, read now that it holds, in order, before AUTH_OK goes out
      for (const data of held) {
        if (!this.mux.active) return;
        this.receive(data);
      }
    });
  }

  /** HTTP and WebSocket are every stream a signed-in client opens (SSE rides HTTP): the first of either marks this carrier as the one kept. */
  private choose(): void {
    if (this.chosen || this.state !== "ready") return;
    this.chosen = true;
    this.options.onChosen?.();
  }

  private principal(): DeviceMatch | undefined {
    if (this.state === "closed") return;
    if (this.state !== "ready" || !this.device) { this.close("protocol_error"); return; }
    if (!this.options.services.devices.has(this.device.id)) { this.close("auth_revoked"); return; }
    return this.device;
  }

  private async websocket(stream: WsStream, exchange: RelayWebSocketRequest): Promise<void> {
    try {
      const response = await (this.options.dispatch ?? handleRequest)(exchange.request, exchange.context);
      if (!stream.live || this.state !== "ready") {
        exchange.upgrade?.data.relay?.close();
        await response?.body?.cancel();
        return;
      }
      const handlers = this.options.websocket;
      if (exchange.upgrade && handlers) {
        const socket = new VirtualSocket(exchange.upgrade.data, stream, handlers);
        this.sockets.set(stream, socket);
        socket.open();
        return;
      }
      if (!response) { stream.reset("internal_error"); return; }
      const rejection = stream.reject(response.status, this.responseHeaders(response.headers));
      // Rejection transfers disposal to an HTTP stream; it still owns the request signal.
      if (response.body) await rejection.sendBody(response.body);
      else rejection.end();
    } catch (error) {
      exchange.upgrade?.data.relay?.close();
      if (stream.live) stream.reset(error instanceof MuxStreamError ? error.code : "internal_error");
    }
  }

  /** The response headers this phone takes. */
  private responseHeaders(headers: Headers): [string, string][] {
    const allowed: readonly string[] = RESPONSE_HEADERS;
    return [...headers].filter(([name]) => allowed.includes(name) && (name !== "x-server-time" || this.serverTime));
  }

  private context(device: DeviceMatch, timeout: ServerContext["timeout"], upgrade: ServerContext["upgrade"],
    relayBodyBudget?: EventStreamBudget): ServerContext {
    return {
      services: this.options.services, port: this.options.port, requestIP: () => null, timeout, upgrade,
      peer: { kind: "relay", device, sessionId: this.sessionId, serverId: this.options.serverId, key: this.key }, relayBodyBudget,
    };
  }

  private async http(stream: HttpStream): Promise<void> {
    const device = this.principal();
    if (!device) { stream.reset("refused"); return; }
    this.requests.add(stream);
    const abort = new AbortController();
    let timer: (() => void) | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let held = 0;
    let queued = 0;
    let seconds = 60;
    const touch = () => {
      timer?.();
      timer = seconds > 0 ? this.clock.setTimeout(() => stream.reset("upstream_lost"), seconds * 1000) : undefined;
    };
    const timeout: ServerContext["timeout"] = (_request, budget) => { seconds = budget; touch(); };
    const id = stream.id;
    if (id !== undefined) this.activity.set(id, touch);
    const budget: EventStreamBudget = {
      reserve: (bytes) => {
        if (queued + bytes > SOURCE_LIMIT || this.sourceBytes + bytes + this.mux.stats.accountedBytes > SESSION_LIMIT) {
          stream.reset("resource_exhausted");
          return false;
        }
        queued += bytes;
        this.sourceBytes += bytes;
        return true;
      },
      release: (bytes) => { queued -= bytes; this.sourceBytes -= bytes; },
    };
    stream.onDispose = async () => {
      this.requests.delete(stream);
      timer?.();
      if (id !== undefined) this.activity.delete(id);
      abort.abort();
      await reader?.cancel();
    };
    touch();
    try {
      const request = new Request(RELAY_ORIGIN + stream.request.target, {
        method: stream.request.method, headers: relayHeaders(stream.request.headers),
        body: stream.request.body === "stream" ? stream.body : undefined, signal: abort.signal,
      });
      const context = this.context(device, timeout, () => false, budget);
      if (stream.request.body === "stream") stream.accept();
      const response = await (this.options.dispatch ?? handleRequest)(request, context);
      // The engine may have answered an unknown-length upload with 413 while dispatch was reading it.
      if (!stream.live || stream.final) { await response?.body?.cancel(); return; }
      if (!response) { stream.reset("internal_error"); return; }
      reader = response.body?.getReader();
      stream.headers(response.status, this.responseHeaders(response.headers));
      if (!stream.live) return;
      if (!reader || stream.noBody) {
        await reader?.cancel();
        stream.end();
        return;
      }
      while (stream.live) {
        const chunk = await reader.read();
        if (!stream.live) return;
        if (chunk.done) { stream.end(); return; }
        held = chunk.value.byteLength;
        if (held + this.sourceBytes + this.mux.stats.accountedBytes > SESSION_LIMIT) {
          held = 0;
          stream.reset("resource_exhausted");
          return;
        }
        this.sourceBytes += held;
        for (let offset = 0; offset < chunk.value.byteLength && stream.live; offset += WS_CONTINUATION_CAPACITY) {
          await stream.write(chunk.value.subarray(offset, offset + WS_CONTINUATION_CAPACITY));
        }
        this.sourceBytes -= held;
        held = 0;
      }
    } catch (error) {
      if (stream.live) stream.reset(error instanceof MuxStreamError ? error.code : "internal_error");
    } finally {
      this.sourceBytes -= held;
      reader?.releaseLock();
      reader = undefined;
    }
  }
}

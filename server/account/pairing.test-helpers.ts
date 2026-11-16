/**
 * A PC for the pairing tests of this folder: the server on a state folder of its own and a free port, the test
 * account service, and its relay turned on over a socket that never opens, so codes are made as on a PC whose relay
 * is connecting and nothing leaves this process. Its owner's calls go over HTTP as the app's own controls do;
 * devices come through the relay's test harness (server/relay/test-helpers.ts).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import type { HttpRequest } from "../../shared/relay-mux-engine.ts";
import type { SessionError } from "../../shared/relay-mux.ts";
import { decodeOffer } from "../../shared/relay-offer.ts";
import { readDeviceRegistry } from "../devices.ts";
import { createServer } from "../index.ts";
import { RelayService } from "../relay/service.ts";
import { bounded, relayConnection } from "../relay/test-helpers.ts";

/** The relay id the harness's sessions sign in to (relayConnection), which a link names. */
export const SERVER_ID = "0123456789abcdef0123456789abcdef";

function idleSocket(): WebSocket {
  return Object.assign(new EventTarget(), { binaryType: "arraybuffer", readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onerror: null, onclose: null }) as unknown as WebSocket;
}

export interface Body {
  error?: { code: string; message: string };
  url?: string;
  code?: string;
  account?: string | null;
  members?: number;
  unlinked?: string[];
  blocked?: string[];
  cancelled?: boolean;
  devices?: { id: string; label: string; role: string; account?: string }[];
  [field: string]: unknown;
}

export interface Answer { status: number; headers: Headers; body: Body }

export type Pc = Awaited<ReturnType<typeof pairingPc>>;
export type Link = Awaited<ReturnType<typeof relayConnection>>;
type SessionOptions = Parameters<typeof relayConnection>[1];

export interface Phone { keys: CryptoKeyPair; spki: string }

/** A device's key: the one it pairs and signs in with, which a signed-in app's is its account key. */
export async function phone(): Promise<Phone> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

/** A drive member of `account` as devices.json holds one: written before a PC starts (`rows`), it makes that PC one in the account. */
export async function memberRow(account: string) {
  const key = await phone();
  const row = { id: randomBytes(8).toString("hex"), label: "Account phone", role: "drive", token_hash: randomBytes(32).toString("hex"),
    relay_public_key: key.spki, account, created_at: new Date().toISOString(), last_seen_at: null };
  return { row, key };
}

export async function pairingPc(options: { rows?: readonly { created_at: string }[] } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-pairing-"));
  const first = options.rows?.[0];
  if (first) writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ gate_closed_at: first.created_at, devices: options.rows }), { mode: 0o600 });
  const account = new FakeAccountService();
  const service = new RelayService({ stateDir, relay: "wss://relay.test", connect: () => idleSocket() });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, relay: service,
    accountService: { url: "https://account.test", fetch: account.fetch } });
  const base = `http://127.0.0.1:${app.port}`;
  const closes: (() => void)[] = [];
  /** A call from this PC itself: its own origin, and no credential. */
  const local = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Answer> => {
    const response = await fetch(base + path, {
      method: init.method ?? "GET",
      headers: { origin: base, ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text === "" ? {} : JSON.parse(text) as Body };
  };
  const relayControl = (path: string, headers: Record<string, string> = {}) => local(path, { method: "POST", headers: { "x-herdr-update": "1", ...headers } });
  const offered = async (headers: Record<string, string> = {}): Promise<string> => {
    const offer = await relayControl("/api/relay/offer", headers);
    const code = typeof offer.body.url === "string" ? decodeOffer(offer.body.url)?.code : undefined;
    if (offer.status !== 200 || code === undefined) throw new Error(`The offer gave no code: ${offer.status} ${JSON.stringify(offer.body)}`);
    return code;
  };
  const started = await relayControl("/api/relay/start");
  if (started.status !== 200) throw new Error(`The relay did not start: ${JSON.stringify(started.body)}`);
  return {
    stateDir, app, closes, local,
    devices: app.context.services.devices,
    /** The code of the relay tab's QR code: POST /api/relay/offer with `x-ovis-no-account-only`. */
    tabCode: () => offered({ "x-ovis-no-account-only": "1" }),
    /** The code of an offer asked for with no header and with no pairing started first: the first-run guide's QR code, a phone's Connect another device. */
    offerCode: () => offered(),
    /** The code `ovis pair` shows: a pairing started on this PC, carried by a relay offer asked for with no header. */
    async startedCode(): Promise<string> {
      const pairing = await local("/api/devices/pair/start", { method: "POST", headers: { "x-herdr-machine": "1" }, body: {} });
      if (pairing.status !== 200) throw new Error(`No pairing was started: ${pairing.status} ${JSON.stringify(pairing.body)}`);
      return offered();
    },
    status: async () => (await local("/api/account/status")).body,
    listed: async () => (await local("/api/devices")).body.devices ?? [],
    stored: () => {
      const registry = readDeviceRegistry(join(stateDir, "devices.json"));
      return registry.kind === "ok" ? registry.devices : [];
    },
    async close() {
      for (const end of closes.splice(0)) end();
      await service.shutdown();
      app.stop();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/**
 * PAIR with `code` as a device that names `device`'s key: the row id and the role its answer gave, with the session
 * that paired; or the error the PC ended the session with.
 */
export async function pair(pc: Pc, code: string, device: Phone, options: SessionOptions = {}): Promise<{ id: string; role: string; link: Link } | { error: SessionError }> {
  const link = await relayConnection(pc, options);
  const payload = await link.pair(code, device.spki).then((admitted) => admitted, () => null);
  if (payload === null) return { error: await bounded(link.serverError) };
  return { id: payload.device_id, role: payload.role, link };
}

/** AUTH as the row `id` with `device`'s key, on a connection of its own: the session, or the error the PC ended it with. */
export async function signIn(pc: Pc, id: string, device: Phone, options: SessionOptions = {}, features: readonly string[] = []): Promise<{ link: Link; role: string; direct: readonly string[] | undefined } | { error: SessionError }> {
  const link = await relayConnection(pc, options);
  const payload = await link.auth({ id, keys: device.keys, publicKey: device.spki }, features).then((admitted) => admitted, () => null);
  if (payload === null) return { error: await bounded(link.serverError) };
  return { link, role: payload.role, direct: payload.direct };
}

/**
 * A device that paired with `code` and signed in on a connection of its own, as the app does before its account
 * steps: `pairing` is the session its PAIR made, `session` the one that proved its key by AUTH.
 */
export async function signedInWith(pc: Pc, code: string, key?: Phone, options: SessionOptions = {}) {
  const device = key ?? await phone();
  const made = await pair(pc, code, device, options);
  if ("error" in made) throw new Error(`The pairing was refused: ${made.error}`);
  const session = await signIn(pc, made.id, device, options);
  if ("error" in session) throw new Error(`The sign-in was refused: ${session.error}`);
  return { id: made.id, key: device, role: made.role, pairing: made.link, session: session.link };
}

/** A link that makes the row `id` a member of `account`: it moves the row from `from` to `to` (the same key keeps it). */
export function linkRecord(id: string, account: string, from: Phone, to: Phone = from) {
  return signAccountRecord({ v: 1, kind: "link", account, key: to.spki, server_id: SERVER_ID, device_id: id, old_key: from.spki,
    issued_at: new Date().toISOString(), id: newRecordId(), signer: to.spki }, to.keys.privateKey);
}

const guard = [["content-type", "application/json"], ["x-herdr-machine", "1"]] as const;

export async function ask(link: Link, target: string, init: { method?: HttpRequest["method"]; body?: unknown } = {}): Promise<Answer> {
  const request = link.open(target, { method: init.method ?? "GET", headers: init.body === undefined ? [] : guard, body: init.body === undefined ? "none" : "stream" });
  if (init.body !== undefined) void request.stream.sendBody(new Blob([JSON.stringify(init.body)]).stream()).catch(() => {});
  const response = await request.response;
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === "" ? {} : JSON.parse(text) as Body };
}

export function sendLink(link: Link, record: unknown): Promise<Answer> {
  return ask(link, "/api/account/link", { method: "POST", body: { record } });
}

export function ended(link: Link): Promise<SessionError> {
  return bounded(link.serverError);
}

/**
 * One-time invites and enrolment (docs/fleet-link.md section 4). A mint makes up to MAX_INVITES_PER_MINT invites in one
 * batch, at most MAX_OPEN_INVITES open at once; each invite file holds 32 random bytes of secret, from which both ends
 * derive an Ed25519 key. The store (server/fleet/store.ts) keeps only the id, slot, name, expiry, batch and the
 * derived public key: the secret exists here only while the files of the mint's answer are made, and never reaches the
 * store, a log or a later answer. So an invite minted before a restart is redeemed after it, and a copy of the store
 * enrols nothing.
 *
 * ENROLL is checked in the order of the document: the id, the expiry, then the signature over this session's channel
 * binding (the try budget refuses only an ENROLL whose signature does not hold, so a valid one is never locked out); only then does the admission queue decide against the store as it is at that moment, one
 * request after another, and write every decision of a turn of the queue at once: a wave of enrolments neither loses
 * one nor admits one twice, and costs one store write per turn rather than one per machine. An invite stops admitting
 * a new key the moment it is used or expires; the same key again gets the same answer; a second key quarantines the
 * slot (both keys refused) and raises an alert. A refusal changes nothing on disk: the try budgets live in memory.
 *
 * A machine enrolled this way is `pending`: it signs in, but no pipe is opened to it and no roster row shows it until
 * the operator confirms its batch once, with the count and digest the batch list showed.
 */
import { createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign as signBytes, timingSafeEqual } from "node:crypto";
import { isDirectCarrier } from "../../shared/relay-mux.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { MAX_MACHINE_CARRIERS } from "./direct.ts";
import { machineFingerprint } from "./mux-ext.ts";
import type { MachineCause } from "./mux-ext.ts";
import { loadOwnerKey, OwnerError, ownerKeyPath, parseOwner } from "./owner.ts";
import type { OwnerBlock, OwnerKey } from "./owner.ts";
import { DEFAULT_RETENTION_S, fleetMachine, FleetStoreError } from "./store.ts";
import type { FleetDocument, FleetMachine, FleetStore, StoredBatch, StoredInvite } from "./store.ts";

/** Invites one mint makes at most. */
export const MAX_INVITES_PER_MINT = 256;
/** Invites unused and not expired at once, across every batch. */
export const MAX_OPEN_INVITES = 1024;
export const DEFAULT_INVITE_LIFE_S = 60 * 60;
export const MAX_INVITE_LIFE_S = 24 * 60 * 60;
/** `enroll_tries_per_invite` of the limits table: refused ENROLLs for one invite before it is refused `rate_limited`. */
export const ENROLL_TRIES_PER_INVITE = 5;
/**
 * Refused ENROLLs one source address of a direct carrier may make in ENROLL_ADDRESS_WINDOW_MS before every ENROLL from it
 * is refused `rate_limited` until the window ends. Only refusals count, so a wave of machines behind one address
 * enrols; the relay hides addresses, and there the per-invite budget and the relay's own limits hold.
 */
export const ENROLL_FAILURES_PER_ADDRESS = 20;
export const ENROLL_ADDRESS_WINDOW_MS = 10 * 60_000;
/** Addresses whose refusals are remembered at once; the oldest window goes first past it. */
const MAX_TRACKED_ADDRESSES = 4096;
/** How long an invite stays listed past its expiry, unless a machine it admitted still names it. */
export const KEEP_EXPIRED_MS = 24 * 60 * 60_000;
export const MAX_INVITE_BYTES = 4096;
const ENROLL_DOMAIN = "ovis-fleet-enroll/1";
const INVITE_INFO = "ovis-fleet-invite/1";
/** RFC 8410: an Ed25519 private key's PKCS#8 DER is this prefix and the 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const NAME_PREFIX = /^[A-Za-z0-9._-]{0,32}$/;

/** The invite file of section 4, in field-table order. */
export interface Invite {
  readonly v: 1;
  readonly id: string;
  readonly slot: number;
  readonly controller: { readonly server_id: string; readonly server_public_key: string; readonly relay: string | null; readonly direct: readonly string[] };
  /** The fleet's owner key and the controller as its first member, signed by it (docs/fleet-link.md, "Owner key and members"). */
  readonly owner: OwnerBlock;
  readonly secret: string;
  readonly exp: number;
}
export type InviteController = Invite["controller"];

export class InviteError extends Error {
  readonly code = "invalid_invite";
  constructor(message: string) {
    super(message);
    this.name = "InviteError";
  }
}

/** Why a mint, a list or a confirm was refused; each is one code of the fleet routes (shared/fleet-cause.ts). */
export class FleetRouteError extends Error {
  constructor(readonly code: "invalid_request" | "too_many_invites" | "fleet_unavailable" | "owner_key_missing" | "unknown_batch" | "batch_changed" | "fleet_store_unreadable" | "fleet_store_busy" | "fleet_token_required"
    | "unknown_invite" | "unknown_machine" | "unknown_slot" | "slot_not_quarantined" | "not_removed" | "not_restored" | "restore_changed"
    | "witness_write_failed" | "witness_full", message: string) {
    super(message);
    this.name = "FleetRouteError";
  }
}

/** The invite's Ed25519 key: its RFC 8032 seed is HKDF-SHA256(secret, no salt, "ovis-fleet-invite/1" || id, 32). */
export function inviteKey(secret: Uint8Array, id: string): { readonly seed: Uint8Array; readonly publicKey: Uint8Array; sign(message: Uint8Array): Uint8Array } {
  const seed = new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(0), Buffer.from(`${INVITE_INFO}${id}`), 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return { seed, publicKey: new Uint8Array(spki.subarray(spki.length - 32)), sign: (message) => new Uint8Array(signBytes(null, message, privateKey)) };
}

/** The signed bytes of ENROLL: domain, this session's channel binding, the machine key's SPKI DER, the invite id as ASCII. */
export function enrollMessage(binding: Uint8Array, spki: Uint8Array, id: string): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(ENROLL_DOMAIN), binding, spki, Buffer.from(id)]));
}

const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A DNS name an invite may name in `direct` (the agent dials it only where it resolves to a private address); never an IP. */
function hostName(host: string): boolean {
  return HOST_NAME.test(host) && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}
/** `ws://<host>:<port>` an invite may name: a direct carrier (private or Tailscale IPv4) or a DNS name, a port written out. */
export function inviteCarrier(text: string): boolean {
  if (isDirectCarrier(text)) return true;
  const match = /^ws:\/\/([^:/]+):([1-9]\d{0,4})$/.exec(text);
  return match !== null && Number(match[2]) <= 65535 && hostName(match[1]!);
}

/** A `wss:` origin as an invite names its relay: no path, query, credentials or port 443 written out. */
function relayOrigin(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "wss:" && url.origin === text && /^[a-z0-9.-]+$/.test(url.hostname);
  } catch { return false; }
}

const canonical64 = (text: unknown, bytes: number, url: boolean): text is string => {
  if (typeof text !== "string") return false;
  const decoded = Buffer.from(text, url ? "base64url" : "base64");
  return decoded.length === bytes && decoded.toString(url ? "base64url" : "base64") === text;
};

/**
 * An invite file's bytes as section 4 takes them, or InviteError `invalid_invite`: anything that breaks a rule refuses
 * the file whole. Keys it does not know are dropped, as a decoder of this contract does.
 */
export function parseInvite(bytes: Uint8Array): Invite {
  const refuse = (why: string): never => { throw new InviteError(`invalid invite: ${why}`); };
  if (bytes.length > MAX_INVITE_BYTES) refuse(`more than ${MAX_INVITE_BYTES} bytes`);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { refuse("not JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse("not an object");
  const v = value as Record<string, unknown>;
  if (v["v"] !== 1) refuse("not version 1");
  const id = v["id"];
  if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) refuse("id is not 16 hex digits");
  const slot = v["slot"];
  if (!(typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot <= 65535)) refuse("slot is not 0..65535");
  const c = v["controller"];
  if (typeof c !== "object" || c === null || Array.isArray(c)) refuse("controller is not an object");
  const controller = c as Record<string, unknown>;
  const key = controller["server_public_key"];
  if (!canonical64(key, 32, false)) refuse("server_public_key is not 32 bytes of base64");
  if (controller["server_id"] !== deriveServerId(Buffer.from(key as string, "base64"))) refuse("server_id is not the one its key derives");
  const relay = controller["relay"];
  if (relay !== null && !(typeof relay === "string" && relayOrigin(relay))) refuse("relay is not a wss: origin or null");
  const direct = controller["direct"];
  if (!Array.isArray(direct) || direct.length > MAX_MACHINE_CARRIERS || !direct.every((entry) => typeof entry === "string" && inviteCarrier(entry)) || new Set(direct).size !== direct.length) refuse("direct is not up to 4 distinct direct carriers");
  if (relay === null && (direct as unknown[]).length === 0) refuse("it names no carrier");
  const pinned = { server_id: controller["server_id"] as string, server_public_key: key as string, relay: relay as string | null, direct: direct as string[] };
  let owner: OwnerBlock;
  try { owner = parseOwner(v["owner"], pinned); }
  catch (error) { if (error instanceof OwnerError) refuse(error.message); throw error; }
  if (!canonical64(v["secret"], 32, true)) refuse("secret is not 32 bytes of base64url");
  const exp = v["exp"];
  if (!(typeof exp === "number" && Number.isSafeInteger(exp) && exp >= 0)) refuse("exp is not seconds");
  return { v: 1, id: id as string, slot: slot as number, controller: pinned, owner: owner!, secret: v["secret"] as string, exp: exp as number };
}

/** The single-line form of an invite file (docs/fleet-link.md section 4): this prefix and the file in base64url. */
export const INVITE_LINE_PREFIX = "ovis-invite:1:";
/** The prefix and MAX_INVITE_BYTES of file in unpadded base64url: 5476 bytes. */
export const MAX_INVITE_LINE_BYTES = INVITE_LINE_PREFIX.length + Math.ceil(MAX_INVITE_BYTES * 4 / 3);

/** The line of an invite file's exact bytes: the line holds the secret, as the file does. */
export function inviteLine(file: Uint8Array): string {
  return `${INVITE_LINE_PREFIX}${Buffer.from(file).toString("base64url")}`;
}

/**
 * The invite file's bytes a line holds, or InviteError `invalid_invite`: the ASCII whitespace around it dropped, at most
 * MAX_INVITE_LINE_BYTES, exactly INVITE_LINE_PREFIX, then canonical unpadded base64url (no padding, no other symbol, the
 * unused bits of the last symbol zero). Nothing of the invite is judged here: the bytes go to parseInvite as a file does.
 */
export function inviteLineBytes(line: string): Uint8Array {
  const refuse = (why: string): never => { throw new InviteError(`invalid invite line: ${why}`); };
  const text = line.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (text.length > MAX_INVITE_LINE_BYTES) refuse(`more than ${MAX_INVITE_LINE_BYTES} bytes`);
  if (!text.startsWith(INVITE_LINE_PREFIX)) refuse(`it does not start with ${INVITE_LINE_PREFIX}`);
  const body = text.slice(INVITE_LINE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || body.length % 4 === 1) refuse("not base64url");
  const bytes = Buffer.from(body, "base64url");
  if (bytes.toString("base64url") !== body) refuse("not canonical base64url");
  return new Uint8Array(bytes);
}

/** An invite given as its line: the file it decodes to, read by parseInvite. */
export const parseInviteLine = (line: string): Invite => parseInvite(inviteLineBytes(line));

/** The fingerprint as a person compares it: the 32 hex digits of the machine id in groups of four. */
export const groupedFingerprint = (machineId: string): string => machineId.match(/.{4}/g)!.join(" ");
/** SHA-256 over the batch's full fingerprints (each 32 ASCII hex digits, fixed length), sorted, as 64 hex digits. */
export const batchDigest = (machineIds: readonly string[]): string => createHash("sha256").update([...machineIds].sort().join("")).digest("hex");

/** What ENROLL carries (the codec of server/fleet/mux-ext.ts checked its shape). */
export interface EnrollRequest {
  readonly invite_id: string;
  readonly machine_public_key: string;
  readonly signature: string;
  readonly now: number;
}
export type EnrollResult = { readonly machineId: string }
  | { readonly code: "auth_failed" | "auth_revoked" | "resource_exhausted"; readonly cause: MachineCause };

/**
 * Raised when a slot or a machine is quarantined (todo 33 shows it; the server log has it as `fleet.quarantined`), and
 * (`alert`, todo 31) when the switch window's PING ended one of two sessions of a key while the other answered: a copy
 * of the key whose holder stays silent, or a real machine whose answer was held back. `count` is how many such events
 * the key had in the last SILENT_WINDOW_MS; at SILENT_QUARANTINE of them the key is quarantined `silent_sessions`.
 */
export interface FleetAlert {
  readonly kind: "quarantined" | "alert";
  readonly reason: "second_key" | "two_sessions" | "silent_session" | "silent_sessions";
  readonly machine_id: string | null;
  readonly slot: number | null;
  readonly invite_id: string | null;
  readonly count?: number;
}

export type InviteState = "unused" | "used" | "expired";
export interface InviteRow { readonly id: string; readonly slot: number; readonly name: string; readonly batch_id: string; readonly exp: number; readonly state: InviteState }
export interface BatchMachine { readonly machine_id: string; readonly slot: number | null; readonly name: string; readonly fingerprint: string }
export interface BatchRow {
  readonly batch_id: string;
  readonly created_at: number;
  /** machines enrolled into it and waiting for confirmation */
  readonly count: number;
  readonly machines: readonly BatchMachine[];
  readonly digest: string;
  readonly invites: { readonly unused: number; readonly used: number; readonly expired: number };
}
/**
 * `retention_s`: how long a machine of the batch may go unseen before the sweep removes it (0 keeps it; todo 31).
 * `slots_from`: a batch whose slots (and names) the new invites take, for a rebuild; the count is then the slots'.
 */
export interface MintRequest {
  readonly count: number; readonly prefix: string; readonly life_s: number; readonly direct_hosts: readonly string[];
  readonly retention_s?: number; readonly slots_from?: string;
}
export interface Minted {
  readonly batch_id: string;
  readonly count: number;
  readonly exp: number;
  readonly invites: readonly Invite[];
}

/** A mint's body as the route reads it, or FleetRouteError `invalid_request`. */
export function mintRequest(body: unknown): MintRequest {
  const bad = (why: string): never => { throw new FleetRouteError("invalid_request", why); };
  if (typeof body !== "object" || body === null || Array.isArray(body)) bad("Send a JSON object.");
  const v = body as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!["count", "prefix", "life_s", "direct_hosts", "retention_s", "slots_from"].includes(key)) bad(`Unknown field ${JSON.stringify(key)}.`);
  const retention = v["retention_s"];
  if (retention !== undefined && !(typeof retention === "number" && Number.isInteger(retention) && retention >= 0 && retention <= MAX_RETENTION_S)) bad(`retention_s is a whole number of seconds from 0 (keep forever) to ${MAX_RETENTION_S}.`);
  const from = v["slots_from"];
  if (from !== undefined && !(typeof from === "string" && /^[0-9a-f]{16}$/.test(from))) bad("slots_from is a batch id (16 hex digits).");
  if (from !== undefined && (v["count"] !== undefined || v["prefix"] !== undefined)) bad("slots_from takes the batch's slots and names: send no count or prefix with it.");
  const count = v["count"] ?? 1;
  if (!(typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= MAX_INVITES_PER_MINT)) bad(`count is a whole number from 1 to ${MAX_INVITES_PER_MINT}.`);
  const prefix = v["prefix"] ?? "machine-";
  if (typeof prefix !== "string" || !NAME_PREFIX.test(prefix)) bad("prefix is at most 32 letters, digits, dots, dashes or underscores.");
  const life = v["life_s"] ?? DEFAULT_INVITE_LIFE_S;
  if (!(typeof life === "number" && Number.isInteger(life) && life >= 60 && life <= MAX_INVITE_LIFE_S)) bad(`life_s is a whole number of seconds from 60 to ${MAX_INVITE_LIFE_S}.`);
  const hosts = v["direct_hosts"] ?? [];
  if (!Array.isArray(hosts) || hosts.length > MAX_MACHINE_CARRIERS || !hosts.every((host) => typeof host === "string" && hostName(host)) || new Set(hosts).size !== hosts.length) bad(`direct_hosts is up to ${MAX_MACHINE_CARRIERS} distinct DNS names.`);
  return {
    count: count as number, prefix: prefix as string, life_s: life as number, direct_hosts: hosts as string[],
    ...(retention === undefined ? {} : { retention_s: retention as number }), ...(from === undefined ? {} : { slots_from: from as string }),
  };
}

/** The longest retention a batch may be given: a year. */
export const MAX_RETENTION_S = 366 * 24 * 60 * 60;

/** What `POST /api/fleet/invites/withdraw` takes: one open invite, or every open invite of one batch. */
export function withdrawRequest(body: unknown): { readonly invite_id: string } | { readonly batch_id: string } {
  const v = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.length === 1 && typeof v["invite_id"] === "string" && /^[0-9a-f]{16}$/.test(v["invite_id"])) return { invite_id: v["invite_id"] };
  if (keys.length === 1 && typeof v["batch_id"] === "string" && /^[0-9a-f]{16}$/.test(v["batch_id"])) return { batch_id: v["batch_id"] };
  throw new FleetRouteError("invalid_request", "Send {invite_id} or {batch_id} (16 hex digits).");
}

/** A confirm's body, or FleetRouteError `invalid_request`. */
export function confirmRequest(body: unknown): { readonly count: number; readonly digest: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new FleetRouteError("invalid_request", "Send {count, digest} as the batch list showed them.");
  const { count, digest } = body as Record<string, unknown>;
  if (!(typeof count === "number" && Number.isInteger(count) && count >= 0) || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new FleetRouteError("invalid_request", "Send {count, digest} as the batch list showed them.");
  }
  return { count, digest };
}

const hexId = (bytes: number) => randomBytes(bytes).toString("hex");
const sameText = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** One request of the admission queue: decides against the store as it is, then hears how its turn ended. */
interface Admission {
  decide(document: FleetDocument, now: number): { document: FleetDocument; result: unknown; alert?: FleetAlert };
  resolve(result: unknown): void;
  reject(error: unknown): void;
}

export interface FleetInvitesOptions {
  /** This controller's wall clock, ms since the epoch: the only clock an invite's expiry is judged by. */
  readonly now?: () => number;
  /** Machines that are not revoked the store takes at most (OVIS_FLEET_MAX); the store's unless given. */
  readonly max?: number;
  readonly onAlert?: (alert: FleetAlert) => void;
  /**
   * Inside a store change that removes, revokes, replaces or quarantines (todo 31): writes the fleet's witness first
   * (its generation risen, `removed` fingerprints added) and returns the document with the new generation; throws, so
   * nothing changes, when the witness cannot be written. Without it (unit tests of the invites alone) nothing is witnessed.
   */
  readonly witness?: (document: FleetDocument, removed: readonly string[], quarantined?: readonly string[]) => FleetDocument;
  /**
   * What the fleet's witness says of a key (todo 31): a key it lists as removed or quarantined enrols nothing, whatever
   * the store holds (its record may be forgotten, or a restored store may not know it); the invite stays unused.
   */
  readonly listed?: (machineId: string) => "revoked" | "quarantined" | undefined;
}

export class FleetInvites {
  private readonly now: () => number;
  private readonly max: number;
  /** refused ENROLLs per invite id, in memory only: a refusal writes nothing */
  private readonly tries = new Map<string, number>();
  /** refused ENROLLs per source address of a direct carrier, each with when its window ends */
  private readonly addresses = new Map<string, { count: number; until: number }>();
  private readonly queue: Admission[] = [];
  private draining = false;

  constructor(readonly store: FleetStore, private readonly options: FleetInvitesOptions = {}) {
    this.now = options.now ?? Date.now;
    this.max = options.max ?? store.max;
  }

  /** Invites unused and not expired now: while there is one, the fleet is in use (server/fleet/direct.ts). */
  openInvites(now = this.now()): number {
    try { return this.store.document().invites.filter((entry) => entry.used_by === null && entry.exp * 1000 > now).length; }
    catch { return 0; }
  }

  /** Every invite still listed, with its state, by slot. */
  list(now = this.now()): InviteRow[] {
    return [...this.store.document().invites].sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id)).map((entry) => ({
      id: entry.id, slot: entry.slot, name: entry.name, batch_id: entry.batch_id, exp: entry.exp,
      state: entry.used_by !== null ? "used" : entry.exp * 1000 <= now ? "expired" : "unused",
    }));
  }

  /** The batch each machine enrolled through, by machine id (for its row). */
  batchOf(document: FleetDocument = this.store.document()): Map<string, string> {
    const batches = new Map(document.invites.map((entry) => [entry.id, entry.batch_id]));
    const found = new Map<string, string>();
    for (const machine of document.machines) {
      const batchId = machine.invite_id === null ? undefined : batches.get(machine.invite_id);
      if (batchId !== undefined) found.set(machine.machine_id, batchId);
    }
    return found;
  }

  /** Each batch with machines waiting for confirmation: their slots, names and fingerprints, the count and the digest. */
  batches(now = this.now()): BatchRow[] {
    const document = this.store.document();
    return document.batches.map((entry) => batchRow(document, entry, now)).filter((row) => row.count > 0);
  }

  /**
   * Mints `request.count` invites in a new batch and answers their files, the only place a secret ever goes. The batch
   * is stored first (the fleet is then in use, so the bridge listeners open), then `describe` names this controller as
   * a machine must reach it; with no carrier at all the batch is taken back and FleetRouteError `fleet_unavailable`.
   * Earlier invites are never touched: two mints side by side both stand.
   */
  async mint(request: MintRequest, describe: () => Promise<InviteController | null>): Promise<Minted> {
    // the fleet is turned on by its own step, never by a mint: no owner key, no invite
    let owner: OwnerKey | undefined;
    try { owner = loadOwnerKey(ownerKeyPath(this.store.path)); }
    catch { throw new FleetRouteError("fleet_store_unreadable", "The fleet's owner key cannot be read; mend or move <state>/fleet/owner.json away."); }
    if (!owner) throw new FleetRouteError("owner_key_missing", "Turn the fleet on first: run `ovis-server fleet owner` on this controller. It makes the fleet's owner key and shows its recovery phrase once.");
    if (!await describe()) throw new FleetRouteError("fleet_unavailable", "Turn on remote access first: an invite names the relay or a direct address of this controller.");
    const now = this.now();
    const exp = Math.floor(now / 1000) + request.life_s;
    const batchId = hexId(8);
    const secrets: Buffer[] = [];
    const reserved = this.write((document) => {
      const kept = prune(document, now);
      const open = kept.invites.filter((entry) => entry.used_by === null && entry.exp * 1000 > now).length;
      // a rebuild (`slots_from`): every slot of that batch again, under its name; a machine that enrols on one replaces the slot's key
      const wanted = request.slots_from === undefined ? undefined : slotsOf(kept, request.slots_from, now);
      const count = wanted?.length ?? request.count;
      if (open + count > MAX_OPEN_INVITES) {
        throw new FleetRouteError("too_many_invites", `At most ${MAX_OPEN_INVITES} invites are open at once (${open} are). Wait until some are used or expire.`);
      }
      const taken = new Set([...kept.invites.map((entry) => entry.slot), ...kept.machines.flatMap((machine) => machine.slot === null ? [] : [machine.slot])]);
      const ids = new Set(kept.invites.map((entry) => entry.id));
      const made: StoredInvite[] = [];
      const add = (slot: number, name: string) => {
        let id = hexId(8);
        while (ids.has(id)) id = hexId(8);
        ids.add(id);
        const secret = randomBytes(32);
        secrets.push(secret);
        made.push({ id, slot, name, batch_id: batchId, public_key: Buffer.from(inviteKey(secret, id).publicKey).toString("hex"), exp, used_by: null, created_at: now });
      };
      if (wanted) for (const { slot, name } of wanted) add(slot, name);
      else for (let slot = 0; slot <= 65535 && made.length < request.count; slot++) if (!taken.has(slot)) add(slot, `${request.prefix}${slot}`);
      if (made.length < count) throw new FleetRouteError("too_many_invites", "No free slot is left.");
      const from = request.slots_from === undefined ? undefined : kept.batches.find((entry) => entry.id === request.slots_from);
      const retention = request.retention_s ?? from?.retention_s ?? DEFAULT_RETENTION_S;
      return { document: { ...kept, invites: [...kept.invites, ...made], batches: [...kept.batches, { id: batchId, created_at: now, retention_s: retention }] }, result: made };
    });
    try {
      const controller = await describe();
      const direct = controller ? [...new Set([...controller.direct, ...request.direct_hosts.map((host) => `ws://${host}:${directPort(controller.direct)}`)])] : [];
      if (!controller || request.direct_hosts.length && directPort(controller.direct) === null) {
        this.takeBack(batchId);
        throw new FleetRouteError("fleet_unavailable", request.direct_hosts.length ? "A direct host needs this controller's direct connections on." : "Turn on remote access first.");
      }
      const named: InviteController = { server_id: controller.server_id, server_public_key: controller.server_public_key, relay: controller.relay, direct: direct.slice(0, MAX_MACHINE_CARRIERS) };
      if (named.relay === null && named.direct.length === 0) {
        this.takeBack(batchId);
        throw new FleetRouteError("fleet_unavailable", "This controller has neither a relay nor a direct address a machine could reach.");
      }
      const block = owner.block({ server_id: named.server_id, server_public_key: named.server_public_key });
      const invites = reserved.map((entry, index): Invite => ({ v: 1, id: entry.id, slot: entry.slot, controller: named, owner: block, secret: secrets[index]!.toString("base64url"), exp: entry.exp }));
      return { batch_id: batchId, count: invites.length, exp, invites };
    } finally {
      for (const secret of secrets) secret.fill(0);
    }
  }

  /** Confirms a batch: exactly the machines the operator was shown (their count and digest) become `active`. */
  confirm(batchId: string, count: number, digest: string): Promise<{ readonly batch_id: string; readonly activated: readonly string[] }> {
    return this.admit((document, now) => {
      const entry = document.batches.find((candidate) => candidate.id === batchId);
      if (!entry) throw new FleetRouteError("unknown_batch", "No batch has that id.");
      const row = batchRow(document, entry, now);
      if (row.count === 0 || row.count !== count || !sameText(row.digest, digest)) {
        throw new FleetRouteError("batch_changed", "The batch changed since it was read: read it again and check its machines.");
      }
      const ids = new Set(row.machines.map((machine) => machine.machine_id));
      const machines = document.machines.map((machine) => ids.has(machine.machine_id) ? { ...machine, state: "active" as const, updated_at: now } : machine);
      return { document: { ...document, machines }, result: { batch_id: batchId, activated: [...ids].sort() } };
    });
  }

  /**
   * An ENROLL on a session whose channel binding is `binding` (and, on a direct carrier, from `source`): checked in the
   * document's order, then decided in the admission queue against the store as it is.
   */
  async enroll(request: EnrollRequest, context: { readonly binding: Uint8Array; readonly source?: string }): Promise<EnrollResult> {
    const now = this.now();
    if (context.source !== undefined && this.addressSpent(context.source, now)) return { code: "auth_failed", cause: "rate_limited" };
    let document: FleetDocument;
    try { document = this.store.document(); } catch { return { code: "auth_failed", cause: "unknown" }; }
    // an invite id is no secret (the operator's lists show it): a map finds it without a scan per ENROLL of a flood
    const found = document.invites.find((entry) => entry.id === request.invite_id);
    const refused = (cause: MachineCause): EnrollResult => {
      if (found) this.tries.set(found.id, (this.tries.get(found.id) ?? 0) + 1);
      if (context.source !== undefined) this.addressRefused(context.source, now);
      return { code: "auth_failed", cause };
    };
    if (!found) return refused("unknown");
    if (found.exp * 1000 <= now) return refused("expired");
    const spki = Buffer.from(request.machine_public_key, "base64url");
    let verified = false;
    try {
      const key = await crypto.subtle.importKey("raw", Buffer.from(found.public_key, "hex"), { name: "Ed25519" }, false, ["verify"]);
      verified = await crypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(request.signature, "base64url"), new Uint8Array(enrollMessage(context.binding, spki, found.id)));
      // a key that is not a P-256 point could never sign in: refused as a signature that does not hold (section 1 causes)
      if (verified) await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    } catch (error) {
      if (!(error instanceof DOMException) && !(error instanceof TypeError)) throw error;
      verified = false;
    }
    // the budget refuses only what does not hold: whoever knows an invite id (its lists show it) cannot lock the real
    // machine out. A refusal still costs one Ed25519 check, bounded by the sessions a carrier admits (one ENROLL each,
    // after a Noise handshake that costs more) and, on a direct carrier, by the per-address budget checked first.
    if (!verified || context.binding.length !== 32) {
      if ((this.tries.get(found.id) ?? 0) >= ENROLL_TRIES_PER_INVITE) return { code: "auth_failed", cause: "rate_limited" };
      return refused("signature");
    }
    try {
      return await this.admit((current, at) => this.decide(current, at, found.id, request.machine_public_key));
    } catch (error) {
      // a store that cannot be written admits nobody, and the machine tries again later
      if (error instanceof FleetRouteError) return { code: "auth_failed", cause: error.code === "fleet_token_required" ? "fleet_token_required" : "unknown" };
      throw error;
    }
  }

  /** The admission of one verified ENROLL, against the store as it is now. */
  private decide(document: FleetDocument, now: number, inviteId: string, spki: string): { document: FleetDocument; result: EnrollResult; alert?: FleetAlert } {
    const same = { document, result: undefined as unknown as EnrollResult };
    const entry = document.invites.find((candidate) => candidate.id === inviteId);
    if (!entry) return { ...same, result: { code: "auth_failed", cause: "unknown" } };
    const machineId = machineFingerprint(Buffer.from(spki, "base64url"));
    // a removed or quarantined key comes back only by the operator's own re-admission or release, never by an invite
    const listed = this.options.listed?.(machineId);
    if (listed) return { ...same, result: { code: "auth_revoked", cause: listed } };
    if (entry.used_by === null) {
      // an invite stops admitting a new key the moment it expires, on this controller's clock
      if (entry.exp * 1000 <= now) return { ...same, result: { code: "auth_failed", cause: "expired" } };
      const known = document.machines.find((machine) => machine.machine_id === machineId);
      // a key already enrolled (another invite) or removed: this invite admits a new key only
      if (known) return { ...same, result: known.state === "revoked" || known.state === "quarantined" ? { code: "auth_revoked", cause: known.state } : { code: "auth_failed", cause: "signature" } };
      // the slot's present key (a rebuild's invite, `slots_from`): replaced, unless the slot is held in quarantine, which
      // only the operator releases (POST /api/fleet/slots/<slot>/release); a quarantine is never lifted by a new key
      const holders = document.machines.filter((machine) => machine.slot === entry.slot && machine.state !== "revoked");
      if (holders.some((machine) => machine.state === "quarantined")) return { ...same, result: { code: "auth_revoked", cause: "quarantined" } };
      if (document.machines.filter((machine) => machine.state !== "revoked" && !holders.includes(machine)).length >= this.max) return { ...same, result: { code: "resource_exhausted", cause: "controller_limit" } };
      const made: FleetMachine = fleetMachine({
        machine_id: machineId, public_key: spki, state: "pending", slot: entry.slot, invite_id: entry.id, runtime_id: null, name: entry.name, created_at: now, updated_at: now, seen_at: null,
      });
      const invites = document.invites.map((candidate) => candidate === entry ? { ...entry, used_by: spki } : candidate);
      const machines = document.machines.map((machine) => holders.includes(machine) ? { ...machine, state: "revoked" as const, updated_at: now } : machine);
      const next = { ...document, machines: [...machines, made], invites };
      if (!holders.length) return { document: next, result: { machineId } };
      // the old key is revoked and listed in the witness before the store names the new one (todo 31)
      const witnessed = this.options.witness ? this.options.witness(next, holders.map((machine) => machine.machine_id)) : next;
      for (const old of holders) console.error(JSON.stringify({ event: "fleet.re-enrolled", slot: entry.slot, name: entry.name, old_machine_id: old.machine_id, machine_id: machineId, invite_id: entry.id }));
      return { document: witnessed, result: { machineId } };
    }
    if (sameText(entry.used_by, spki)) {
      const machine = document.machines.find((candidate) => candidate.machine_id === machineId);
      if (!machine || machine.state === "revoked") return { ...same, result: { code: "auth_revoked", cause: "revoked" } };
      if (machine.state === "quarantined") return { ...same, result: { code: "auth_revoked", cause: "quarantined" } };
      return { ...same, result: { machineId } };
    }
    // a second key for one invite: the slot is quarantined, the first key's machine with it, and nothing of this key is kept
    const firstId = machineFingerprint(Buffer.from(entry.used_by, "base64url"));
    const first = document.machines.find((candidate) => candidate.machine_id === firstId);
    const alert: FleetAlert = { kind: "quarantined", reason: "second_key", machine_id: first?.machine_id ?? null, slot: entry.slot, invite_id: entry.id };
    if (!first || first.state === "quarantined" || first.state === "revoked") return { ...same, result: { code: "auth_revoked", cause: "quarantined" }, alert };
    const machines = document.machines.map((candidate) => candidate === first ? { ...first, state: "quarantined" as const, updated_at: now } : candidate);
    const quarantined = { ...document, machines };
    // a quarantine raises the witness's generation too (todo 31); a witness that cannot be written changes nothing
    return { document: this.options.witness ? this.options.witness(quarantined, [], [first.machine_id]) : quarantined, result: { code: "auth_revoked", cause: "quarantined" }, alert };
  }

  /**
   * Withdraws open invites (todo 31): one by its id, or every one of a batch. An invite a machine used is kept (its
   * machine names it); a withdrawn one is gone from the store, so an ENROLL with it is refused `unknown` from now on. A
   * batch left with no invite and no machine goes too. Answers the ids withdrawn; FleetRouteError `unknown_invite` or
   * `unknown_batch` when there is nothing of that id, and `invalid_request` for an invite already used.
   */
  withdraw(which: { readonly invite_id: string } | { readonly batch_id: string }): { readonly withdrawn: readonly string[] } {
    return this.write((document) => {
      const matched = "invite_id" in which ? document.invites.filter((entry) => entry.id === which.invite_id) : document.invites.filter((entry) => entry.batch_id === which.batch_id);
      if ("invite_id" in which && !matched.length) throw new FleetRouteError("unknown_invite", "No invite has that id.");
      if ("batch_id" in which && !document.batches.some((entry) => entry.id === which.batch_id)) throw new FleetRouteError("unknown_batch", "No batch has that id.");
      const gone = matched.filter((entry) => entry.used_by === null);
      if ("invite_id" in which && !gone.length) throw new FleetRouteError("invalid_request", "That invite was used: remove its machine instead.");
      const ids = new Set(gone.map((entry) => entry.id));
      const invites = document.invites.filter((entry) => !ids.has(entry.id));
      const named = new Set(document.machines.flatMap((machine) => machine.invite_id === null ? [] : [machine.invite_id]));
      const batches = document.batches.filter((entry) => invites.some((candidate) => candidate.batch_id === entry.id) || document.invites.some((candidate) => candidate.batch_id === entry.id && named.has(candidate.id)));
      for (const entry of gone) console.error(JSON.stringify({ event: "fleet.invite_withdrawn", invite_id: entry.id, batch_id: entry.batch_id, slot: entry.slot }));
      return { document: ids.size ? { ...document, invites, batches } : document, result: { withdrawn: [...ids].sort() } };
    });
  }

  /** Takes a batch back whole (a mint that could not name a carrier): only invites no machine used. */
  private takeBack(batchId: string): void {
    this.write((document) => {
      const used = document.invites.some((entry) => entry.batch_id === batchId && entry.used_by !== null);
      if (used) return { document, result: undefined };
      return { document: { ...document, invites: document.invites.filter((entry) => entry.batch_id !== batchId), batches: document.batches.filter((entry) => entry.id !== batchId) }, result: undefined };
    });
  }

  /**
   * One request through the admission queue: every request waiting when a turn starts is decided in order against one
   * read of the store and written with one write; a request that throws changes nothing and fails alone.
   */
  private admit<T>(decide: (document: FleetDocument, now: number) => { document: FleetDocument; result: T; alert?: FleetAlert }): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.queue.push({ decide, resolve: resolve as (result: unknown) => void, reject });
    if (!this.draining) {
      this.draining = true;
      setImmediate(() => this.drain());
    }
    return promise;
  }

  /** One turn: every request waiting now, in order; the store refusing the write fails them all and changes nothing. */
  private drain(): void {
    const turn = this.queue.splice(0);
    if (!turn.length) { this.draining = false; return; }
    const outcomes: ({ ok: true; result: unknown; alert?: FleetAlert } | { ok: false; error: unknown })[] = [];
    try {
      this.write((document) => {
        let current = document;
        outcomes.length = 0;
        const now = this.now();
        for (const admission of turn) {
          try {
            const decided = admission.decide(current, now);
            current = decided.document;
            outcomes.push({ ok: true, result: decided.result, ...(decided.alert ? { alert: decided.alert } : {}) });
          } catch (error) { outcomes.push({ ok: false, error }); }
        }
        return { document: current, result: undefined };
      });
    } catch (error) {
      for (const admission of turn) admission.reject(error);
      setImmediate(() => this.drain());
      return;
    }
    turn.forEach((admission, index) => {
      const outcome = outcomes[index]!;
      if (!outcome.ok) { admission.reject(outcome.error); return; }
      if (outcome.alert) this.alert(outcome.alert);
      admission.resolve(outcome.result);
    });
    setImmediate(() => this.drain());
  }

  private write<T>(apply: (document: FleetDocument) => { document: FleetDocument; result: T }): T {
    try { return this.store.update(apply); }
    catch (error) {
      if (error instanceof FleetStoreError) {
        if (error.code === "fleet_token_required") throw new FleetRouteError("fleet_token_required", "The fleet needs OVIS_TOKEN on this server: set it and restart Ovis. Nothing was changed.");
        throw new FleetRouteError(error.code === "busy" ? "fleet_store_busy" : "fleet_store_unreadable", error.code === "busy" ? "The fleet's store is busy; try again." : "The fleet's store cannot be read; mend or move it away.");
      }
      throw error;
    }
  }

  private alert(alert: FleetAlert): void {
    console.error(JSON.stringify({ event: "fleet.quarantined", ...alert }));
    this.options.onAlert?.(alert);
  }

  private addressSpent(source: string, now: number): boolean {
    const held = this.addresses.get(source);
    if (held && held.until <= now) this.addresses.delete(source);
    return (this.addresses.get(source)?.count ?? 0) >= ENROLL_FAILURES_PER_ADDRESS;
  }

  private addressRefused(source: string, now: number): void {
    const held = this.addresses.get(source);
    if (held && held.until > now) { held.count++; return; }
    this.addresses.delete(source);
    if (this.addresses.size >= MAX_TRACKED_ADDRESSES) {
      for (const [address, entry] of this.addresses) if (entry.until <= now) this.addresses.delete(address);
      if (this.addresses.size >= MAX_TRACKED_ADDRESSES) this.addresses.delete(this.addresses.keys().next().value!);
    }
    this.addresses.set(source, { count: 1, until: now + ENROLL_ADDRESS_WINDOW_MS });
  }
}

/**
 * The slots of batch `batchId` and their names, for a rebuild: each slot its invites or machines held, once. Refused
 * `unknown_batch` for a batch the store does not hold, and `invalid_request` while a slot still has an open invite
 * (two open invites on one slot would let the later enrolment replace the earlier one: withdraw it first).
 */
function slotsOf(document: FleetDocument, batchId: string, now: number): { readonly slot: number; readonly name: string }[] {
  if (!document.batches.some((entry) => entry.id === batchId)) throw new FleetRouteError("unknown_batch", "No batch has that id.");
  const invites = document.invites.filter((entry) => entry.batch_id === batchId);
  const ids = new Set(invites.map((entry) => entry.id));
  const slots = new Map<number, string>();
  for (const entry of invites) slots.set(entry.slot, entry.name);
  for (const machine of document.machines) if (machine.slot !== null && machine.invite_id !== null && ids.has(machine.invite_id)) slots.set(machine.slot, machine.name);
  const open = document.invites.filter((entry) => slots.has(entry.slot) && entry.used_by === null && entry.exp * 1000 > now);
  if (open.length) throw new FleetRouteError("invalid_request", `Slot ${open[0]!.slot} still has an open invite (${open[0]!.id}): withdraw it first.`);
  return [...slots].sort((a, b) => a[0] - b[0]).map(([slot, name]) => ({ slot, name }));
}

/** The port of this controller's direct carriers (they share one), or null without any. */
function directPort(direct: readonly string[]): number | null {
  const match = /:(\d+)$/.exec(direct[0] ?? "");
  return match ? Number(match[1]) : null;
}

/** Invites past their expiry by KEEP_EXPIRED_MS that no machine names, and batches left with no invite, are dropped. */
function prune(document: FleetDocument, now: number): FleetDocument {
  const named = new Set(document.machines.flatMap((machine) => machine.invite_id === null ? [] : [machine.invite_id]));
  const invites = document.invites.filter((entry) => named.has(entry.id) || entry.exp * 1000 + KEEP_EXPIRED_MS > now);
  if (invites.length === document.invites.length) return document;
  const batchIds = new Set(invites.map((entry) => entry.batch_id));
  return { ...document, invites, batches: document.batches.filter((entry) => batchIds.has(entry.id)) };
}

function batchRow(document: FleetDocument, entry: StoredBatch, now: number): BatchRow {
  const invites = document.invites.filter((candidate) => candidate.batch_id === entry.id);
  const ids = new Set(invites.map((candidate) => candidate.id));
  const machines = document.machines.filter((machine) => machine.state === "pending" && machine.invite_id !== null && ids.has(machine.invite_id))
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
    .map((machine): BatchMachine => ({ machine_id: machine.machine_id, slot: machine.slot, name: machine.name, fingerprint: groupedFingerprint(machine.machine_id) }));
  const counts = { unused: 0, used: 0, expired: 0 };
  for (const candidate of invites) counts[candidate.used_by !== null ? "used" : candidate.exp * 1000 <= now ? "expired" : "unused"]++;
  return { batch_id: entry.id, created_at: entry.created_at, count: machines.length, machines, digest: batchDigest(machines.map((machine) => machine.machine_id)), invites: counts };
}

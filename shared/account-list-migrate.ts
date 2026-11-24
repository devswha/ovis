/**
 * Moving an account that was in use onto its signed list (docs/account-list.md, "An account that was in use"):
 * what the first device carries in, the entries it signs for that, what a PC of the account checks before it
 * follows such a list, and how a row that a PC keeps by a device's sign-in key moves to the key the device goes
 * on with. The kinds are under it (shared/account-list.ts) and it changes none of their rules: every entry here
 * is signed by signListEntry or signGenesis, so none is written that would not count.
 *
 * This is the one moment a list is made from what the account service says, so nothing here takes the service's
 * word alone. The first device carries a device in only where a PC it knows by its own record lets that key in
 * already, and each PC follows the list only where it let in, itself, every key the list was born with. What
 * either side knows counts only once it has known it for a day (MIGRATION_WITNESS_SECONDS): a service that lies
 * from today on cannot have made yesterday's records.
 *
 * In a list that was made this way, the keys it is born with are the keys the devices' sign-ins registered with
 * the account service, since those are the keys the PCs let in before the list. Entry 0 is signed by the first
 * device's sign-in key, the run of `carried` entries follows, and the first device ends the run with a `device`
 * entry that hands its place to its account key. Every carried device does the same when it next runs.
 *
 * No I/O, no storage, no clock and nothing random: sealing, which needs a random key, is the caller's
 * (MigrationSeals). Every `now` here is the caller's own wall clock, in seconds since 1970, and never the
 * list's own time (listClock): whoever signs a list dates its entries, so a day by the list's time is no day.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalBase64Url, isListHash, verifySignature, writeFieldsUnder } from "./account-list-entry.ts";
import {
  CARD_SIGNATURE_CHARS, ListKindError, isListKey, listView, sealEpoch, signCard, signGenesis, signListEntry, wrapKeys,
  type ListNames, type ListSigner, type ListState, type Sealed, type WrittenEntry,
} from "./account-list.ts";
import { toBase64Url } from "./relay-pair-sas.ts";

/** How long a PC must have let a key in, and a device must have known a PC, before either is a witness: a day, in seconds. */
export const MIGRATION_WITNESS_SECONDS = 86400;
/** The most devices and PCs one list carries in: no account in use has more, and a list's birth stays a few requests. */
export const MIGRATION_CARRIED_MAX = 64;
/** The most entries the account service places in one request. */
export const MIGRATION_REQUEST_ENTRIES = 16;
/** A vouch's signature is over these bytes and the vouch's fields. */
export const LIST_VOUCH_PREFIX = "ovis-list-vouch/1";
const ENDPOINT = /^[0-9a-f]{64}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/** A row of its own, or null: what every object answers to is no row. */
function rowOf<Row>(rows: { readonly [name: string]: Row }, name: string): Row | null {
  return Object.hasOwn(rows, name) ? (rows[name] ?? null) : null;
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * A key that somebody let in, and the second (since 1970) from which it has been let in without a break. `seen`
 * is the last second it was used there, where that is known: it only says which keys are in use when an account
 * has more than a list carries in.
 */
export interface WitnessedKey {
  readonly key: string;
  readonly since: number;
  readonly seen?: number | null;
}

/** A device as the account service lists it for the account: the key its sign-in registered, whether the service says a PC lets it in, and its name. */
export interface KnownDevice {
  readonly key: string;
  readonly eligible: boolean;
  readonly names: ListNames | null;
}

/**
 * What a PC answers a device of its account over a session to its own relay key: the account it is in, its own
 * clock (`now`, by which its times are read: a PC's clock and a device's need not agree), the device keys it lets
 * in to drive on that account now, each with the second since which it has, and the keys it holds a removal
 * against (a signed removal or block it applied, or a person's Revoke at that PC).
 */
export interface PcAnswer {
  readonly account: string;
  readonly now: number;
  readonly admits: readonly WitnessedKey[];
  readonly removed: readonly string[];
}

/**
 * A PC as the first device knows it. `paired`: the person paired this device with that relay key at the PC (a QR
 * or digits), which the account service had no part in. `since`: the second this device first held an end-to-end
 * session with that relay key, by its own record, or null for a relay key it has only the service's word for.
 * `says`: the PC's answer, or null for a PC that was not reached or runs an Ovis that cannot answer.
 */
export interface KnownPc {
  readonly endpoint: string;
  readonly paired: boolean;
  readonly since: number | null;
  readonly says: PcAnswer | null;
  readonly names: ListNames | null;
}

/** What the first device knows as it moves its account onto a list. */
export interface MigrationKnown {
  readonly account: string;
  /** The key this device's own sign-in registered: it signs entry 0. */
  readonly self: string;
  /** This device's member key (its account key): it is this device wherever it is named. */
  readonly member: string;
  /** The account's devices as the account service lists them now, in its order. */
  readonly devices: readonly KnownDevice[];
  /** The keys the account service lists as removed, and every key this device itself holds a block or a removal against, sent or not. */
  readonly removed: readonly string[];
  readonly pcs: readonly KnownPc[];
}

/**
 * Why a device starts no list now.
 *
 * - `self_unlisted`: the account service does not list this device's own key as one a PC lets in.
 * - `self_removed`: the service, this device, or a PC this device knows holds a removal against its own key.
 * - `no_witness`: no PC that this device knows by its own record has answered for this account.
 * - `self_unwitnessed`: no such PC lets this device's own key in.
 * - `too_new`: this device's key, or one it would carry in, has been let in for less than a day by every PC that
 *   lets it in, or this device has known a PC for less than a day; `until` is the second, by this device's clock,
 *   from which that is over.
 */
export type NoMigration = "self_unlisted" | "self_removed" | "no_witness" | "self_unwitnessed" | "too_new";

/**
 * Why a device or a PC is not carried in.
 *
 * - `form`: its key is no key of a list, or its relay key no relay key.
 * - `removed`: the account service lists the key as removed, or this device holds a removal against it.
 * - `not_eligible`: the service lists the key as one no PC lets in now.
 * - `removed_at_pc`: a PC this device knows holds a removal against the key, whatever the service says.
 * - `unwitnessed`: no PC this device knows lets the key in.
 * - `unknown_pc`: this device has only the account service's word that the relay key is a PC of the person's.
 * - `over_limit`: the list carries MIGRATION_CARRIED_MAX in, and these were in use least lately.
 */
export type LeftOut = "form" | "removed" | "not_eligible" | "removed_at_pc" | "unwitnessed" | "unknown_pc" | "over_limit";

/** Whom the first device carries in, in the order of the entries, and whom it leaves out and why. */
export interface MigrationPlan {
  readonly devices: readonly { readonly key: string; readonly names: ListNames | null }[];
  readonly pcs: readonly { readonly endpoint: string; readonly names: ListNames | null }[];
  readonly left: {
    readonly devices: readonly { readonly key: string; readonly why: LeftOut }[];
    readonly pcs: readonly { readonly endpoint: string; readonly why: LeftOut }[];
  };
}

export type MigrationStart =
  | { readonly start: true; readonly plan: MigrationPlan }
  | { readonly start: false; readonly why: NoMigration; readonly until: number | null };

/**
 * Whether a device knows a relay key as a PC of the person's by its own record: it was paired with it at the PC,
 * or it has held sessions with that relay key for at least `age` seconds. The account service's directory alone
 * is no such record.
 */
export function ownEvidence(pc: Pick<KnownPc, "paired" | "since">, now: number, age: number = MIGRATION_WITNESS_SECONDS): boolean {
  return pc.paired === true || (isTime(pc.since) && now - pc.since >= age);
}

/**
 * Whom a device carries into the list it starts for an account that was in use, or why it starts none now.
 * `now` is the device's wall clock, in seconds since 1970.
 *
 * A device key is carried in only when all hold: the account service lists it as one a PC lets in, and neither
 * the service nor this device holds a removal against it; a PC that this device knows by its own record
 * (ownEvidence), and that answered for this account, says it has let that key in for at least `age` seconds by
 * its own clock; and no such PC holds a removal against it. So a key that only the service names gets no place
 * (`unwitnessed`), and neither does one that a PC put out and the service lists again (`removed_at_pc`). A key
 * that such a PC has let in for less than `age` holds the start back (`too_new`), and so does a PC this device
 * has known for less than `age`: the device asks again later, and nobody presses anything. The device's own key
 * is held to the same.
 *
 * A PC is carried in when the device knows it by its own record, answered or not. Devices come first, in the
 * service's order, then PCs. Where an account has more than MIGRATION_CARRIED_MAX, the devices that a PC saw in
 * use last are kept, and the rest is left out (`over_limit`): a sign-in nobody uses any more is the first to go.
 * A device that was left out asks to be let in as a new device does, and a PC that was left out is added by a
 * `pc` entry.
 */
export function migrationPlan(known: MigrationKnown, now: number, age: number = MIGRATION_WITNESS_SECONDS): MigrationStart {
  const no = (why: NoMigration, until: number | null = null): MigrationStart => ({ start: false, why, until });
  const removed = new Set(known.removed);
  const witnesses = known.pcs.flatMap((pc) => (ENDPOINT.test(pc.endpoint) && pc.says !== null && pc.says.account === known.account && isTime(pc.says.now) && ownEvidence(pc, now, age) ? [pc.says] : []));
  const removedAtPc = (key: string): boolean => witnesses.some((says) => says.removed.includes(key));
  /** The second, by this device's clock, from which some witness has let the key in for `age` by its own: null when none lets it in. */
  const witnessedFrom = (key: string): number | null => {
    const times = witnesses.flatMap((says) => says.admits.filter((row) => row.key === key && isTime(row.since)).map((row) => now - (says.now - row.since) + age));
    return times.length === 0 ? null : Math.min(...times);
  };

  const self = known.devices.find((device) => device.key === known.self);
  if (!isListKey(known.self) || self === undefined || !self.eligible) return no("self_unlisted");
  if (removed.has(known.self) || removedAtPc(known.self)) return no("self_removed");
  if (witnesses.length === 0) return no("no_witness");
  const selfFrom = witnessedFrom(known.self);
  if (selfFrom === null) return no("self_unwitnessed");

  const carried: { key: string; names: ListNames | null }[] = [];
  const leftDevices: { key: string; why: LeftOut }[] = [];
  let until = selfFrom;
  const named = new Set<string>([known.self, known.member]);
  for (const device of known.devices) {
    const { key } = device;
    if (named.has(key)) continue;
    named.add(key);
    const from = witnessedFrom(key);
    const why: LeftOut | null = !isListKey(key) ? "form" : removed.has(key) ? "removed" : !device.eligible ? "not_eligible" : removedAtPc(key) ? "removed_at_pc" : from === null ? "unwitnessed" : null;
    if (why !== null) { leftDevices.push({ key, why }); continue; }
    until = Math.max(until, from ?? 0);
    carried.push({ key, names: device.names });
  }

  const pcs: { endpoint: string; names: ListNames | null }[] = [];
  const leftPcs: { endpoint: string; why: LeftOut }[] = [];
  const places = new Set<string>();
  for (const pc of known.pcs) {
    const { endpoint } = pc;
    if (places.has(endpoint)) continue;
    places.add(endpoint);
    if (!ENDPOINT.test(endpoint)) leftPcs.push({ endpoint, why: "form" });
    else if (ownEvidence(pc, now, age)) pcs.push({ endpoint, names: pc.names });
    else if (isTime(pc.since)) until = Math.max(until, pc.since + age);
    else leftPcs.push({ endpoint, why: "unknown_pc" });
  }
  if (until > now) return no("too_new", until);

  /** The last second any witness saw the key in use; a key no witness has seen in use comes last. */
  const lastSeen = (key: string): number => Math.max(-1, ...witnesses.flatMap((says) => says.admits.filter((row) => row.key === key && isTime(row.seen)).map((row) => row.seen ?? -1)));
  const kept = new Set(carried.length <= MIGRATION_CARRIED_MAX ? carried.map(({ key }) => key)
    : carried.map(({ key }, index) => ({ key, index, seen: lastSeen(key) })).sort((a, b) => b.seen - a.seen || a.index - b.index).slice(0, MIGRATION_CARRIED_MAX).map(({ key }) => key));
  const devices = carried.filter(({ key }) => kept.has(key));
  const room = MIGRATION_CARRIED_MAX - devices.length;
  return {
    start: true,
    plan: {
      devices,
      pcs: pcs.slice(0, room),
      left: {
        devices: [...leftDevices, ...carried.filter(({ key }) => !kept.has(key)).map(({ key }) => ({ key, why: "over_limit" as const }))],
        pcs: [...leftPcs, ...pcs.slice(room).map(({ endpoint }) => ({ endpoint, why: "over_limit" as const }))],
      },
    },
  };
}

/** What is not written of a migration, and why. */
export type MigrationRefusalCode = "stopped" | "key_invalid" | "too_many" | "not_first" | "not_fresh" | "not_in" | "run_open" | "has_member";

export class MigrationError extends Error {
  constructor(readonly code: MigrationRefusalCode, message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * Sealing, which is the caller's (shared/account-list-seal.ts): it holds the epoch keys, and making one needs
 * random bytes. Each answer may be null where the caller seals nothing.
 */
export interface MigrationSeals {
  /** For entry 0: the commitment to the key of epoch 0 that the caller has just made, and the first device's names sealed under it. */
  genesis(names: ListNames | null): Promise<{ readonly opens: string; readonly sealed: Sealed | null }>;
  /** One member's names for the entry at `place`, under the epoch that sealEpoch named. */
  names(place: { readonly list: string; readonly seq: number }, epoch: { readonly epoch: number; readonly opens: string }, names: ListNames): Promise<Sealed | null>;
  /**
   * The next epoch, for the `epoch` entry at the end of the run: its commitment and its link. `members` are the
   * encryption keys its key is wrapped to (wrapKeys of the state the entry stands on); the caller keeps the wraps
   * and sends them with the entries.
   */
  next(list: string, epoch: number, members: readonly string[]): Promise<{ readonly opens: string; readonly link: Uint8Array }>;
}

/** The first device's keys: its sign-in key, which the PCs let in and which signs the list's birth, and the member key it goes on with (its account key) with its encryption key. */
export interface MigratingDevice {
  readonly signIn: ListSigner;
  readonly member: ListSigner;
  readonly enc: string;
  readonly names: ListNames | null;
}

/** Whether a device's own keys are keys of a list: each in its one spelling, with its point on the curve. */
const ownKeys = (device: Pick<MigratingDevice, "signIn" | "member" | "enc">): boolean => isListKey(device.signIn.key) && isListKey(device.member.key) && isListKey(device.enc);

const firstSigner = (state: ListState): string | null => Object.entries(state.signers).find(([, row]) => row.seq === 0)?.[0] ?? null;

/** Whether the key is a device that is in. */
function deviceIn(state: ListState, key: string): boolean {
  const row = rowOf(state.signers, key);
  return row !== null && row.ended === null && row.as === "device" && rowOf(state.devices, key) !== null;
}

/**
 * Entry 0 of the list of an account that was in use, signed by the first device's sign-in key: the key the
 * account's PCs let in already, so each of them can tell by its own state who started the list. `issued_at` is
 * the device's clock in seconds, no later than the account service's where it said one.
 */
export async function signMigrationGenesis(account: string, device: MigratingDevice, issued_at: number, seals: MigrationSeals): Promise<WrittenEntry> {
  const { opens, sealed } = await seals.genesis(device.names);
  return await signGenesis({ kind: "genesis", account, enc: device.enc, opens, sealed }, device.signIn, issued_at);
}

/**
 * The whole run after entry 0, signed once, on the state entry 0 gives: a `carried` for each device and PC of
 * the plan, then the `device` entry by which the first device's sign-in key hands its place to its member key
 * (which ends the run: nobody is carried in after it), then the `epoch` entry, since names are no longer sealed
 * under an epoch whose key a key that is out held. The carried entries and the hand-over are signed by the
 * sign-in key, the `epoch` entry by the member key.
 *
 * The device keeps what this gives with entry 0 before it sends anything, and sends those very entries until the
 * log holds them (migrationRest): it never signs the run a second time. A run signed again on what a lying
 * service shows of the first would be a second history with a member's signature under it.
 *
 * The entries are sent in order, MIGRATION_REQUEST_ENTRIES at most a request (migrationRequests): the run may
 * take several, and nobody follows the list, the first device included, before the log shows the run over.
 *
 * Refuses (MigrationError), before anything is signed or sealed: `stopped` for a member that is stopped for a
 * replay; `not_fresh` for a state that holds more than entry 0; `key_invalid` when a key the plan names is no
 * key whose point is on the curve, is one of the device's own, or a relay key is out of form; `too_many` for a
 * plan of more than MIGRATION_CARRIED_MAX; and `not_first` when entry 0 is not this sign-in key's. The kinds
 * read only the spelling of a carried key, so the point is checked here: nobody holds the private half of a key
 * off the curve, and a member that later saves it among its keys cannot read its own copy back.
 */
export async function signMigrationRun(
  state: ListState, plan: Pick<MigrationPlan, "devices" | "pcs">, device: MigratingDevice, issued_at: number, seals: MigrationSeals,
): Promise<{ readonly entries: readonly WrittenEntry[]; readonly state: ListState }> {
  if (state.needs_replay !== undefined) throw new MigrationError("stopped", "A member that is stopped for a replay writes nothing");
  if (state.footing.seq !== 0) throw new MigrationError("not_fresh", "The run is signed once, on entry 0: what was signed then is sent again");
  const own = [device.signIn.key, device.member.key];
  if (plan.devices.some(({ key }) => !isListKey(key) || own.includes(key)) || plan.pcs.some(({ endpoint }) => !ENDPOINT.test(endpoint)) || !ownKeys(device)) {
    throw new MigrationError("key_invalid", "A key of this run is no key whose point is on the curve, is this device's own, or a relay key is out of form");
  }
  if (plan.devices.length + plan.pcs.length > MIGRATION_CARRIED_MAX) throw new MigrationError("too_many", `A list carries at most ${MIGRATION_CARRIED_MAX} in`);
  if (firstSigner(state) !== device.signIn.key) throw new MigrationError("not_first", "Entry 0 of this list is not signed by this device's sign-in key");
  const entries: WrittenEntry[] = [];
  let after = state;
  const write = (written: WrittenEntry): void => {
    entries.push(written);
    after = written.state;
  };
  const sealedNames = async (names: ListNames | null): Promise<Sealed | null> => {
    const epoch = names === null ? null : sealEpoch(after, issued_at);
    return names === null || epoch === null ? null : await seals.names({ list: after.list, seq: after.footing.seq + 1 }, epoch, names);
  };
  for (const { key, names } of plan.devices) {
    write(await signListEntry(after, { kind: "carried", key, role: "drive", sealed: await sealedNames(names) }, device.signIn, issued_at));
  }
  for (const { endpoint, names } of plan.pcs) {
    write(await signListEntry(after, { kind: "carried", endpoint, sealed: await sealedNames(names) }, device.signIn, issued_at));
  }
  write(await signRotation(after, device, issued_at, await sealedNames(device.names)));
  // Its sign-in key held the key of the epoch, and is out: the next epoch is opened by the member key, which stays.
  const next = await seals.next(after.list, after.epoch, wrapKeys(after, issued_at));
  write(await signListEntry(after, { kind: "epoch", epoch: after.epoch, opens: next.opens, link: next.link }, device.member, issued_at));
  return { entries, state: after };
}

/**
 * The entries of a run as the requests that place them, in order: MIGRATION_REQUEST_ENTRIES at most in each, and
 * the last two entries of a whole run (the hand-over and the `epoch` entry, whose wraps go with that request)
 * never apart. Each request is placed whole or not at all.
 */
export function migrationRequests<Entry>(entries: readonly Entry[]): Entry[][] {
  const requests: Entry[][] = [];
  // A last request of one entry would be the `epoch` entry alone: it takes the entry before it along.
  const tail = entries.length % MIGRATION_REQUEST_ENTRIES === 1 ? 2 : 0;
  const body = entries.slice(0, entries.length - tail);
  for (let at = 0; at < body.length; at += MIGRATION_REQUEST_ENTRIES) requests.push(body.slice(at, at + MIGRATION_REQUEST_ENTRIES));
  if (tail > 0) requests.push(entries.slice(entries.length - tail));
  return requests;
}

/**
 * What is left to send of a run the device signed and kept, by what the log shows. `run` is the run's entries as
 * their texts and `log` the entries the account service shows after entry 0, both from place 1 on. Where the log
 * holds the run's own entries so far, the entries after them are `rest`, to be sent as they are. `diverged` is
 * the first place at which the log holds another entry than the run's: nobody but the first device signs while
 * its run is open, so the service is showing there something no member of this list signed. The device then
 * sends nothing and signs nothing.
 */
export function migrationRest(run: readonly string[], log: readonly string[]): { readonly rest: readonly string[] } | { readonly diverged: number } {
  for (let at = 0; at < Math.min(run.length, log.length); at += 1) if (run[at] !== log[at]) return { diverged: at + 1 };
  return { rest: run.slice(log.length) };
}

/**
 * A vouch: the word of a sign-in key that a member key of a list is its own device's. `device` is the key a
 * sign-in registered with the account service, which signs; `key` is the member key the same device is in the
 * list by. It is the hand-over said again by the device's present sign-in: a PC that lets `device` in, and has
 * for a day, so learns that the member `key` is a device it knows, though it never held the sign-in key that
 * the member key came from.
 */
export interface ListVouch {
  readonly account: string;
  readonly list: string;
  readonly key: string;
  readonly device: string;
}

/** A vouch as it travels: its two keys and the signature of `device`, 86 characters of base64url. The account and the list are the reader's own. */
export interface SignedVouch {
  readonly key: string;
  readonly device: string;
  readonly signature: string;
}

/** A vouch's bytes: `ovis-list-vouch/1` and the fields `account`, `device`, `key` and `list`, in the entry's field form. Refuses `entry_invalid` for a value out of its form. */
export function vouchBytes(vouch: ListVouch): Uint8Array {
  const { account, list, key, device } = vouch;
  if (typeof account !== "string" || !ACCOUNT.test(account) || typeof list !== "string" || !isListHash(list) || typeof key !== "string" || !isListKey(key) || typeof device !== "string" || !isListKey(device)) {
    throw new ListKindError("A vouch names an account, a list, a member key and the sign-in key that signs it");
  }
  return writeFieldsUnder(LIST_VOUCH_PREFIX, [
    { name: "account", value: utf8ToBytes(account) }, { name: "device", value: utf8ToBytes(device) }, { name: "key", value: utf8ToBytes(key) }, { name: "list", value: utf8ToBytes(list) },
  ]);
}

/**
 * The vouch of a device for its own member key, signed with its present sign-in key, or null where there is
 * nothing to vouch for: a device signs one only for the list it follows, and only while its member key is a
 * device of that list that is in. It signs none for anybody else's key, and none for a list it was only shown.
 */
export async function signVouch(state: ListState, device: Pick<MigratingDevice, "signIn" | "member">): Promise<SignedVouch | null> {
  if (state.needs_replay !== undefined || !deviceIn(state, device.member.key) || device.signIn.key === device.member.key) return null;
  const bytes = vouchBytes({ account: state.account, list: state.list, key: device.member.key, device: device.signIn.key });
  const signature = toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, device.signIn.privateKey, new Uint8Array(bytes))));
  return { key: device.member.key, device: device.signIn.key, signature };
}

/**
 * The vouches among those handed over that hold for this account and list: each signed by its own `device` key
 * over its bytes. One that is out of form, of another list or account, or signed by any other key (the member
 * key itself among them) is dropped: a member key that names a sign-in key proves nothing about that sign-in.
 * What a PC makes of them is migrationVerdict's to say (`vouched`).
 */
export async function heldVouches(account: string, list: string, vouches: readonly SignedVouch[]): Promise<{ readonly key: string; readonly device: string }[]> {
  const held: { key: string; device: string }[] = [];
  for (const vouch of [...vouches]) {
    if (typeof vouch !== "object" || vouch === null) continue;
    const { key, device, signature } = vouch;
    const signed = typeof signature === "string" && signature.length === CARD_SIGNATURE_CHARS ? canonicalBase64Url(signature) : null;
    // A key that vouches for itself says nothing; what is no key is refused with the bytes.
    if (signed === null || key === device) continue;
    let bytes: Uint8Array;
    try {
      bytes = vouchBytes({ account, list, key, device });
    } catch (error) {
      if (error instanceof ListKindError) continue;
      throw error;
    }
    if (await verifySignature(bytes, signed, device)) held.push({ key, device });
  }
  return held;
}

/**
 * The `device` entry by which a device that is in the list under its sign-in key (the first device, or one that
 * was carried in) hands its place to its member key: signed by the sign-in key, it adds the member key with the
 * device's own card and encryption key and ends the sign-in key. From then on the device is in by a key that
 * outlives its sign-in. `sealed` is the device's names under sealEpoch's epoch, or null for a device that holds
 * no key to the names yet.
 *
 * A device that was carried in writes nothing while the run is open, however long that lasts: its entry would
 * end the run and leave the rest outside, and a device cannot tell an open run from the beginning of a run that
 * a lying service shows it. Only the first device ends its run (signMigrationRun); a birth that is never
 * finished is the account service's to let somebody start again.
 *
 * Refuses `stopped`, `key_invalid` for a key of the device's own that is no key of a list, `not_in` for a
 * sign-in key that is no device of power `full` that is in, `has_member` for a member key the list has held
 * before, and `run_open`.
 */
export async function signRotation(state: ListState, device: Pick<MigratingDevice, "signIn" | "member" | "enc">, issued_at: number, sealed: Sealed | null): Promise<WrittenEntry> {
  if (state.needs_replay !== undefined) throw new MigrationError("stopped", "A member that is stopped for a replay writes nothing");
  if (!ownKeys(device)) throw new MigrationError("key_invalid", "A key of this device is no key whose point is on the curve");
  const row = rowOf(state.signers, device.signIn.key);
  if (row === null || !deviceIn(state, device.signIn.key) || row.power !== "full") throw new MigrationError("not_in", "This sign-in key is no device of this list that may hand its place on");
  if (rowOf(state.signers, device.member.key) !== null) throw new MigrationError("has_member", "The list has held this member key before");
  if (state.carrying && row.seq !== 0) throw new MigrationError("run_open", "The first device is still carrying the account in");
  const card = await signCard({ key: device.member.key, enc: device.enc, list: state.list, endpoint: null, invite: null }, device.member.privateKey);
  return await signListEntry(state, { kind: "device", key: device.member.key, power: "full", role: "drive", until: null, enc: device.enc, card, sealed, rotates: true }, device.signIn, issued_at);
}

/**
 * The key that a key handed its place to by its own entry: the `device` entry it signed that ended it and let
 * the other key in as a device. Null for a key that is in, for one that was put out, and for one the list never
 * held.
 */
export function heirOf(state: ListState, key: string): string | null {
  const row = rowOf(state.signers, key);
  if (row === null || row.ended === null) return null;
  for (const [other, heir] of Object.entries(state.signers)) {
    if (heir.by === key && heir.seq === row.ended && heir.as === "device" && rowOf(state.devices, other) !== null) return other;
  }
  return null;
}

/**
 * The key that stands now where `key` came in: `key` itself while it is a device that is in, otherwise the last
 * of the keys it handed its place on to, when that one is in. Null for a device that is out, and for a key that
 * was never a device here, and for a key that is no point of the curve, whatever the list holds of it. A PC that
 * follows a list asks this for each row it kept by a sign-in key.
 */
export function standsFor(state: ListState, key: string): string | null {
  if (state.needs_replay !== undefined) return null;
  let at = key;
  for (let steps = 0; steps <= state.footing.seq; steps += 1) {
    if (deviceIn(state, at)) return isListKey(at) ? at : null;
    const heir = heirOf(state, at);
    if (heir === null) return null;
    at = heir;
  }
  return null;
}

/** A row that moves: the key a PC held a device by, and the key the same device is in by now. */
export interface Rekey {
  readonly from: string;
  readonly to: string;
}

/**
 * The devices that were in by one key in `before` and are in by another in `after`, each having handed its
 * place on itself. A PC moves such a device's row to the new key: it is the same device, so it is not announced
 * as a new one, waits no hold, and keeps its name and its age on that PC. A device that is new in `after`, and
 * one that went out with no heir, is not among them. `before` null gives none.
 */
export function rekeys(before: ListState | null, after: ListState): Rekey[] {
  if (before === null || before.needs_replay !== undefined) return [];
  const moved: Rekey[] = [];
  for (const key of Object.keys(before.devices)) {
    if (!deviceIn(before, key)) continue;
    const to = standsFor(after, key);
    if (to !== null && to !== key) moved.push({ from: key, to });
  }
  return moved.sort((a, b) => (a.from < b.from ? -1 : 1));
}

/**
 * Where a device stands in a list of its account that it did not start by an Allow.
 *
 * - `first`: entry 0 is its sign-in key's, which is still in: it sends the run it signed and kept (migrationRest).
 * - `carried`: its sign-in key was carried in and is still in: it hands its place to its member key
 *   (signRotation) once `wait` is false.
 * - `member`: its member key is in. Nothing is left to do.
 * - `out`: one of its keys was in and none is: it was removed.
 * - `absent`: the list holds no key of its own. While `wait` is true the run is open and it may yet be carried
 *   in; after that it asks to be let in as a new device does.
 */
export type DevicePlace =
  | { readonly at: "first" }
  | { readonly at: "carried"; readonly wait: boolean }
  | { readonly at: "member" }
  | { readonly at: "out" }
  | { readonly at: "absent"; readonly wait: boolean };

/**
 * How a device that was signed in before its account had a list learns what became of it: from the list alone,
 * whenever it next reads it. `wait` is true while the first device's run is open.
 */
export function devicePlace(state: ListState, keys: { readonly signIn: string; readonly member: string }): DevicePlace {
  if (deviceIn(state, keys.member)) return { at: "member" };
  const row = rowOf(state.signers, keys.signIn);
  if (row !== null && deviceIn(state, keys.signIn)) return row.seq === 0 ? { at: "first" } : { at: "carried", wait: state.carrying };
  return row !== null || rowOf(state.signers, keys.member) !== null ? { at: "out" } : { at: "absent", wait: state.carrying };
}

/**
 * What a PC holds of the devices of its account from before the list.
 *
 * - `admits`: the device keys it lets in to drive on that account now, each with the second since which it has,
 *   read after a whole read of the account service's snapshot since the PC last started. A row that is held
 *   back, waits or only watches is not among them. A row from before the PC began to record counts from the
 *   second it began.
 * - `removed`: the keys it holds a removal against: a member's signed removal or block that it applied, or a
 *   person's Revoke at this PC.
 * - `vouched`: the vouches it was handed that hold (heldVouches): a member key, and the sign-in key that says
 *   the member key is its own device's.
 *
 * A key the PC let in once and has dropped since is none of these: what the PC knew of it says nothing of who
 * holds it now.
 */
export interface PcWitness {
  readonly account: string;
  readonly admits: readonly WitnessedKey[];
  readonly removed: readonly string[];
  readonly vouched: readonly { readonly key: string; readonly device: string }[];
}

/**
 * Why a PC does not follow a list that carries its account in, the first that applies, in this order.
 *
 * - `stopped`: the PC cannot place an entry of the list (it needs a newer Ovis).
 * - `other_account`: the list is of another account than the PC's.
 * - `carried_off_curve`: the list carries in a key that is no point of the curve. The kinds read only the
 *   spelling of a carried key, so such an entry counts; no honest device signs one (signMigrationRun), nobody can
 *   hold its private half, and a member that saves it among its keys cannot read its own copy back.
 * - `first_signer_removed`, `carried_removed`: the PC holds a removal against the key that started the list, or
 *   against a key that was carried in, or against a key that one handed its place on to, and the list still holds
 *   that device as in. Following the list would bring back what was put out here. Once the list has put the
 *   device out too, the two agree, and it is asked only what it left (`gone_left_signer`).
 * - `first_signer_unknown`, `carried_unknown`: the PC does not let that key in, the device is still in the list,
 *   and no sign-in key the PC lets in vouches for the key it is in by.
 * - `gone_left_signer`: a device the PC cannot place is out of the list by now, and a signer that came in by it
 *   is still in and is none the PC can place either: `keys` names those. The one case a person settles at the PC.
 * - `first_signer_new`, `carried_new`, `gone_left_new`: the PC lets the key in, or the sign-in key that vouches
 *   for it, for less than the witness time. `until` is the second from which it has; the PC looks again then
 *   and says nothing meanwhile.
 * - `unvouched`: the device that started the list is out by now and the PC never held its key, and no device
 *   that is in is vouched by a sign-in key the PC has let in for the witness time. Nothing ties the list to a
 *   device this PC knows, so far: it looks again, and says nothing.
 * - `run_open`: every key so far is one the PC can place, and the list may still carry more in. The PC looks
 *   again at its next read.
 */
export type MigrationRefusal =
  | "stopped" | "other_account" | "carried_off_curve"
  | "first_signer_removed" | "carried_removed"
  | "first_signer_unknown" | "carried_unknown"
  | "gone_left_signer"
  | "first_signer_new" | "carried_new" | "gone_left_new"
  | "unvouched" | "run_open";

export type MigrationVerdict =
  /** The PC follows the list: `admitted` is what its pin names (the follower's `migrated` pin), entry 0's signer and every key that was carried in, in ascending order. */
  | { readonly pin: true; readonly admitted: readonly string[] }
  /** `keys`: the keys the refusal is about. `waits`: nothing is wrong so far, and the PC only looks again; otherwise it tells the person. */
  | { readonly pin: false; readonly why: MigrationRefusal; readonly keys: readonly string[]; readonly waits: boolean; readonly until: number | null };

/** How a PC can place a key of the list's birth, or a device that came in by one. */
type Placed = { readonly how: "removed" | "unknown" | "gone" | "old" } | { readonly how: "new"; readonly until: number };

/**
 * Whether a PC that was in its account before the account had a list follows the list it is shown: all or
 * nothing. `state` is what the PC replayed from entry 0, with nothing pinned yet; `now` is the PC's wall clock,
 * in seconds, and never the list's own time.
 *
 * It follows the list only when the run of `carried` entries is over and it can place the key that signed entry
 * 0 and EVERY device key that was carried in, those that are out by now among them. A carried key is a signer of
 * power `full`: one this PC cannot place could have added whom it liked, so a list that carries a single such
 * key in is a list this PC follows nothing of. The PC places a key in one of these ways, and never a device
 * that is in while it holds a removal against one of its keys:
 *
 * - by its own rows: it lets the key in itself now, and has for at least `age` seconds;
 * - by a vouch: the device is in the list by a key it handed its place on to, and a sign-in key that this PC has
 *   let in for `age` seconds says, with its own signature, that this member key is its device's. So a PC that
 *   was off, or took this release after its account moved, follows without a person;
 * - as gone: the device is out of the list, and nothing that came in by it is in, except devices the PC can
 *   place themselves. What it signed lets nobody in any more. When the key that signed entry 0 is placed only
 *   this way, some device that is in must be vouched for: otherwise nothing ties the list to a device the PC
 *   knows.
 *
 * Each rests on a key this PC lets in today and has for `age` seconds. A key it let in once and dropped is
 * placed in none of them: whoever holds such a key now could have started a list with it. A PC that does not
 * follow goes on as before the list, and nothing here is one-way: it is asked again whenever the list, the PC's
 * own rows or the vouches change. Only the pin that follows a yes is.
 */
export function migrationVerdict(state: ListState, witness: PcWitness, now: number, age: number = MIGRATION_WITNESS_SECONDS): MigrationVerdict {
  const no = (why: MigrationRefusal, keys: readonly string[], waits = false, until: number | null = null): MigrationVerdict => ({ pin: false, why, keys: [...new Set(keys)].sort(), waits, until });
  if (state.needs_replay !== undefined) return no("stopped", []);
  if (state.account !== witness.account) return no("other_account", []);
  const first = firstSigner(state);
  if (first === null) return no("stopped", []);
  const carried = listView(state).devices.filter((row) => row.carried).map((row) => row.key);
  const off = carried.filter((key) => !isListKey(key));
  if (off.length > 0) return no("carried_off_curve", off);
  const since = new Map<string, number>();
  // A key named twice counts from the later of its times.
  for (const row of witness.admits) if (isTime(row.since)) since.set(row.key, Math.max(row.since, since.get(row.key) ?? row.since));
  const removed = new Set(witness.removed);
  const vouchers = new Map<string, string[]>();
  for (const { key, device } of witness.vouched) vouchers.set(key, [...(vouchers.get(key) ?? []), device]);
  const added = new Map<string, string[]>();
  for (const [key, row] of Object.entries(state.signers)) if (row.by !== null) added.set(row.by, [...(added.get(row.by) ?? []), key]);
  const OLD: Placed = { how: "old" };

  /** By the PC's own row of the key; null where it has none. */
  const row = (key: string): Placed | null => {
    const from = since.get(key);
    return from === undefined ? null : now - from >= age ? OLD : { how: "new", until: from + age };
  };
  /** The keys a device has been in by, from `key` on: itself and every key it handed its place on to. */
  const chain = (key: string): string[] => {
    const keys = [key];
    for (let heir = heirOf(state, key); heir !== null && !keys.includes(heir); heir = heirOf(state, heir)) keys.push(heir);
    return keys;
  };
  /** By the word of a sign-in key this PC lets in: the best of the vouches for a member key. */
  const vouched = (key: string): Placed => {
    let best: Placed = { how: "unknown" };
    for (const device of vouchers.get(key) ?? []) {
      const from = removed.has(device) ? undefined : since.get(device);
      if (from === undefined) continue;
      if (now - from >= age) return OLD;
      best = { how: "new", until: best.how === "new" ? Math.min(best.until, from + age) : from + age };
    }
    return best;
  };
  const placed = (key: string): Placed => {
    const keys = chain(key);
    const last = keys.at(-1) ?? key;
    // A removal held here stands against a device the list still holds as in. Where the list has put it out too, the two agree.
    if (keys.some((one) => removed.has(one))) return deviceIn(state, last) ? { how: "removed" } : { how: "gone" };
    const own = row(key);
    if (own !== null) return own;
    if (!deviceIn(state, last)) return { how: "gone" };
    return (last === key ? null : row(last)) ?? vouched(last);
  };
  /** What a device that is out, and that this PC cannot place, left in the list: every signer that came in by it and is in, unless the PC can place that one itself. */
  const dirty: string[] = [];
  const young: { key: string; until: number }[] = [];
  const leftBy = (key: string): void => {
    const keys = chain(key);
    for (const by of keys) {
      for (const one of added.get(by) ?? []) {
        const signer = rowOf(state.signers, one);
        if (signer === null || keys.includes(one)) continue;
        // An invite whose placer is out lets no PC in (`invite_void`), and a PC that joined by it is no signer.
        if (signer.as === "invite") continue;
        if (signer.as === "device") {
          const how = placed(one);
          const stands = standsFor(state, one);
          if (how.how === "old") continue;
          if (stands === null) leftBy(one);
          else if (how.how === "new") young.push({ key: stands, until: how.until });
          else dirty.push(stands);
        } else if (signer.ended === null) {
          // A PC that a person added, or a key with no name: a signer of power that is in, which no row of this PC can place.
          dirty.push(one);
        } else {
          leftBy(one);
        }
      }
    }
  };

  const firstPlaced = placed(first);
  const how = new Map(carried.map((key) => [key, placed(key)] as const));
  const of = (what: Placed["how"]): string[] => carried.filter((key) => how.get(key)?.how === what);
  for (const what of ["removed", "unknown"] as const) {
    if (firstPlaced.how === what) return no(`first_signer_${what}`, [first]);
    if (of(what).length > 0) return no(`carried_${what}`, of(what));
  }
  if (firstPlaced.how === "gone") leftBy(first);
  for (const key of of("gone")) leftBy(key);
  if (dirty.length > 0) return no("gone_left_signer", dirty);
  if (firstPlaced.how === "new") return no("first_signer_new", [first], true, firstPlaced.until);
  const untils = [...how.values()].flatMap((one) => (one.how === "new" ? [one.until] : []));
  if (untils.length > 0) return no("carried_new", of("new"), true, Math.max(...untils));
  if (young.length > 0) return no("gone_left_new", young.map((one) => one.key), true, Math.max(...young.map((one) => one.until)));
  if (firstPlaced.how === "gone") {
    // Some device that is in, vouched by a sign-in key this PC has let in for the witness time.
    const active = [...vouchers.keys()].filter((key) => deviceIn(state, key)).map((key) => vouched(key));
    if (!active.some((one) => one.how === "old")) {
      const soon = active.flatMap((one) => (one.how === "new" ? [one.until] : []));
      return no("unvouched", [first], true, soon.length === 0 ? null : Math.min(...soon));
    }
  }
  if (state.carrying) return no("run_open", [], true);
  return { pin: true, admitted: [...new Set([first, ...carried])].sort() };
}

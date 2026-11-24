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
 * (MigrationSeals).
 */
import {
  isListKey, listView, sealEpoch, signCard, signGenesis, signListEntry, wrapKeys,
  type ListNames, type ListSigner, type ListState, type Sealed, type WrittenEntry,
} from "./account-list.ts";

/** How long a PC must have let a key in, and a device must have known a PC, before either is a witness: a day, in seconds. */
export const MIGRATION_WITNESS_SECONDS = 86400;
/**
 * The most devices and PCs one list carries in. With the entry that ends the run and the `epoch` entry after it
 * they are 16 entries, which the account service places in one request, whole or not at all.
 */
export const MIGRATION_CARRIED_MAX = 14;
/** How long a carried device leaves a run that is still open to the first device, before it ends the run itself: ten minutes, in seconds. */
export const MIGRATION_RUN_SECONDS = 600;

const ENDPOINT = /^[0-9a-f]{64}$/;

/** A row of its own, or null: what every object answers to is no row. */
function rowOf<Row>(rows: { readonly [name: string]: Row }, name: string): Row | null {
  return Object.hasOwn(rows, name) ? (rows[name] ?? null) : null;
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A key that somebody let in, and the second (since 1970) from which it has been let in without a break. */
export interface WitnessedKey {
  readonly key: string;
  readonly since: number;
}

/** A device as the account service lists it for the account: the key its sign-in registered, whether the service says a PC lets it in, and its name. */
export interface KnownDevice {
  readonly key: string;
  readonly eligible: boolean;
  readonly names: ListNames | null;
}

/**
 * What a PC answers a device of its account over a session to its own relay key: the device keys it lets in to
 * drive on that account now, each with the second since which it has, and the keys it holds a removal against
 * (a signed removal or block it applied, or a person's Revoke at that PC).
 */
export interface PcAnswer {
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
  /** The key this device's own sign-in registered: it signs entry 0. */
  readonly self: string;
  /** The account's devices as the account service lists them now, in its order. */
  readonly devices: readonly KnownDevice[];
  /** The keys the account service lists as removed. */
  readonly removed: readonly string[];
  readonly pcs: readonly KnownPc[];
}

/**
 * Why a device starts no list now.
 *
 * - `self_unlisted`: the account service does not list this device's own key as one a PC lets in.
 * - `self_removed`: the service, or a PC this device knows, holds a removal against its own key.
 * - `no_witness`: no PC that this device knows by its own record has answered.
 * - `self_unwitnessed`: no such PC lets this device's own key in.
 * - `too_new`: this device's key, or one it would carry in, has been let in for less than a day by every PC that
 *   lets it in; `until` is the second from which that is over.
 */
export type NoMigration = "self_unlisted" | "self_removed" | "no_witness" | "self_unwitnessed" | "too_new";

/**
 * Why a device or a PC is not carried in.
 *
 * - `form`: its key is no key of a list, or its relay key no relay key.
 * - `removed`: the account service lists the key as removed.
 * - `not_eligible`: the service lists the key as one no PC lets in now.
 * - `removed_at_pc`: a PC this device knows holds a removal against the key, whatever the service says.
 * - `unwitnessed`: no PC this device knows lets the key in.
 * - `unknown_pc`: this device has only the account service's word that the relay key is a PC of the person's.
 * - `pc_too_new`: this device has known the relay key for less than a day.
 * - `over_limit`: the list carries MIGRATION_CARRIED_MAX in, and these came after.
 */
export type LeftOut = "form" | "removed" | "not_eligible" | "removed_at_pc" | "unwitnessed" | "unknown_pc" | "pc_too_new" | "over_limit";

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
 * `now` is the device's clock, in seconds since 1970.
 *
 * A device key is carried in only when all hold: the account service lists it as one a PC lets in and not as
 * removed; a PC that this device knows by its own record (ownEvidence) says it has let that key in for at least
 * `age` seconds; and no such PC holds a removal against it. So a key that only the service names gets no place
 * (`unwitnessed`), and neither does one that a PC put out and the service lists again (`removed_at_pc`). A key
 * that such a PC has let in for less than `age` holds the start back (`too_new`): the device asks again later,
 * and nobody presses anything. The device's own key is held to the same.
 *
 * A PC is carried in when the device knows it by its own record, answered or not. Devices come first, in the
 * service's order, then PCs; what is past MIGRATION_CARRIED_MAX is left out. A device that was left out asks to
 * be let in as a new device does, and a PC that was left out is added by a `pc` entry.
 */
export function migrationPlan(known: MigrationKnown, now: number, age: number = MIGRATION_WITNESS_SECONDS): MigrationStart {
  const no = (why: NoMigration, until: number | null = null): MigrationStart => ({ start: false, why, until });
  const removed = new Set(known.removed);
  const witnesses = known.pcs.filter((pc) => ENDPOINT.test(pc.endpoint) && pc.says !== null && ownEvidence(pc, now, age));
  const removedAtPc = (key: string): boolean => witnesses.some((pc) => pc.says?.removed.includes(key) === true);
  /** The second from which some witness has let the key in for `age`: null when none lets it in. */
  const witnessedFrom = (key: string): number | null => {
    const times = witnesses.flatMap((pc) => (pc.says?.admits ?? []).filter((row) => row.key === key && isTime(row.since)).map((row) => row.since + age));
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
  const seen = new Set<string>([known.self]);
  for (const device of known.devices) {
    const { key } = device;
    if (seen.has(key)) continue;
    seen.add(key);
    const from = witnessedFrom(key);
    const why: LeftOut | null = !isListKey(key) ? "form" : removed.has(key) ? "removed" : !device.eligible ? "not_eligible" : removedAtPc(key) ? "removed_at_pc" : from === null ? "unwitnessed" : null;
    if (why !== null) { leftDevices.push({ key, why }); continue; }
    until = Math.max(until, from ?? 0);
    carried.push({ key, names: device.names });
  }
  if (until > now) return no("too_new", until);

  const pcs: { endpoint: string; names: ListNames | null }[] = [];
  const leftPcs: { endpoint: string; why: LeftOut }[] = [];
  const places = new Set<string>();
  for (const pc of known.pcs) {
    const { endpoint } = pc;
    if (places.has(endpoint)) continue;
    places.add(endpoint);
    const why: LeftOut | null = !ENDPOINT.test(endpoint) ? "form" : ownEvidence(pc, now, age) ? null : isTime(pc.since) ? "pc_too_new" : "unknown_pc";
    if (why !== null) leftPcs.push({ endpoint, why });
    else pcs.push({ endpoint, names: pc.names });
  }
  const devices = carried.slice(0, MIGRATION_CARRIED_MAX);
  const room = MIGRATION_CARRIED_MAX - devices.length;
  return {
    start: true,
    plan: {
      devices,
      pcs: pcs.slice(0, room),
      left: {
        devices: [...leftDevices, ...carried.slice(MIGRATION_CARRIED_MAX).map(({ key }) => ({ key, why: "over_limit" as const }))],
        pcs: [...leftPcs, ...pcs.slice(room).map(({ endpoint }) => ({ endpoint, why: "over_limit" as const }))],
      },
    },
  };
}

/** What is not written of a migration, and why. */
export type MigrationRefusalCode = "stopped" | "not_first" | "not_in" | "run_open" | "has_member";

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
 * The entries after entry 0 that the first device still has to place, on the state it holds of its list: a
 * `carried` for each device and PC of the plan that the list does not hold yet, then the `device` entry by
 * which its sign-in key hands its place to its member key (which ends the run: nobody is carried in after it),
 * then the `epoch` entry, since names are no longer sealed under an epoch whose key a key that is out held.
 *
 * It is the same call for the first try and for every later one: on a state that already holds part of the run
 * it signs the rest, on one where the run is over it carries nobody more, and on one where all is done it gives
 * no entry. So a request that did not place, or of which a lying service placed only the beginning, is taken up
 * again from what the log shows. The carried entries and the entry that ends the run are signed by the sign-in
 * key, the `epoch` entry by the member key.
 *
 * Refuses (MigrationError) `stopped` for a member that is stopped for a replay, `not_first` when entry 0 is not
 * this sign-in key's, and `not_in` when neither of the device's keys is a device of the list any more.
 */
export async function signMigrationRun(
  state: ListState, plan: Pick<MigrationPlan, "devices" | "pcs">, device: MigratingDevice, issued_at: number, seals: MigrationSeals,
): Promise<{ readonly entries: readonly WrittenEntry[]; readonly state: ListState }> {
  if (state.needs_replay !== undefined) throw new MigrationError("stopped", "A member that is stopped for a replay writes nothing");
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
  if (deviceIn(after, device.signIn.key)) {
    if (after.carrying) {
      for (const { key, names } of plan.devices) {
        if (rowOf(after.signers, key) !== null || rowOf(after.pc_keys, key) !== null) continue;
        write(await signListEntry(after, { kind: "carried", key, role: "drive", sealed: await sealedNames(names) }, device.signIn, issued_at));
      }
      for (const { endpoint, names } of plan.pcs) {
        if (rowOf(after.pcs, endpoint) !== null) continue;
        write(await signListEntry(after, { kind: "carried", endpoint, sealed: await sealedNames(names) }, device.signIn, issued_at));
      }
    }
    write(await signRotation(after, device, issued_at, await sealedNames(device.names), issued_at));
  } else if (!deviceIn(after, device.member.key)) {
    throw new MigrationError("not_in", "Neither key of this device is a device of this list");
  }
  // Its sign-in key held the key of the epoch, and is out: the next epoch is opened by the member key, which stays.
  if (sealEpoch(after, issued_at) === null && deviceIn(after, device.member.key)) {
    const next = await seals.next(after.list, after.epoch, wrapKeys(after, issued_at));
    write(await signListEntry(after, { kind: "epoch", epoch: after.epoch, opens: next.opens, link: next.link }, device.member, issued_at));
  }
  return { entries, state: after };
}

/**
 * The `device` entry by which a device that is in the list under its sign-in key (the first device, or one that
 * was carried in) hands its place to its member key: signed by the sign-in key, it adds the member key with the
 * device's own card and encryption key and ends the sign-in key. From then on the device is in by a key that
 * outlives its sign-in. `sealed` is the device's names under sealEpoch's epoch, or null for a device that holds
 * no key to the names yet. `now` is the device's clock, in seconds.
 *
 * A device that was carried in writes nothing while the run is open, since any entry of its own would end the
 * run and leave the rest outside: refused `run_open`. The first device ends the run itself. Once the list's own
 * time lies MIGRATION_RUN_SECONDS behind `now` the run counts as given up, and the carried device ends it.
 *
 * Refuses `stopped`, `not_in` for a sign-in key that is no device of power `full` that is in, and `has_member`
 * for a member key the list has held before.
 */
export async function signRotation(state: ListState, device: Pick<MigratingDevice, "signIn" | "member" | "enc">, issued_at: number, sealed: Sealed | null, now: number): Promise<WrittenEntry> {
  if (state.needs_replay !== undefined) throw new MigrationError("stopped", "A member that is stopped for a replay writes nothing");
  const row = rowOf(state.signers, device.signIn.key);
  if (row === null || !deviceIn(state, device.signIn.key) || row.power !== "full") throw new MigrationError("not_in", "This sign-in key is no device of this list that may hand its place on");
  if (rowOf(state.signers, device.member.key) !== null || rowOf(state.pc_keys, device.member.key) !== null) throw new MigrationError("has_member", "The list has held this member key before");
  if (state.carrying && row.seq !== 0 && now - state.full_at < MIGRATION_RUN_SECONDS) throw new MigrationError("run_open", "The first device is still carrying the account in");
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
 * was never a device here. A PC that follows a list asks this for each row it kept by a sign-in key.
 */
export function standsFor(state: ListState, key: string): string | null {
  if (state.needs_replay !== undefined) return null;
  let at = key;
  for (let steps = 0; steps <= state.footing.seq; steps += 1) {
    if (deviceIn(state, at)) return at;
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
 * - `first`: entry 0 is its sign-in key's, which is still in: it has the run to finish (signMigrationRun).
 * - `carried`: its sign-in key was carried in and is still in: it hands its place to its member key
 *   (signRotation) once `wait` is false.
 * - `member`: its member key is in. Nothing is left to do.
 * - `out`: one of its keys was in and none is: it was removed.
 * - `absent`: the list never held a key of its own: it asks to be let in as a new device does.
 */
export type DevicePlace =
  | { readonly at: "first" }
  | { readonly at: "carried"; readonly wait: boolean }
  | { readonly at: "member" }
  | { readonly at: "out" }
  | { readonly at: "absent" };

/**
 * How a device that was signed in before its account had a list learns what became of it: from the list alone,
 * whenever it next reads it. `now` is its clock, in seconds; `wait` is true while the first device is still
 * carrying the account in (signRotation would refuse `run_open`).
 */
export function devicePlace(state: ListState, keys: { readonly signIn: string; readonly member: string }, now: number): DevicePlace {
  if (deviceIn(state, keys.member) || standsFor(state, keys.signIn) === keys.member) return { at: "member" };
  const row = rowOf(state.signers, keys.signIn);
  if (row !== null && deviceIn(state, keys.signIn)) {
    if (row.seq === 0) return { at: "first" };
    return { at: "carried", wait: state.carrying && now - state.full_at < MIGRATION_RUN_SECONDS };
  }
  return row !== null || rowOf(state.signers, keys.member) !== null ? { at: "out" } : { at: "absent" };
}

/**
 * What a PC holds, by its own state, of the devices of its account from before the list.
 *
 * - `admits`: the device keys it lets in to drive on that account now, each with the second since which it has,
 *   read after a whole read of the account service's snapshot since the PC last started. A row that is held
 *   back, waits or only watches is not among them.
 * - `removed`: the keys it holds a removal against: a member's signed removal or block that it applied, or a
 *   person's Revoke at this PC.
 * - `once`: the keys it let in for at least the witness time and then dropped with no removal (the service
 *   stopped listing them, or they expired here). Empty for a PC that keeps no such record.
 */
export interface PcWitness {
  readonly account: string;
  readonly admits: readonly WitnessedKey[];
  readonly removed: readonly string[];
  readonly once: readonly string[];
}

/**
 * Why a PC does not follow a list that carries its account in, the first that applies, in this order.
 *
 * - `stopped`: the PC cannot place an entry of the list (it needs a newer Ovis).
 * - `other_account`: the list is of another account than the PC's.
 * - `first_signer_removed`, `carried_removed`: the PC holds a removal against the key that started the list, or
 *   against a key that was carried in. Following the list would bring back what was put out here.
 * - `first_signer_dropped`, `carried_dropped`: the PC let that key in once and has dropped it since, and the
 *   list still holds it as in.
 * - `first_signer_unknown`, `carried_unknown`: the PC never let that key in.
 * - `first_signer_new`, `carried_new`: the PC lets the key in, for less than the witness time. `until` is the
 *   second from which it has; the PC looks again then and says nothing meanwhile.
 * - `run_open`: every key so far is one the PC lets in, and the list may still carry more in. The PC looks
 *   again at its next read.
 */
export type MigrationRefusal =
  | "stopped" | "other_account"
  | "first_signer_removed" | "carried_removed"
  | "first_signer_dropped" | "carried_dropped"
  | "first_signer_unknown" | "carried_unknown"
  | "first_signer_new" | "carried_new"
  | "run_open";

export type MigrationVerdict =
  /** The PC follows the list: `admitted` is what its pin names (the follower's `migrated` pin), entry 0's signer and every key that was carried in, in ascending order. */
  | { readonly pin: true; readonly admitted: readonly string[] }
  /** `keys`: the keys the refusal is about. `waits`: nothing is wrong so far, and the PC only looks again; otherwise it tells the person. */
  | { readonly pin: false; readonly why: MigrationRefusal; readonly keys: readonly string[]; readonly waits: boolean; readonly until: number | null };

/**
 * Whether a PC that was in its account before the account had a list follows the list it is shown, by its own
 * state alone: all or nothing. `state` is what the PC replayed from entry 0, with nothing pinned yet; `now` is
 * the PC's clock, in seconds.
 *
 * It follows the list only when the key that signed entry 0 and EVERY device key that was carried in, those that
 * are out by now among them, is one this PC let in itself for at least `age` seconds, and the run of `carried`
 * entries is over. A carried key is a signer of power `full`: one this PC never let in could have added whom it
 * liked, so a list that carries a single such key in is a list this PC follows nothing of. A key the PC dropped
 * with no removal counts where the list no longer holds it as in (it handed its place on, or was removed): the
 * list then lets in nobody the PC had stopped letting in.
 *
 * A PC that does not follow goes on as before the list, and nothing here is one-way: it is asked again whenever
 * the list or the PC's own rows change. Only the pin that follows a yes is.
 */
export function migrationVerdict(state: ListState, witness: PcWitness, now: number, age: number = MIGRATION_WITNESS_SECONDS): MigrationVerdict {
  const no = (why: MigrationRefusal, keys: readonly string[], waits = false, until: number | null = null): MigrationVerdict => ({ pin: false, why, keys: [...keys].sort(), waits, until });
  if (state.needs_replay !== undefined) return no("stopped", []);
  if (state.account !== witness.account) return no("other_account", []);
  const first = firstSigner(state);
  if (first === null) return no("stopped", []);
  const carried = listView(state).devices.filter((row) => row.carried).map((row) => row.key);
  const since = new Map<string, number>();
  for (const row of witness.admits) if (isTime(row.since)) since.set(row.key, Math.min(row.since, since.get(row.key) ?? row.since));
  const removed = new Set(witness.removed);
  const once = new Set(witness.once);
  const isIn = (key: string): boolean => rowOf(state.signers, key)?.ended === null;
  type Held = "removed" | "dropped" | "unknown" | "new" | "old";
  const held = (key: string): Held => {
    if (removed.has(key)) return "removed";
    const from = since.get(key);
    if (from !== undefined) return now - from >= age ? "old" : "new";
    if (once.has(key)) return isIn(key) ? "dropped" : "old";
    return "unknown";
  };
  const firstHeld = held(first);
  const of = (what: Held): string[] => carried.filter((key) => held(key) === what);
  for (const what of ["removed", "dropped", "unknown"] as const) {
    if (firstHeld === what) return no(`first_signer_${what}`, [first]);
    if (of(what).length > 0) return no(`carried_${what}`, of(what));
  }
  const until = (keys: readonly string[]): number => Math.max(...keys.map((key) => (since.get(key) ?? now) + age));
  if (firstHeld === "new") return no("first_signer_new", [first], true, until([first]));
  if (of("new").length > 0) return no("carried_new", of("new"), true, until(of("new")));
  if (state.carrying) return no("run_open", [], true);
  return { pin: true, admitted: [...new Set([first, ...carried])].sort() };
}

/**
 * Applying account records to this PC's devices.json (docs/account.md, "Account members" and
 * "Records"). The device list stays the only authority: a record changes it only when its signer is
 * a drive member of this PC's account, and never lets a removed key back in.
 */
import { accountDeviceId, AccountRecordError, ACCOUNT_RECORDS_MAX, parseAccountRecord, verifyAccountRecord, type AccountRecord, type LinkRecord } from "../../shared/account-records.ts";
import type { DeviceStore, LinkArrival } from "../devices.ts";
import type { PairedDevice } from "../../shared/protocol.ts";

export type RecordRefusal = "record_invalid" | "signature_invalid" | "account_mismatch" | "signer_not_member" | "tombstoned" | "link_not_owner" | "account_unavailable" | "enrolling" | "removal_pending";

/** What holds an `add` back on this PC (mailbox.ts `gates`, docs/account.md "Enrolling a PC"). */
export interface AddGates {
  /** the PC waits for the member that linked it first to hand it the account's devices */
  enrolling(): boolean;
  /** a waiting remove or a held key names `key`, or what waits cannot be trusted to be complete */
  held(key: string): boolean;
  /** a remove waiting here names `key` (an add it signed waits until that settles) */
  removing?(key: string): boolean;
}
export type RecordOutcome = { id: string | null; outcome: "applied" | "unchanged" } | { id: string | null; outcome: "refused"; code: RecordRefusal };

async function read(value: unknown): Promise<AccountRecord | { refused: RecordRefusal; id: string | null }> {
  const id = typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : null;
  let record: AccountRecord;
  try { record = parseAccountRecord(value); } catch (error) {
    if (error instanceof AccountRecordError) return { refused: "record_invalid", id };
    throw error;
  }
  return await verifyAccountRecord(record) ? record : { refused: "signature_invalid", id: record.id };
}

/** One `add` or `remove`, after its signature held. A `link` never applies here: only its own row's session sends it. */
function apply(store: DeviceStore, record: AccountRecord, serverId: string | null, now: number, gates?: AddGates): RecordOutcome {
  const refused = (code: RecordRefusal): RecordOutcome => ({ id: record.id, outcome: "refused", code });
  if (record.kind === "link") return refused("link_not_owner");
  if (store.accountError !== null) return refused("account_unavailable");
  const account = store.account();
  if (account !== null && account !== record.account) return refused("account_mismatch");
  // a member of any role may sign the remove of its own key: that is how a device leaves (docs/account.md)
  const leaving = record.kind === "remove" && record.signer === record.key;
  const signer = store.accountSigner(record.signer, record.account, leaving);
  if (!signer) return refused("signer_not_member");
  if (record.kind === "remove") return { id: record.id, outcome: store.removeAccountKey(record.key, record.account, { id: record.id, issuedAt: record.issued_at, by: { device_id: signer.id, label: signer.label }, signed: record }, now) ? "applied" : "unchanged" };
  // the signature covers the signer only: a key off the curve would leave a devices.json no store can read
  if (!store.acceptsRelayKey(record.key)) return refused("record_invalid");
  if (store.isTombstoned(record.key)) return refused("tombstoned");
  if (store.hasKey(record.key)) {
    // kept on the row this signer's approval made here, so a client can hand it to a PC it enrolls later
    store.keepAccountAdd(record, signer.id);
    return { id: record.id, outcome: "unchanged" };
  }
  if (gates?.enrolling()) return refused("enrolling");
  // a key this PC holds back, or a signer it holds back (a remove for it waits here): the add waits for that to settle
  if (gates?.held(record.key) || gates?.removing?.(record.signer)) return refused("removal_pending");
  // the new row's id is derived from this PC's relay id (docs/account.md), so without one there is no row to make
  if (serverId === null) return refused("account_unavailable");
  const id = accountDeviceId(serverId, record.key);
  if (store.has(id)) return refused("record_invalid");
  store.addAccountDevice({ id, key: record.key, label: record.label, role: record.role, account: record.account, addedBy: signer.id, record }, now);
  return { id: record.id, outcome: "applied" };
}

/**
 * A remove refused only because its signer is not a member here yet, handed to `wait` before the next
 * record applies, so an add for the same key later in the batch already meets it (AddGates.held).
 * One `wait` could not keep is undecided (`account_unavailable`): its sender tries again.
 */
function waited(outcome: RecordOutcome, record: AccountRecord, value: unknown, wait: ((record: unknown) => boolean) | undefined, undecided: Set<string>): RecordOutcome {
  if (wait === undefined || record.kind !== "remove" || outcome.outcome !== "refused" || outcome.code !== "signer_not_member") return outcome;
  if (wait(value)) return outcome;
  // not kept anywhere: the rest of the batch still treats its key as removed
  undecided.add(record.key);
  return { id: outcome.id, outcome: "refused", code: "account_unavailable" };
}

/** `gates` with the keys of this batch's removes that could not be kept: an add for one is held back too. */
function withUndecided(gates: AddGates | undefined, undecided: ReadonlySet<string>): AddGates {
  return { enrolling: () => gates?.enrolling() ?? false, held: (key) => undecided.has(key) || (gates?.held(key) ?? false), removing: (key) => undecided.has(key) || (gates?.removing?.(key) ?? false) };
}

/** Every record of a batch, in order; one refusal never fails the rest. At most ACCOUNT_RECORDS_MAX. */
export async function applyAccountRecords(store: DeviceStore, values: readonly unknown[], serverId: string | null, now = Date.now(), gates?: AddGates, wait?: (record: unknown) => boolean): Promise<RecordOutcome[]> {
  if (values.length > ACCOUNT_RECORDS_MAX) throw new RangeError(`At most ${ACCOUNT_RECORDS_MAX} records at once`);
  const outcomes: RecordOutcome[] = [];
  const undecided = new Set<string>();
  const batchGates = withUndecided(gates, undecided);
  for (const value of values) {
    const record = await read(value);
    outcomes.push("refused" in record ? { id: record.id, outcome: "refused", code: record.refused } : waited(apply(store, record, serverId, now, batchGates), record, value, wait, undecided));
  }
  return outcomes;
}

/**
 * An enrollment (POST /api/account/enroll, docs/account.md "Enrolling a PC"), in the server's order
 * whatever the client's: every `remove` first, in the order signed, then the `add`s in rounds, so an
 * add whose signer another add of the batch lets in applies in the next round. After each round
 * `settle` retries what waits here, so a remove whose signer just became a member applies before the
 * next round's adds. `wait` keeps a remove refused only for its signer; false when it could not.
 */
export async function applyEnrollment(store: DeviceStore, values: readonly unknown[], serverId: string | null, options: {
  gates: AddGates; wait: (record: unknown) => boolean; settle: () => Promise<unknown>; now?: number;
}): Promise<RecordOutcome[]> {
  const now = options.now ?? Date.now();
  const undecided = new Set<string>();
  const gates = withUndecided(options.gates, undecided);
  const outcomes: (RecordOutcome | undefined)[] = values.map(() => undefined);
  const records = await Promise.all(values.map(read));
  const removes: number[] = [];
  let adds: number[] = [];
  records.forEach((record, index) => {
    if ("refused" in record) outcomes[index] = { id: record.id, outcome: "refused", code: record.refused };
    else if (record.kind === "remove") removes.push(index);
    else adds.push(index);
  });
  const record = (index: number): AccountRecord => {
    const value = records[index];
    if (value === undefined || "refused" in value) throw new Error("Only a record that verified is applied");
    return value;
  };
  const signed = (index: number) => record(index).issued_at;
  for (const index of removes.sort((a, b) => signed(a) < signed(b) ? -1 : signed(a) > signed(b) ? 1 : 0)) {
    outcomes[index] = waited(apply(store, record(index), serverId, now, gates), record(index), values[index], options.wait, undecided);
  }
  for (let progress = true; progress && adds.length;) {
    progress = false;
    const next: number[] = [];
    for (const index of adds) {
      const outcome = apply(store, record(index), serverId, now, gates);
      outcomes[index] = outcome;
      if (outcome.outcome === "refused" && outcome.code === "signer_not_member") next.push(index);
      else if (outcome.outcome === "applied") progress = true;
    }
    adds = next;
    if (progress) await options.settle();
  }
  return outcomes.map((outcome) => {
    if (outcome === undefined) throw new Error("Every record of an enrollment has an outcome");
    return outcome;
  });
}

export type LinkRefusal = RecordRefusal | "key_in_use" | "link_required";

/** What a link is held to on this PC besides its devices (server/account/routes.ts). */
export interface LinkRules {
  /** what holds a key back here (mailbox.ts `gates`) */
  gates?: AddGates;
  /**
   * For a row that waits to link: called once its link has passed every check, in the turn that writes its row and
   * before that write. It puts on disk what must be there first (the enrollment barrier), and returns what takes
   * that back, should the row not be written.
   */
  barrier?: () => () => void;
  /**
   * the account this PC's signed-in owner named for it, read when the link is judged; null for none. A row that
   * waits to link is taken into that account alone, so with none named it is taken into none
   */
  setUpFor?: () => string | null;
}

/** A link that was refused: by which check, and in words of its own where the code alone does not say what to do. */
export interface LinkRefused { refused: LinkRefusal; message?: string }

/** What a device reads when its link names another account than the one this PC was set up for: the way out is on the PC. */
const SET_UP_FOR_ANOTHER_ACCOUNT = "This PC was set up for another Ovis account than the one this device is signed in to. To add it to this device's account instead, run `ovis add` on the PC again and sign in there with that account.";

/** What a device that waited to link reads when no account was named for this PC: the way on is on the PC too. */
const SET_UP_FOR_NO_ACCOUNT = "This PC is not set up for an Ovis account yet. Sign in on the PC and add it to your account, or run `ovis add` there; then scan its QR code again.";

/**
 * A `link` from the device `deviceId` over its own session to the PC `serverId`. It needs no
 * member: the session is its authority, which is how a PC gets its first one.
 *
 * Only the record's parsing and its signature check wait. From there to the answer nothing does: every check and
 * the write run in one turn, so two links that both passed their signature check never both write. `arrival`: what
 * stood when the link arrived, before that wait (DeviceStore.linkArrived).
 */
export async function applyLink(store: DeviceStore, value: unknown, session: { deviceId: string; serverId: string; sessionKey: string; sessionId?: string }, arrival: LinkArrival, rules: LinkRules = {}): Promise<{ device: PairedDevice } | LinkRefused> {
  const { deviceId, serverId, sessionKey, sessionId } = session;
  const record = await read(value);
  if ("refused" in record) return { refused: record.refused };
  if (record.kind !== "link") return { refused: "record_invalid" };
  const link: LinkRecord = record;
  // a session signed in with an older key of the row cannot move it on: only the key it proved may be replaced
  if (link.server_id !== serverId || link.device_id !== deviceId || link.old_key !== sessionKey) return { refused: "link_not_owner" };
  if (store.accountError !== null) return { refused: "account_unavailable" };
  // What the row is now, after the wait above. One that waited to link when its link arrived and has gone since
  // (its time ran out, its code ended) is gone: its link is never judged as a device's
  const waits = arrival.provisional && store.provisionalStands(deviceId);
  if (arrival.provisional && !waits && !store.has(deviceId)) return { refused: "link_required" };
  const account = store.account();
  if (account !== null && account !== link.account) return { refused: "account_mismatch" };
  // A PC in no account that its signed-in owner set up for one (POST /api/account/relay-account, as `ovis add` sends
  // it before it shows its code) takes its first member from that account. A link that names another is refused: a
  // row that waits to link goes at once, a device keeps what it had, and no code is ended
  const expected = account === null ? rules.setUpFor?.() ?? null : null;
  if (expected !== null && expected !== link.account) {
    if (waits) store.turnAway(deviceId);
    return { refused: "account_mismatch", message: SET_UP_FOR_ANOTHER_ACCOUNT };
  }
  // A row that waits to link is taken into the account this PC was set up for and into no other: with none named it
  // is refused the same way, and goes at once
  if (waits && expected === null) {
    store.turnAway(deviceId);
    return { refused: "account_mismatch", message: SET_UP_FOR_NO_ACCOUNT };
  }
  // A removed key stays out. One comes back: a key this PC removed itself (Revoke, Revoke all), with a row that
  // waits to link and keeps the key it paired with. The link's write clears that tombstone, which stood when the row
  // paired: a removal made since took the row with it (DeviceStore.dropWaiting). A key an account removed stays out
  // of such a row too, and its removal stands
  if (store.isTombstoned(link.key) && !(waits && link.key === link.old_key && !store.removedByAccount(link.key))) return { refused: "tombstoned" };
  // a row moving to a key this PC holds back would let that key in without anyone approving it here
  if (link.key !== link.old_key && rules.gates?.held(link.key)) return { refused: "removal_pending" };
  if (store.keyHeldByOther(link.key, deviceId)) return { refused: "key_in_use" };
  const takeBack = waits ? rules.barrier?.() : undefined;
  let device: PairedDevice | null = null;
  try { device = store.linkAccountKey(deviceId, link.old_key, link.key, link.account, sessionId); }
  finally {
    // the row was not written: what went to disk for it goes too. Whatever kept the row from being written is the
    // failure to report, so a barrier that could not be taken back either is said beside it
    if (device === null) {
      try { takeBack?.(); }
      catch (left) { console.error(`[account] the enrollment barrier of a link that was not written could not be taken back: ${left instanceof Error ? left.message : String(left)}`); }
    }
  }
  return device ? { device } : { refused: "link_not_owner" };
}

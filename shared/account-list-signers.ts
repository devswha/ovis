/**
 * The signed list's signers, and what a member does with an entry it cannot read. The envelope
 * under it is shared/account-list-entry.ts (docs/account-list.md). From an entry's `adds`, `power`
 * and `ends` alone this file keeps who may sign; with the member's level it tells what a member
 * does with one entry; and it holds loose entries, the footing and going back as a function over
 * what the member holds and what it is shown. It does no I/O and reads no clock: the caller reads
 * the log and stores the entries. What a kind's own fields mean is not here.
 */
import {
  ListEntryError, entryFromText, entryHash, entryHolds, firstState, isListHash, isListKey, readBody,
  type Entry, type EntryBody, type HeldEntry, type ListRefusalCode, type SignerPower,
} from "./account-list-entry.ts";

/** Why an entry that holds is passed over: its signer is no signer then, or a field it carries is not lawful then. */
export type PassedOverCode = "signer_unknown" | "signer_not_allowed" | "key_reused" | "already_out";

/** An entry's place in the list, and its hash. */
export interface ListPlace {
  readonly seq: number;
  readonly hash: string;
}

/**
 * What the state keeps of one key that was made a signer. A row is never deleted: a key that was
 * ended stays, with the power it had. A row is frozen when it is made: states share their rows, so
 * no row is ever written, and the row of a key that goes is a new one.
 */
export interface SignerRow {
  readonly power: SignerPower;
  /** The place of the entry that made it a signer. */
  readonly seq: number;
  /**
   * That entry's signer: its own key for entry 0. Null where a later kind's proof made it a signer
   * (above level 1 only): the keys that entry 0 or an `adds` made signers are the rows whose `by` is
   * not null, and the signers' rule for `adds` turns on that.
   */
  readonly by: string | null;
  /** The place of the entry that ended it, or null: it is a signer while this is null. */
  readonly ended: number | null;
}

/**
 * What a member's entries gave it, as plain data: JSON saves it and readSignersState reads it again.
 * Its head is not in it, and dropping loose entries never changes it. The state of the kinds' own
 * rules begins with these members.
 */
export interface SignersState {
  /** The level it was made by. After an update the member replays every entry it kept by its new level. */
  readonly level: number;
  /** The list id. */
  readonly list: string;
  /** The last entry it holds that is not loose, entry 0 at the least: every entry up to it is part of the list for good. */
  readonly footing: ListPlace;
  /** What the list needs: the highest `v` among its entries that are not passed over and that a `full` signer signed. */
  readonly needs: number;
  /** The place of the entry from which the member is behind, or null: it is behind exactly when its level is below `needs`. */
  readonly behind: number | null;
  /** One row for each key that was made a signer, named by that key. A key is a signer while its row's `ended` is null; the first signer is the row whose `seq` is 0. */
  readonly signers: { readonly [key: string]: SignerRow };
}

/** What a member holds: every entry it took, from entry 0, each as its one text, and what they gave it. */
export interface ListMember {
  readonly entries: readonly string[];
  readonly state: SignersState;
}

/**
 * For a member of a higher level: what the kind of an entry it reads lets in on a proof of its own,
 * as the key and the power that kind names, or null. Level 1
 * defines no such kind, so a member of level 1 passes none. A proof lets in the signer of its own
 * entry only, and only a key that was never made a signer in any way. So it is asked for an entry
 * the member reads, also while it is behind, that carries no `adds` and no `ends` and whose signer
 * has no row; it gets the state the entry is judged on, to read while it is asked. It must not keep
 * that state: inside one answer, or one replay, the rows are copied once and then written, so the
 * rows of the entries after this one are written into the object it was handed. When it names that
 * signer, the key is a signer from the next entry on, and the entry is read and is part of the list
 * for that member. In every other case the entry is one whose signer is no signer: passed over,
 * and loose.
 */
export type KeyProof = (entry: HeldEntry, state: SignersState) => { readonly key: string; readonly power: SignerPower } | null;

/**
 * What a member did with an entry that holds; an entry that does not hold stops it (ListStop).
 * `power` is its signer's power at that place. `behind` says that the member is behind there: its
 * kind lets nobody new in, and a removal still applies.
 */
export type TakenOutcome =
  /** Nothing in it applies. It is loose when its signer is no signer for the member. */
  | { readonly outcome: "passed_over"; readonly code: PassedOverCode; readonly loose: boolean }
  /** Its `v` is above the member's level: `adds` and `ends` have applied, and its kind does nothing. */
  | { readonly outcome: "cannot_read"; readonly power: SignerPower; readonly behind: boolean }
  /** Its `v` is at most the member's level: `adds` and `ends` have applied, and its kind's rule reads it. `power` is null when it is read on a proof of its own. */
  | { readonly outcome: "reads"; readonly power: SignerPower | null; readonly behind: boolean };

export interface TakenEntry {
  readonly held: HeldEntry;
  readonly outcome: TakenOutcome;
}

/** The entry a member stopped at: it takes neither that entry nor any after it, keeps its head and its state, and asks again. */
export interface ListStop {
  readonly seq: number;
  readonly code: ListRefusalCode;
}

/** One answer of the log, as the caller read it. */
export interface ShownAnswer {
  /**
   * The place the entries follow: the place the caller asked after. It is the caller's own number,
   * never read from the answer: taken from the answer's first entry, it would let a service reach
   * the RangeError of shownEntries.
   */
  readonly after: number;
  /** The entries after that place, in order, each as its one text. */
  readonly entries: readonly string[];
  /** The head the answer names. */
  readonly head: ListPlace;
}

export interface ShownResult {
  /** What the member holds after the answer. */
  readonly member: ListMember;
  /** The place from which it dropped its own entries, or null. They were loose, so nothing in its state rested on them. */
  readonly dropped_from: number | null;
  /** The entries it took, in order, each with what it did with it. */
  readonly took: readonly TakenEntry[];
  readonly stopped: ListStop | null;
  /** It stopped because it is shown another history under its footing, which no going back mends. */
  readonly stuck: boolean;
  /** It learned of another continuation: the caller reads the entries after this place, its footing, and shows them. Null otherwise. */
  readonly asks_after: number | null;
}

export interface ReplayResult {
  /** Null when there is no entry 0 or it does not hold. */
  readonly member: ListMember | null;
  readonly took: readonly TakenEntry[];
  readonly stopped: ListStop | null;
}

/** The row of a key that was ever made a signer, or null. Only a row of its own counts: what every object answers to is no row. */
function rowOf(signers: SignersState["signers"], key: string): SignerRow | null {
  return Object.hasOwn(signers, key) ? (signers[key] ?? null) : null;
}

/** The power of a key that is a signer in this state, or null. */
export function signerPower(state: SignersState, key: string): SignerPower | null {
  const row = rowOf(state.signers, key);
  return row !== null && row.ended === null ? row.power : null;
}

/** A member is behind exactly when its level is below what its own copy needs. */
export function isBehind(state: SignersState): boolean {
  return state.behind !== null;
}

/** The signers' rules: entry 0 makes its own signer the first signer, with power `full`; it is the footing at the least, and its `v` is the first that the list needs. */
export function firstSignersState(first: HeldEntry, level: number): SignersState {
  const { signer, v } = first.body;
  const at = { seq: 0, hash: first.hash };
  return { level, list: first.hash, footing: at, needs: v, behind: v > level ? 0 : null, signers: { [signer]: Object.freeze({ power: "full", seq: 0, by: signer, ended: null }) } };
}

/** The signers' rules for `adds` and for `ends`, both judged on the state before the entry: the code of the first clause that is not lawful (for `adds`, then for `ends`; in each the signer's power, then the key), or null. */
function unlawful(state: SignersState, power: SignerPower, { adds, ends, signer }: EntryBody): PassedOverCode | null {
  if (adds !== undefined) {
    if (power !== "full") return "signer_not_allowed";
    const row = rowOf(state.signers, adds.key);
    if (row !== null && row.by !== null) return "key_reused";
  }
  if (ends !== undefined) {
    if (power !== "full" && ends !== signer) return "signer_not_allowed";
    if (signerPower(state, ends) === null) return "already_out";
  }
  return null;
}

/** What one entry that holds does to a state, before anything is copied. */
interface Judged {
  readonly outcome: TakenOutcome;
  /** No signer signed it and no kind let its signer in: the footing stays where it is. */
  readonly loose: boolean;
  readonly needs: number;
  readonly behind: number | null;
  /** The rows it writes, each by its key: the key that comes in, then the key that goes. */
  readonly rows: readonly (readonly [string, SignerRow])[];
}

/** What a member does with one entry that holds on this state's list, by the signers' rules. It reads no row but those the entry names, and writes none. */
function judge(state: SignersState, held: HeldEntry, proof: KeyProof | undefined): Judged {
  const { adds, ends, seq, signer, v } = held.body;
  const { needs, behind } = state;
  const power = signerPower(state, signer);
  const reads = v <= state.level;
  if (power === null) {
    // Nobody the member knows has vouched for it, unless a kind it reads lets this entry's own signer in on a proof, and only a key that has no row.
    const asked = reads && adds === undefined && ends === undefined && proof !== undefined && rowOf(state.signers, signer) === null ? proof(held, state) : null;
    if (asked === null || asked.key !== signer) return { outcome: { outcome: "passed_over", code: "signer_unknown", loose: true }, loose: true, needs, behind, rows: [] };
    return { outcome: { outcome: "reads", power: null, behind: behind !== null }, loose: false, needs, behind, rows: [[signer, Object.freeze({ power: asked.power, seq, by: null, ended: null })]] };
  }
  const code = unlawful(state, power, held.body);
  if (code !== null) return { outcome: { outcome: "passed_over", code, loose: false }, loose: false, needs, behind, rows: [] };

  // `adds` and `ends` always apply, read or not: first the key that comes in, then the key that goes. One key in both goes with the row that the `adds` gave it.
  const rows: (readonly [string, SignerRow])[] = [];
  let comes: SignerRow | null = null;
  if (adds !== undefined) {
    comes = Object.freeze({ power: adds.power, seq, by: signer, ended: null });
    rows.push([adds.key, comes]);
  }
  if (ends !== undefined) {
    const goes = adds?.key === ends ? comes : rowOf(state.signers, ends);
    if (goes !== null) rows.push([ends, Object.freeze({ ...goes, ended: seq })]);
  }
  const counts = power === "full";
  const behindAfter = behind ?? (counts && !reads ? seq : null);
  return {
    outcome: reads ? { outcome: "reads", power, behind: behind !== null } : { outcome: "cannot_read", power, behind: behindAfter !== null },
    loose: false,
    needs: counts && v > needs ? v : needs,
    behind: behindAfter,
    rows,
  };
}

/** The state after an entry, with these rows. The footing is the last entry that is not loose. */
function stateAfter(state: SignersState, held: HeldEntry, judged: Judged, signers: SignersState["signers"]): SignersState {
  const footing = judged.loose ? state.footing : { seq: held.body.seq, hash: held.hash };
  return { ...state, footing, needs: judged.needs, behind: judged.behind, signers };
}

/**
 * What a member does with one entry that holds on this state's list: whether it is passed over, and
 * if not, the signers after it and whether the member can read it. An entry that one of the signers
 * signed moves the footing, also when it is passed over for a field that is not lawful. It reads no
 * row but those the entry names: its signer's, and those of the keys in `adds` and `ends`. It
 * changes nothing it was given.
 */
export function judgeEntry(state: SignersState, held: HeldEntry, proof?: KeyProof): { readonly outcome: TakenOutcome; readonly state: SignersState } {
  const judged = judge(state, held, proof);
  const signers = judged.rows.length === 0 ? state.signers : { ...state.signers, ...Object.fromEntries(judged.rows) };
  return { outcome: judged.outcome, state: stateAfter(state, held, judged, signers) };
}

/** A member's rows while it takes entries: one copy that every entry of the same run writes into. An answer makes it when it arrives; a replay when an entry first writes a row, and until then its rows are the state's own. */
type Rows = { [key: string]: SignerRow };

/**
 * One entry that holds, taken: the state after it and what the member did with it. `rows` is the
 * copy that this answer, or this replay, writes its rows into. While a replay has none it is null:
 * the member's rows are copied when an entry writes a row, once, and not once for every entry.
 */
function takeEntry(state: SignersState, rows: Rows | null, held: HeldEntry, proof: KeyProof | undefined): { readonly state: SignersState; readonly rows: Rows | null; readonly outcome: TakenOutcome } {
  const judged = judge(state, held, proof);
  let written = rows;
  if (judged.rows.length > 0) {
    written ??= { ...state.signers };
    // Each key is one of an entry that holds, so it is a key in form and never a name that an object has of itself.
    for (const [key, row] of judged.rows) written[key] = row;
  }
  return { state: stateAfter(state, held, judged, written ?? state.signers), rows: written, outcome: judged.outcome };
}

/** An entry of the member's own copy as it holds. It was checked when it was taken, so only its text is read again. */
function ownEntry(entries: readonly string[], seq: number, list: string): HeldEntry {
  const text = entries[seq];
  if (text === undefined) throw new RangeError(`The member holds no entry ${seq}`);
  const entry = entryFromText(text);
  return { entry, body: readBody(entry.body), hash: entryHash(entry.body), list };
}

/** The member's head: the last entry it took. */
export function listHead(member: ListMember): ListPlace {
  const seq = member.entries.length - 1;
  return { seq, hash: ownEntry(member.entries, seq, member.state.list).hash };
}

function refusalOf(error: unknown): ListRefusalCode {
  if (error instanceof ListEntryError) return error.code;
  throw error;
}

type Fit =
  | { readonly fit: "holds"; readonly held: HeldEntry }
  /** It fails only in that it does not continue `before`: it would hold on another entry at that place. */
  | { readonly fit: "elsewhere" }
  | { readonly fit: "no"; readonly code: ListRefusalCode };

async function fits(entry: Entry, before: HeldEntry): Promise<Fit> {
  let code: ListRefusalCode;
  try {
    return { fit: "holds", held: await entryHolds(entry, before) };
  } catch (error) {
    code = refusalOf(error);
  }
  if (code !== "chain_broken") return { fit: "no", code };
  const { prev } = readBody(entry.body);
  if (prev === "" || prev === before.hash) return { fit: "no", code };
  try {
    await entryHolds(entry, { ...before, hash: prev });
    return { fit: "elsewhere" };
  } catch (error) {
    if (!(error instanceof ListEntryError)) throw error;
    return { fit: "no", code };
  }
}

/**
 * What a member does with one answer of the log, entry by entry. The caller asked for the
 * entries after a place the member holds: its head, or its footing when it goes back.
 *
 * - An entry that is the same entry as its own at that place changes nothing.
 * - An entry past its head is taken as judgeEntry judges it, or stops it when it does not hold.
 * - It learns of another continuation when an entry does not continue the entry before it and that
 *   entry is loose (its head, or a loose entry before it), or when the answer's `head` lies past
 *   its footing and at or before its own head with another hash than its own entry there:
 *   `asks_after` then names its footing.
 * - Among the entries after its footing, at the first place where it is shown another entry that
 *   holds there, it drops its own entries from that place on and takes what it is shown.
 * - Another history under its footing stops it for good (`stuck`): an entry does not continue the
 *   entry before it, which stands at or under the footing, or `head` lies at or before the footing
 *   with another hash.
 *
 * The footing moves with each entry that the member takes, also inside one answer: an entry that
 * does not continue the footing is the first entry after it wherever it stands in an answer. The
 * answer's `head` is held against the member's head and footing when the answer arrives, and as
 * they stand after each entry that the member takes, and not after an entry that is the same as
 * its own: its own entries past that one may be those that the answer goes on to replace, as they
 * may be when an answer arrives that follows a place before its head. Once the head says one of
 * the two things above, the member takes no further entry of that answer. So what a member does
 * with an honest answer never depends on where it was cut.
 *
 * `asks_after` is the member's next request at its own pace: at most one such request follows an
 * answer at once and anything more waits for its next poll, which the caller must keep to since no
 * function here can count requests (without it a lying service makes a member send requests as
 * fast as it answers them).
 *
 * After an entry that does not hold, or an answer that breaks off, the member's head stands at the
 * last entry it took, and what it dropped stays dropped. A member's own entry comes into its copy
 * only here, when the log shows it at its place, never from the answer to its post.
 *
 * A place the member does not hold for the answer to follow, or a state whose footing is not the
 * member's own entry at that place, is the caller's mistake: a RangeError, and nothing is judged.
 *
 * The member and the answer are read once, before a signature is awaited: the member's entries,
 * its state and its rows, and the answer's entries and its head are copied (a frozen row is kept
 * as it is). What comes back is built from those copies alone, so it is of the member and of the
 * answer as they were handed over, whatever the caller does to either meanwhile or later.
 */
export async function shownEntries(member: ListMember, answer: ShownAnswer, proof?: KeyProof): Promise<ShownResult> {
  const { after } = answer;
  const head: ListPlace = { ...answer.head };
  const shown = [...answer.entries];
  const entries = [...member.entries];
  const handed = { ...member.state };
  let rows: Rows | null = Object.fromEntries(Object.entries(handed.signers).map(([key, row]) => [key, Object.isFrozen(row) ? row : Object.freeze({ ...row })]));
  /** The footing is read from here wherever it is asked for: it moves with each entry that the member takes and that is not loose, also inside this answer. */
  let state: SignersState = { ...handed, footing: { ...handed.footing }, signers: rows };
  const { list } = state;
  const top = entries.length - 1;
  if (!Number.isInteger(after) || after < 0 || after > top) throw new RangeError(`The member holds no entry ${after} for the answer to follow`);
  if (ownEntry(entries, state.footing.seq, list).hash !== state.footing.hash) throw new RangeError(`The member's entry ${state.footing.seq} is not its footing: this state is not that of these entries`);
  const took: TakenEntry[] = [];
  let dropped: number | null = null;
  const done = (rest: Partial<Pick<ShownResult, "stopped" | "stuck" | "asks_after">> = {}): ShownResult =>
    ({ member: { entries, state }, dropped_from: dropped, took, stopped: null, stuck: false, asks_after: null, ...rest });
  const stops = (seq: number, code: ListRefusalCode) => done({ stopped: { seq, code } });
  const stuck = (seq: number) => done({ stopped: { seq, code: "chain_broken" }, stuck: true });

  /** The place that the answer's head names; -1 for what is no place. */
  const headSeq = Number.isInteger(head.seq) && head.seq >= 0 ? head.seq : -1;
  /** The hash of the member's own entry at that place, as it stands; null while it holds none there. */
  let atHead = headSeq >= 0 && headSeq <= top ? ownEntry(entries, headSeq, list).hash : null;
  /**
   * The answer's head, held against the member's head and footing as they stand: when the answer
   * arrives, and after each entry that the member takes. `follows` is the place that the rest of
   * the answer follows. Where the member holds another entry at the head's place: at or under its
   * footing it is another history; past its footing it is another continuation, when the rest of
   * the answer follows the member's head. After an entry it takes that is always so. An answer
   * that arrives after a place before its head says nothing of another continuation: it may go on
   * to replace the member's loose entries.
   */
  const byHead = (follows: number): ShownResult | null => {
    if (atHead === null || atHead === head.hash) return null;
    if (headSeq <= state.footing.seq) return stuck(headSeq);
    return follows === entries.length - 1 ? done({ asks_after: state.footing.seq }) : null;
  };

  let before = ownEntry(entries, after, list);
  /** What the head says of the member as it stands before the next entry: null, or where the answer ends for it. */
  let caught = byHead(after);
  for (const [index, text] of shown.entries()) {
    if (caught !== null) return caught;
    const seq = after + 1 + index;
    let entry: Entry;
    try {
      entry = entryFromText(text);
    } catch (error) {
      return stops(seq, refusalOf(error));
    }
    const own = seq < entries.length ? ownEntry(entries, seq, list) : null;
    // The same entry as its own: nothing changes, and the head is not held again here.
    if (own !== null && entryHash(entry.body) === own.hash) {
      before = own;
      continue;
    }
    const fit = await fits(entry, before);
    if (fit.fit === "no") return stops(seq, fit.code);
    // It does not continue the entry before it. Where that entry stands at or under the footing, it is another history under it; where it is loose, another continuation.
    if (fit.fit === "elsewhere") return seq - 1 <= state.footing.seq ? stuck(seq) : done({ asks_after: state.footing.seq });
    if (seq <= state.footing.seq) return stuck(seq);
    if (own !== null) {
      entries.length = seq;
      dropped = seq;
    }
    const taken = takeEntry(state, rows, fit.held, proof);
    state = taken.state;
    rows = taken.rows;
    entries.push(text);
    took.push({ held: fit.held, outcome: taken.outcome });
    before = fit.held;
    // Its entries from this place on are those it has taken: at the head's place this one, and past this place none yet.
    if (seq <= headSeq) atHead = seq === headSeq ? fit.held.hash : null;
    caught = byHead(seq);
  }
  return caught ?? done();
}

/**
 * A member's entries from entry 0, each taken by its level: how it starts, and how it replays every
 * entry it kept after an update. Given a list id, only the entry with that hash is entry 0.
 *
 * A replay is given every entry it has and has nobody to ask, so it never goes back and no service
 * showed it anything to be stuck on: each entry holds on the one before it (docs/account-list.md,
 * "When an entry holds"), or the replay stops there, with that entry's refusal. Its result either
 * took every entry it was given, or names where it stopped. The entries, the list id and the
 * proof are read once, before a signature is awaited.
 */
export async function replayEntries(entries: readonly string[], level: number, options: { readonly given?: string; readonly proof?: KeyProof } = {}): Promise<ReplayResult> {
  const [text, ...rest] = entries;
  const { given, proof } = options;
  if (text === undefined) return { member: null, took: [], stopped: null };
  let before: HeldEntry;
  try {
    before = (await firstState(entryFromText(text), given)).first;
  } catch (error) {
    return { member: null, took: [], stopped: { seq: 0, code: refusalOf(error) } };
  }
  let state = firstSignersState(before, level);
  let rows: Rows | null = null;
  const kept = [text];
  const took: TakenEntry[] = [{ held: before, outcome: before.body.v > level ? { outcome: "cannot_read", power: "full", behind: true } : { outcome: "reads", power: "full", behind: false } }];
  for (const [index, next] of rest.entries()) {
    let held: HeldEntry;
    try {
      held = await entryHolds(entryFromText(next), before);
    } catch (error) {
      return { member: { entries: kept, state }, took, stopped: { seq: index + 1, code: refusalOf(error) } };
    }
    const taken = takeEntry(state, rows, held, proof);
    state = taken.state;
    rows = taken.rows;
    kept.push(next);
    took.push({ held, outcome: taken.outcome });
    before = held;
  }
  return { member: { entries: kept, state }, took, stopped: null };
}

/**
 * A member signs an entry only on its footing. The place its next entry takes, or null when the
 * head it is shown lies past its footing: it then places nothing, says so, and asks again.
 */
export function signingPlace(member: ListMember, shown: ListPlace): { readonly list: string; readonly prev: string; readonly seq: number } | null {
  const { footing, list } = member.state;
  return shown.seq > footing.seq ? null : { list, prev: footing.hash, seq: footing.seq + 1 };
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A saved row, read again, for the key that names it; null for anything that has not its form. */
function readSignerRow(key: string, value: unknown, footing: number): SignerRow | null {
  if (!isListKey(key) || !isRecord(value)) return null;
  const { power, seq, by, ended } = value;
  if (power !== "full" && power !== "bound") return null;
  if (!isCount(seq) || seq > footing) return null;
  if (by !== null && typeof by !== "string") return null;
  if (ended !== null && !(isCount(ended) && ended >= seq && ended <= footing)) return null;
  // Entry 0 made its own signer the first signer, with power `full`, and nothing else came in there.
  if (seq === 0 && (by !== key || power !== "full")) return null;
  return Object.freeze({ power, seq, by, ended });
}

/** A saved state, read again: the state when the value has its form and agrees with itself, null for anything else. */
export function readSignersState(value: unknown): SignersState | null {
  if (!isRecord(value)) return null;
  const { level, list, footing, needs, behind, signers } = value;
  if (!isCount(level) || level < 1 || !isCount(needs) || needs < 1) return null;
  if (typeof list !== "string" || !isListHash(list)) return null;
  if (!isRecord(footing) || !isCount(footing.seq) || typeof footing.hash !== "string" || !isListHash(footing.hash)) return null;
  if (footing.seq === 0 && footing.hash !== list) return null;
  if (behind !== null && !(isCount(behind) && behind <= footing.seq)) return null;
  if ((behind !== null) !== (needs > level)) return null;
  if (!isRecord(signers)) return null;
  const rows: { [key: string]: SignerRow } = {};
  for (const [key, saved] of Object.entries(signers)) {
    const row = readSignerRow(key, saved, footing.seq);
    if (row === null) return null;
    rows[key] = row;
  }
  const all = Object.values(rows);
  if (all.filter((row) => row.seq === 0).length !== 1) return null;
  // A row's `by` is null or the key of a row: whoever added a key was a signer itself. So it is a key in form too, and no name that every object answers to.
  if (all.some((row) => row.by !== null && rowOf(rows, row.by) === null)) return null;
  return { level, list, footing: { seq: footing.seq, hash: footing.hash }, needs, behind, signers: rows };
}

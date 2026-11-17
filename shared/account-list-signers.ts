/**
 * The signed list's signers, and what a member does with an entry it cannot read. The envelope
 * under it is shared/account-list-entry.ts (docs/account-list.md). From an entry's `adds`, `power`
 * and `ends` alone this file keeps who may sign; with the member's level it tells what a member
 * does with one entry; and it holds loose entries, the footing and going back as a function over
 * what the member holds and what it is shown. It does no I/O and reads no clock: the caller reads
 * the log and stores the entries. What a kind's own fields mean is not here.
 *
 * Every function here takes what a caller hands it once, when it is called: one reader for each
 * type (plainPlace, plainRow, plainRows, plainState, plainTexts, plainMember, plainAnswer,
 * plainHeld) reads each field once, by the name its type gives it, into plain frozen data of this
 * file's own, and a list of bytes into a copy of it. From then on the function reads those copies
 * alone. So nothing decides twice: not what a caller's object says at a second reading, and not
 * what it says once a signature is being awaited. Nothing is taken by a spread, which takes an
 * object's own enumerable fields alone: a field may as well be inherited, or the object's own and
 * not enumerable.
 */
import {
  ListEntryError, entryFromText, entryHash, entryHolds, firstState, isListHash, isListKey, readBody,
  type Entry, type EntryBody, type HeldEntry, type ListField, type ListRefusalCode, type SignerPower,
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
 * ended stays, with the power it had. A row is frozen when it is made: the states of one answer,
 * or of one replay, share their rows, so no row is ever written, and the row of a key that goes is
 * a new one. A function that is handed a state copies its rows, as it copies all of it.
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
 * rules begins with these members. A state that a function of this file gives back is frozen, with
 * its footing and its rows, and has these six, `needs_replay` when it stopped for a replay, and no
 * other: what else the state it was given carries is left out, as readSignersState leaves it out.
 */
export interface SignersState {
  /** The level it was made by: a whole number from 1. After an update the member replays every entry it kept by its new level. */
  readonly level: number;
  /** The list id. */
  readonly list: string;
  /** The last entry it holds that is not loose, entry 0 at the least: every entry up to it is part of the list for good. */
  readonly footing: ListPlace;
  /** What the list needs: the highest `v` among its entries that are not passed over and that a `full` signer signed. A kind lets a key in on a proof only at a level that the list already needs (KeyProof). */
  readonly needs: number;
  /**
   * The place of the entry from which the member is behind, or null: it is behind exactly when its
   * level is below `needs`. Behind, a member goes on only while it holds what a member that reads
   * everything holds, the same rows and the same footing. One entry alone can part the two: an
   * entry for which a kind may let a key in on a proof (KeyProof), which a member that is behind
   * cannot hear. There it stops, also when the proof lets nobody in, which it cannot tell, and it
   * takes no entry until it replays after an update. The stop is kept in the state (`needs_replay`).
   */
  readonly behind: number | null;
  /** One row for each key that was made a signer, named by that key. A key is a signer while its row's `ended` is null; the first signer is the row whose `seq` is 0. */
  readonly signers: { readonly [key: string]: SignerRow };
  /**
   * Only on a member that stopped for a replay (`behind`): the place of the entry at which it
   * stopped. While it is set the member takes no entry, judges none and places none to sign: an
   * answer ends for it with `needs_replay` again, whatever it shows. It is saved and read again
   * with the state. A replay of the member's own entries starts anew: it sets it only where the
   * member stops again, so by the level of an update it is gone. A state has no such member
   * otherwise.
   */
  readonly needs_replay?: number;
}

/** What a member holds: every entry it took, from entry 0, each as its one text, and what they gave it. */
export interface ListMember {
  readonly entries: readonly string[];
  readonly state: SignersState;
}

/**
 * For a member of a higher level: what the kind of an entry it reads lets in on a proof of its own,
 * as the key and the power that kind names, or null. Level 1 defines no such kind, so a member of
 * level 1 passes none. A proof lets in the signer of its own entry only, and only a key that was
 * never made a signer in any way. So a proof may be asked for an entry of a level above 1 that the
 * list already needs (its `v` is above 1 and at most `needs`: a signer of power `full` has signed
 * an entry of that level before it), that carries no `adds` and no `ends`, and whose signer has no
 * row. A member that is not behind reads such an entry and is asked. It gets copies of its own to
 * read, of that entry, bytes and all, and of the state the entry is judged on: whatever it does to
 * them, then or later, changes nothing that the member holds. When it names that signer, the key
 * is a signer from the next entry on, and the entry is read and is part of the list for that
 * member; otherwise the entry is one whose signer is no signer: passed over, and loose. A member
 * that is behind cannot hear the proof, so it cannot tell which of the two the entry is: it stops
 * there (`needs_replay`). So no member goes on past an entry at which another may have let a key
 * in.
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

/** What a member that is behind does with an entry for which a proof may be asked: it cannot place it, and stops there (SignersState.behind). */
export type StopsOutcome = { readonly outcome: "stops"; readonly code: "needs_replay" };

export interface TakenEntry {
  readonly held: HeldEntry;
  readonly outcome: TakenOutcome;
}

/**
 * The entry a member stopped at: it takes neither that entry nor any after it, keeps its head and
 * its state, and asks again. `needs_replay` is the one code of an entry that holds: the member is
 * behind and cannot place the entry (SignersState.behind). It does not ask again for that: it
 * replays after an update.
 */
export interface ListStop {
  readonly seq: number;
  readonly code: ListRefusalCode | "needs_replay";
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
  /** It stopped because it is shown another history under its footing, which no going back mends, or, behind, at an entry it cannot place (`needs_replay`), which only a replay after an update mends. */
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

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** A level: a whole number from 1. The functions that make a state and readSignersState hold to this one rule, so a state that one of them gives has a level that the other takes. */
const isLevel = (value: unknown): value is number => isCount(value) && value >= 1;
/** A level that is no level is the caller's mistake: a RangeError, and no state is made. */
function mustBeLevel(level: number): void {
  if (!isLevel(level)) throw new RangeError(`A level is a whole number from 1, not ${level}`);
}

/*
 * The readers: what a caller hands in, taken once. Each reads every field of its type once, by its
 * name, into a new frozen object of this file's own, and a list of bytes into a copy of it.
 */

/** A place: its seq and its hash. */
const plainPlace = ({ seq, hash }: ListPlace): ListPlace => Object.freeze({ seq, hash });

/** A row: its four fields. */
const plainRow = ({ power, seq, by, ended }: SignerRow): SignerRow => Object.freeze({ power, seq, by, ended });

/** A state's rows: every name they are held under, enumerable or not, and the row under it. What is held under a name and is no row is left out, as rowOf finds none there. */
function plainRows(signers: SignersState["signers"]): SignersState["signers"] {
  const rows: (readonly [string, SignerRow])[] = [];
  for (const key of Object.getOwnPropertyNames(signers)) {
    const row = signers[key] ?? null;
    if (row !== null) rows.push([key, plainRow(row)]);
  }
  return Object.freeze(Object.fromEntries(rows));
}

/** A state: its six members, its footing as a place and its rows as rows. Its level is a level, or it is no state of this file's. */
function plainState(state: SignersState): SignersState {
  const { level, list, footing, needs, behind, signers, needs_replay } = state;
  mustBeLevel(level);
  const plain = { level, list, footing: plainPlace(footing), needs, behind, signers: plainRows(signers) };
  return needs_replay === undefined ? Object.freeze(plain) : stoppedAt(plain, needs_replay);
}

/** The state of a member that stopped for a replay at this place: the same six members, frozen, with `needs_replay`. */
function stoppedAt({ level, list, footing, needs, behind, signers }: SignersState, seq: number): SignersState {
  return Object.freeze({ level, list, footing, needs, behind, signers, needs_replay: seq });
}

/** A list of texts: its length, and then the text at each place. A place that holds none reads as the empty text, which is no entry. */
function plainTexts(texts: readonly string[]): readonly string[] {
  const { length } = texts;
  return Object.freeze(Array.from({ length }, (_, at) => texts[at] ?? ""));
}

/** A member: its entries and its state. */
function plainMember(member: ListMember): ListMember {
  const { entries, state } = member;
  return Object.freeze({ entries: plainTexts(entries), state: plainState(state) });
}

/** An answer: the place it follows, its entries and its head. */
function plainAnswer(answer: ShownAnswer): ShownAnswer {
  const { after, entries, head } = answer;
  return Object.freeze({ after, entries: plainTexts(entries), head: plainPlace(head) });
}

/** A held entry: its entry, every field of its body, its hash and its list id, and a copy of each list of bytes: of its body, of its signature and of the value of each field of its own. */
function plainHeld(held: HeldEntry): HeldEntry {
  const { entry, body, hash, list } = held;
  const { body: bytes, signature } = entry;
  const { issued_at, kind, list: of, prev, seq, signer, v, adds, ends, own } = body;
  const { length } = own;
  const fields: ListField[] = [];
  for (let at = 0; at < length; at++) {
    const field = own[at];
    if (field === undefined) continue;
    const { name, value } = field;
    fields.push(Object.freeze({ name, value: new Uint8Array(value) }));
  }
  const plain: { -readonly [Name in keyof EntryBody]: EntryBody[Name] } = { issued_at, kind, list: of, prev, seq, signer, v, own: Object.freeze(fields) };
  if (adds !== undefined) {
    const { key, power } = adds;
    plain.adds = Object.freeze({ key, power });
  }
  if (ends !== undefined) plain.ends = ends;
  return Object.freeze({ entry: Object.freeze({ body: new Uint8Array(bytes), signature: new Uint8Array(signature) }), body: Object.freeze(plain), hash, list });
}

/** The power of a key that is a signer in this state, or null. */
export function signerPower(state: SignersState, key: string): SignerPower | null {
  const row = rowOf(plainState(state).signers, key);
  return row !== null && row.ended === null ? row.power : null;
}

/** A member is behind exactly when its level is below what its own copy needs. */
export function isBehind(state: SignersState): boolean {
  return plainState(state).behind !== null;
}

/** The state that entry 0 gives, from this file's own copy of that entry. */
function stateOfFirst({ body, hash }: HeldEntry, level: number): SignersState {
  const { signer, v } = body;
  return Object.freeze({ level, list: hash, footing: Object.freeze({ seq: 0, hash }), needs: v, behind: v > level ? 0 : null, signers: Object.freeze({ [signer]: Object.freeze({ power: "full", seq: 0, by: signer, ended: null }) }) });
}

/** The signers' rules: entry 0 makes its own signer the first signer, with power `full`; it is the footing at the least, and its `v` is the first that the list needs. */
export function firstSignersState(first: HeldEntry, level: number): SignersState {
  const held = plainHeld(first);
  mustBeLevel(level);
  return stateOfFirst(held, level);
}

/** The signers' rules for `adds` and for `ends`, both judged on the state before the entry: the code of the first clause that is not lawful (for `adds`, then for `ends`; in each the signer's power, then the key), or null. */
function unlawful(power: SignerPower, signer: string, adds: EntryBody["adds"], added: SignerRow | null, ends: string | undefined, going: SignerRow | null): PassedOverCode | null {
  if (adds !== undefined) {
    if (power !== "full") return "signer_not_allowed";
    // A key that entry 0 or an `adds` made a signer is never added again, and neither is a key that was ended, also one that a proof let in: out is out.
    if (added !== null && (added.by !== null || added.ended !== null)) return "key_reused";
  }
  if (ends !== undefined) {
    if (power !== "full" && ends !== signer) return "signer_not_allowed";
    if (going === null || going.ended !== null) return "already_out";
  }
  return null;
}

/** What one entry that holds does to a state. */
interface Judged {
  /** What the member does with it; `stops` when it cannot place it, and then nothing below is used. */
  readonly outcome: TakenOutcome | StopsOutcome;
  /** No signer signed it and no kind let its signer in: the footing stays where it is. */
  readonly loose: boolean;
  readonly needs: number;
  readonly behind: number | null;
  /** The rows it writes, each by its key: the key that comes in, then the key that goes. */
  readonly rows: readonly (readonly [string, SignerRow])[];
}

const STOPS: StopsOutcome = Object.freeze({ outcome: "stops", code: "needs_replay" });

/**
 * What a member does with one entry that holds on this state's list, by the signers' rules. The
 * state and the entry are this file's own copies. It turns on no row but those the entry names
 * (its signer's, that of the key it adds, that of the key it ends), which it looks up before a
 * proof is asked, and it writes none. A proof may be asked for an entry of a level above 1 that
 * the list already needs, that carries no `adds` and no `ends`, and whose signer has no row: a
 * member that is not behind is asked, and one that is behind stops there. The proof is handed
 * copies of its own (plainHeld, plainState), and what it answers is read once.
 */
function judge(state: SignersState, held: HeldEntry, proof: KeyProof | undefined): Judged {
  const { adds, ends, seq, signer, v } = held.body;
  const { level, needs, behind, signers } = state;
  const own = rowOf(signers, signer);
  const added = adds === undefined ? null : rowOf(signers, adds.key);
  const going = ends === undefined ? null : rowOf(signers, ends);
  const power = own !== null && own.ended === null ? own.power : null;
  const reads = v <= level;
  if (power === null) {
    const passedOver: Judged = { outcome: { outcome: "passed_over", code: "signer_unknown", loose: true }, loose: true, needs, behind, rows: [] };
    // Nobody the member knows has vouched for it. A kind may yet let this entry's own signer in on a proof: a kind of a level above 1 that the list already needs, a key that has no row, an entry that carries no `adds` and no `ends`.
    if (own !== null || v <= 1 || v > needs || adds !== undefined || ends !== undefined) return passedOver;
    // Behind, the member cannot hear that proof, so it cannot tell whether the key came in here: it stops. No member goes on past such an entry without knowing.
    if (behind !== null) return { outcome: STOPS, loose: false, needs, behind, rows: [] };
    const asked = reads && proof !== undefined ? proof(plainHeld(held), plainState(state)) : null;
    if (asked === null) return passedOver;
    const { key, power: lets } = asked;
    if (key !== signer) return passedOver;
    return { outcome: { outcome: "reads", power: null, behind: false }, loose: false, needs, behind, rows: [[signer, Object.freeze({ power: lets, seq, by: null, ended: null })]] };
  }
  const code = unlawful(power, signer, adds, added, ends, going);
  if (code !== null) return { outcome: { outcome: "passed_over", code, loose: false }, loose: false, needs, behind, rows: [] };

  // `adds` and `ends` always apply, read or not: first the key that comes in, then the key that goes. One key in both goes with the row that the `adds` gave it.
  const rows: (readonly [string, SignerRow])[] = [];
  let comes: SignerRow | null = null;
  if (adds !== undefined) {
    comes = Object.freeze({ power: adds.power, seq, by: signer, ended: null });
    rows.push([adds.key, comes]);
  }
  if (ends !== undefined) {
    const goes = adds?.key === ends ? comes : going;
    if (goes !== null) rows.push([ends, Object.freeze({ power: goes.power, seq: goes.seq, by: goes.by, ended: seq })]);
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

/** The state after an entry, with these rows: frozen, with its footing, as every state of this file is. The footing is the last entry that is not loose. */
function stateAfter(state: SignersState, held: HeldEntry, judged: Judged, signers: SignersState["signers"]): SignersState {
  const footing = judged.loose ? state.footing : Object.freeze({ seq: held.body.seq, hash: held.hash });
  return Object.freeze({ level: state.level, list: state.list, footing, needs: judged.needs, behind: judged.behind, signers });
}

/**
 * What a member does with one entry that holds on this state's list: whether it is passed over, and
 * if not, the signers after it and whether the member can read it. An entry that one of the signers
 * signed moves the footing, also when it is passed over for a field that is not lawful. It turns on
 * no row but those the entry names: its signer's, and those of the keys in `adds` and `ends`. A
 * member that is behind stops at an entry for which a proof may be asked (SignersState.behind):
 * the outcome is `stops`, and the state is as it was but for `needs_replay`, which holds the
 * stop. On a state that holds one already, every entry is a `stops`. The state and the entry are
 * taken once (plainState, plainHeld), and the state it gives is made of those copies. It changes
 * nothing it was given. The entry is one that holds on this state's list: the caller says so, and
 * an entry of another list is its mistake, a RangeError.
 */
export function judgeEntry(state: SignersState, held: HeldEntry, proof?: KeyProof): { readonly outcome: TakenOutcome | StopsOutcome; readonly state: SignersState } {
  const given = plainState(state);
  const entry = plainHeld(held);
  if (entry.list !== given.list) throw new RangeError("The entry is of another list than the state");
  // A member that stopped for a replay judges nothing: it is stopped still.
  if (given.needs_replay !== undefined) return { outcome: STOPS, state: given };
  const judged = judge(given, entry, proof);
  if (judged.outcome.outcome === "stops") return { outcome: judged.outcome, state: stoppedAt(given, entry.body.seq) };
  const signers = judged.rows.length === 0 ? given.signers : Object.freeze(Object.fromEntries([...Object.entries(given.signers), ...judged.rows]));
  return { outcome: judged.outcome, state: stateAfter(given, entry, judged, signers) };
}

/**
 * A member's rows while it takes entries: one copy that every entry of the same answer, or of the
 * same replay, writes into. It is made when an entry first writes a row: until then the rows are
 * those of the state that the answer or the replay began with, which are frozen. It is frozen when
 * the answer or the replay ends. No proof is handed it: a proof gets a copy of the state.
 */
type Rows = { [key: string]: SignerRow };

/**
 * One entry that holds, taken: the state after it and what the member did with it; null where the
 * member stops at it, and then nothing is written. `rows` is the copy that this answer, or this
 * replay, writes its rows into, or null while it has none: the member's rows are copied when an
 * entry writes a row, once, and not once for every entry.
 */
function takeEntry(state: SignersState, rows: Rows | null, held: HeldEntry, proof: KeyProof | undefined): { readonly state: SignersState; readonly rows: Rows | null; readonly outcome: TakenOutcome } | null {
  const judged = judge(state, held, proof);
  const { outcome } = judged;
  if (outcome.outcome === "stops") return null;
  let written = rows;
  if (judged.rows.length > 0) {
    written ??= Object.fromEntries(Object.entries(state.signers));
    // Each key is one of an entry that holds, so it is a key in form and never a name that an object has of itself.
    for (const [key, row] of judged.rows) written[key] = row;
  }
  return { state: stateAfter(state, held, judged, written ?? state.signers), rows: written, outcome };
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
  const { entries, state } = plainMember(member);
  const seq = entries.length - 1;
  return { seq, hash: ownEntry(entries, seq, state.list).hash };
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

/** Whether an entry holds on the entry before it. An entry that holds is made frozen data like every held entry here, with bytes of its own: it comes back to the caller and is read again for the entry after it, and a proof is handed another copy. */
async function fits(entry: Entry, before: HeldEntry): Promise<Fit> {
  let code: ListRefusalCode;
  try {
    return { fit: "holds", held: plainHeld(await entryHolds(entry, before)) };
  } catch (error) {
    code = refusalOf(error);
  }
  if (code !== "chain_broken") return { fit: "no", code };
  const { prev } = readBody(entry.body);
  if (prev === "" || prev === before.hash) return { fit: "no", code };
  try {
    await entryHolds(entry, { entry: before.entry, body: before.body, hash: prev, list: before.list });
    return { fit: "elsewhere" };
  } catch (error) {
    if (!(error instanceof ListEntryError)) throw error;
    return { fit: "no", code };
  }
}

/**
 * What a member does with one answer of the log, entry by entry. The caller asked for the
 * entries after a place the member holds: its head; its footing when it goes back; or, when the
 * log gives it the entries after a place in parts, the place where the part before ended.
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
 * with an honest answer never depends on where it was cut, when it is shown the parts in order,
 * each after the place where the part before ended. The caller knows that place and no result
 * names it: a part that shows only entries the member holds changes nothing and asks nothing,
 * also when the log goes on past it with other entries than the member's own. A caller that asks
 * only after the member's head or its footing is then shown that part again each time, and never
 * comes to those entries.
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
 * A member that is behind stops at an entry it cannot place (SignersState.behind): the answer
 * ends there for it with `needs_replay`, stuck. It takes neither that entry nor any after it, and
 * drops none of its own for it. Its state keeps the stop: every later answer ends the same way,
 * also one that shows another entry in that place, until the member replays.
 *
 * A place the member does not hold for the answer to follow, a state whose footing is not the
 * member's own entry at that place, or one whose level is no level, is the caller's mistake: a
 * RangeError, and nothing is judged.
 *
 * The member and the answer are taken once, when the answer arrives (plainMember, plainAnswer),
 * and nothing of either is read again. What comes back is built from those copies, so it is of
 * the member and of the answer as they were handed over, whatever the caller does to either
 * meanwhile or later, and whatever either says at a second reading.
 */
export async function shownEntries(member: ListMember, answer: ShownAnswer, proof?: KeyProof): Promise<ShownResult> {
  const given = plainMember(member);
  const { after, entries: shown, head } = plainAnswer(answer);
  /** The member's entries as they stand: a copy that this answer drops from and adds to. */
  const entries = Array.from(given.entries);
  /** The footing is read from here wherever it is asked for: it moves with each entry that the member takes and that is not loose, also inside this answer. */
  let state = given.state;
  let rows: Rows | null = null;
  const { list } = state;
  const top = entries.length - 1;
  if (!Number.isInteger(after) || after < 0 || after > top) throw new RangeError(`The member holds no entry ${after} for the answer to follow`);
  if (ownEntry(entries, state.footing.seq, list).hash !== state.footing.hash) throw new RangeError(`The member's entry ${state.footing.seq} is not its footing: this state is not that of these entries`);
  const took: TakenEntry[] = [];
  let dropped: number | null = null;
  /** Where the answer ends for the member: nothing is taken after it, so the rows it wrote are frozen now. */
  const done = (rest: Partial<Pick<ShownResult, "stopped" | "stuck" | "asks_after">> = {}): ShownResult => {
    if (rows !== null) Object.freeze(rows);
    return { member: { entries, state }, dropped_from: dropped, took, stopped: null, stuck: false, asks_after: null, ...rest };
  };
  const stops = (seq: number, code: ListRefusalCode) => done({ stopped: { seq, code } });
  const stuck = (seq: number) => done({ stopped: { seq, code: "chain_broken" }, stuck: true });
  // A member that stopped for a replay takes nothing, whatever it is shown: the answer ends for it as it ended then.
  if (state.needs_replay !== undefined) return done({ stopped: { seq: state.needs_replay, code: "needs_replay" }, stuck: true });

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
    const taken = takeEntry(state, rows, fit.held, proof);
    // Behind, the member cannot place the entry: it takes neither it nor any after it, and drops nothing for it, until it replays.
    if (taken === null) {
      state = stoppedAt(state, seq);
      return done({ stopped: { seq, code: "needs_replay" }, stuck: true });
    }
    if (own !== null) {
      entries.length = seq;
      dropped = seq;
    }
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
 * took every entry it was given, or names where it stopped: at an entry that does not hold, or,
 * for a member that is behind, at an entry it cannot place (`needs_replay`). The entries, the list
 * id and the proof are taken once, when it is called. A level that is no level is the caller's
 * mistake: a RangeError.
 */
export async function replayEntries(entries: readonly string[], level: number, options: { readonly given?: string; readonly proof?: KeyProof } = {}): Promise<ReplayResult> {
  const [text, ...rest] = plainTexts(entries);
  const { given, proof } = options;
  mustBeLevel(level);
  if (text === undefined) return { member: null, took: [], stopped: null };
  let before: HeldEntry;
  try {
    before = plainHeld((await firstState(entryFromText(text), given)).first);
  } catch (error) {
    return { member: null, took: [], stopped: { seq: 0, code: refusalOf(error) } };
  }
  let state = stateOfFirst(before, level);
  let rows: Rows | null = null;
  const kept = [text];
  const took: TakenEntry[] = [{ held: before, outcome: before.body.v > level ? { outcome: "cannot_read", power: "full", behind: true } : { outcome: "reads", power: "full", behind: false } }];
  /** Where the replay ends: nothing is taken after it, so the rows it wrote are frozen now. */
  const replayed = (stopped: ListStop | null): ReplayResult => {
    if (rows !== null) Object.freeze(rows);
    return { member: { entries: kept, state }, took, stopped };
  };
  for (const [index, next] of rest.entries()) {
    let held: HeldEntry;
    try {
      held = plainHeld(await entryHolds(entryFromText(next), before));
    } catch (error) {
      return replayed({ seq: index + 1, code: refusalOf(error) });
    }
    const taken = takeEntry(state, rows, held, proof);
    // Behind, the member cannot place the entry: its copy ends before it, until it replays after an update.
    if (taken === null) {
      state = stoppedAt(state, index + 1);
      return replayed({ seq: index + 1, code: "needs_replay" });
    }
    state = taken.state;
    rows = taken.rows;
    kept.push(next);
    took.push({ held, outcome: taken.outcome });
    before = held;
  }
  return replayed(null);
}

/**
 * A member signs an entry only on its footing. The place its next entry takes, or null when the
 * head it is shown lies past its footing: it then places nothing, says so, and asks again. Null
 * as well when the head lies at or under its footing and is not the member's own entry at that
 * place, or names no place: that is another history under its footing, which an answer stops as
 * `stuck` (shownEntries), and the member signs nothing on top of it.
 */
export function signingPlace(member: ListMember, shown: ListPlace): { readonly list: string; readonly prev: string; readonly seq: number } | null {
  const { entries, state } = plainMember(member);
  const { seq, hash } = plainPlace(shown);
  const { footing, list } = state;
  // A member that stopped for a replay places nothing: it does not know what the list holds past its stop.
  if (state.needs_replay !== undefined) return null;
  if (!Number.isInteger(seq) || seq < 0 || seq > footing.seq || ownEntry(entries, seq, list).hash !== hash) return null;
  return { list, prev: footing.hash, seq: footing.seq + 1 };
}

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

/**
 * Whether a saved row's `by` can be what SignerRow says it is: the signer of the entry that made the
 * row's key a signer. Entry 0's is its own key, which readSignerRow holds it to. Null is a proof's,
 * so above level 1 only. Any other names a key that was a signer of power `full` at the row's
 * place: its row came in before that place with power `full`, and was not ended before it. Above
 * level 1 that key's row may also be a later one, or the row itself: a key that a proof made a
 * signer can be added, by another key or by itself, after it added this row's key, and its row is
 * then the one that `adds` gave it.
 */
function madeByItsSigner(rows: SignersState["signers"], row: SignerRow, level: number): boolean {
  if (row.seq === 0) return true;
  if (row.by === null) return level > 1;
  const signer = rowOf(rows, row.by);
  if (signer === null) return false;
  if (signer.seq < row.seq) return signer.power === "full" && (signer.ended === null || signer.ended >= row.seq);
  return level > 1 && signer.by !== null;
}

/**
 * A saved state, read again: the state when the value has its form and agrees with itself, null
 * for anything else. The value must come from the member's own store and is as trusted as its
 * private key: a caller that loads it from anywhere else must replay the entries instead. It is
 * the reader of a value of no known type: each field is read once, and the state it gives is
 * frozen. It takes every state that a function of this file gives from entries, or from a state
 * that it takes and an entry that holds on that state's list; and a level that it takes, those
 * functions take.
 */
export function readSignersState(value: unknown): SignersState | null {
  if (!isRecord(value)) return null;
  const { level, list, footing, needs, behind, signers, needs_replay } = value;
  if (!isLevel(level) || !isCount(needs) || needs < 1) return null;
  if (typeof list !== "string" || !isListHash(list)) return null;
  if (!isRecord(footing)) return null;
  const { seq, hash } = footing;
  if (!isCount(seq) || typeof hash !== "string" || !isListHash(hash)) return null;
  if (seq === 0 && hash !== list) return null;
  if (behind !== null && !(isCount(behind) && behind <= seq)) return null;
  if ((behind !== null) !== (needs > level)) return null;
  if (!isRecord(signers)) return null;
  const rows: { [key: string]: SignerRow } = {};
  for (const key of Object.getOwnPropertyNames(signers)) {
    const row = readSignerRow(key, signers[key], seq);
    if (row === null) return null;
    rows[key] = row;
  }
  const all = Object.values(rows);
  if (all.filter((row) => row.seq === 0).length !== 1) return null;
  // Each row's `by` is what SignerRow says it is (madeByItsSigner). So it is null or the key of a row: a key in form, and no name that every object answers to.
  if (!all.every((row) => madeByItsSigner(rows, row, level))) return null;
  const read = { level, list, footing: Object.freeze({ seq, hash }), needs, behind, signers: Object.freeze(rows) };
  if (needs_replay === undefined) return Object.freeze(read);
  // Only a member that is behind stops for a replay, at an entry past its footing.
  return isCount(needs_replay) && behind !== null && needs_replay > seq ? stoppedAt(read, needs_replay) : null;
}

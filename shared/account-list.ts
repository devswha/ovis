/**
 * What the signed list means: its kinds at level 1 (`genesis`, `device`, `pc`, `invite`, `join`, `remove`,
 * `carried`, `card` and `epoch`), the state they build (the devices, the PCs, the invites, the keys that are out,
 * the epochs), the card by which a newcomer names its own encryption key, the names an entry seals, and the proof
 * by which the holder of an invite reads the log. The entry under it is shared/account-list-entry.ts and who may sign is
 * shared/account-list-signers.ts (docs/account-list.md); neither is changed by anything here.
 *
 * Everything a member needs to decide who is in stands in the clear. An entry's names (a label, an OS word) are
 * in its `sealed` field, which this file never opens: it checks that the field is no shorter than a sealed value
 * can be and that the `epoch` beside it is the list's current one. So a member that was given no key to the
 * names, or a wrong one, lets in and puts out exactly whom every other member does.
 *
 * The account service calls takeEntry for every entry it is asked to place, a device or a PC calls it for every
 * entry it catches up on, and all come to the same answer. No I/O, no storage and no clock: the one time a
 * member judges is a device's `until`, and admitsDevice is handed the hour.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { ACCOUNT_OSES, type AccountOs } from "./account-asker.ts";
import {
  ListEntryError, entryFromText, entryToText, isListHash, isListKeyEncoding, isListNumber, isListPoint, readFieldsUnder, verifySignature, writeFieldsUnder,
  type EntryBody, type HeldEntry, type ListField, type ListRefusalCode, type SignerPower,
} from "./account-list-entry.ts";
import { ACCOUNT_LABEL_MAX } from "./account-records.ts";
import {
  firstSignersState, judgeEntry, readSignersState, replayEntries, shownEntries, signerPower,
  type PassedOverCode, type ShownAnswer, type ShownResult, type SignerRow, type SignersState,
} from "./account-list-signers.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

/** The level of this build: it reads every form of levels 1 to this. */
export const LIST_LEVEL = 1;
/** For each kind, the level that defines each of its forms (`v`). Level 1 is nine kinds, each written with `v` 1. */
export const LIST_LEVEL_TABLE = {
  genesis: { 1: 1 },
  device: { 1: 1 },
  pc: { 1: 1 },
  invite: { 1: 1 },
  join: { 1: 1 },
  remove: { 1: 1 },
  carried: { 1: 1 },
  card: { 1: 1 },
  epoch: { 1: 1 },
} as const satisfies { readonly [kind: string]: { readonly [v: number]: number } };

/** A card's signature is over these bytes and the card's fields. */
export const LIST_CARD_PREFIX = "ovis-list-card/1";
/** The proof by which the holder of an invite reads the log starts with these bytes. */
export const LIST_READ_PREFIX = "ovis-list-read/1";
/** The most PCs that one invite lets in. */
export const INVITE_USES_MAX = 256;
/** How far an invite's `exp` may lie after its `issued_at`: 7 days, in seconds. */
export const INVITE_SECONDS_MAX = 604800;
/**
 * The shortest `sealed` value: a version byte, a nonce (12), the tag (16), and under them the 18 bytes with which
 * every sealed text starts. Sealing is not this file's, and nothing here reads past the length.
 */
export const SEALED_MIN_BYTES = 47;
/** An `epoch_link` is exactly this long: the key of the epoch before, under the key of the one its entry opens. */
export const EPOCH_LINK_BYTES = 61;
/** A card's signature as text: the base64url of `r || s`, 64 bytes, in its one spelling. */
export const CARD_SIGNATURE_CHARS = 86;

/** What a device may do at a PC: `drive` types into its terminals, `watch` only reads them. */
export type ListRole = "drive" | "watch";
/** Why an invite lets no PC in, by what the list holds; the first that applies, in this order. */
export type InviteCode = "invite_unknown" | "invite_revoked" | "invite_void" | "invite_spent";
/** Why an entry that a member reads has no effect of its kind. */
export type NoEffectCode =
  | "entry_invalid" | "epoch_other" | InviteCode | "invite_not_auto" | "signer_not_allowed" | "already_out" | "ends_needed" | "endpoint_reused" | "key_reused"
  | "card_invalid" | "enc_set";
/** Why a proof for reading is not taken: its form, then its signature. */
export type ReadProofCode = "proof_malformed" | "signature_invalid";

/** What is not one of the kinds in its form, where one is asked for: an entry 0 that is no `genesis` a member can read, or what a writer was given. */
export class ListKindError extends Error {
  readonly code = "entry_invalid";
  constructor(message: string) {
    super(message);
    this.name = "ListKindError";
  }
}

export class ReadProofError extends Error {
  constructor(readonly code: ReadProofCode, message: string) {
    super(message);
    this.name = "ReadProofError";
  }
}

/** A signer's row with what its kind made of the key: a device, a PC that a person added, an invite, or neither (a key with no name, which opens nothing). An ended key keeps its `as`. */
export interface ListSignerRow extends SignerRow {
  readonly as: "device" | "pc" | "invite" | null;
}

/** A device, named by its key: whether it is in and what it may sign are in its signer's row. */
export interface DeviceRow {
  readonly role: ListRole;
  /** Seconds since 1970, or null: a PC lets the device in only before this hour, by the PC's own clock. Nobody else judges it. */
  readonly until: number | null;
  /** Its encryption key, or null for a device that was carried in and has not named one yet (kind `card`). */
  readonly enc: string | null;
  /** It came in by `carried`: it was in the account before the account had a list. */
  readonly carried: boolean;
}

/**
 * A PC, named by its relay key (`endpoint`). `added`: a person added it, its `key` is a signer of power `full` and
 * the PC is in while that key is one. `joined`: it came in by an invite that needs no person; its `key` is no
 * signer, so it lets devices in and can allow nobody. `carried`: it was in the account before the account had a
 * list, and it has no key until a person's `pc` names that relay key again.
 */
export interface PcRow {
  readonly how: "added" | "joined" | "carried";
  /** The PC's signing key; null only for `carried`. */
  readonly key: string | null;
  /** The PC's encryption key; null only for `carried`. */
  readonly enc: string | null;
  /** The place of the entry that made this row what it is: its names are sealed there. */
  readonly seq: number;
  /** The key of the invite that signed its `join`; null for the others. */
  readonly invite: string | null;
  /** The place of the entry that put it out, or null: it is in while this is null. */
  readonly removed: number | null;
}

/** An invite, named by its key: the device or PC that placed it and whether it is ended are in its signer's row. */
export interface InviteRow {
  /** Seconds since 1970. Only the account service judges it, by its own clock. */
  readonly exp: number;
  /** Up to this many PCs may join with it. */
  readonly uses: number;
  /** The joins that count and that it signed. */
  readonly joins: number;
  /** Whether a PC joins with it by itself (`join`), with no person adding it. */
  readonly auto: boolean;
}

/** What the entry that opened an epoch says of it in the clear. */
export interface EpochRow {
  /** The commitment to that epoch's key: a member takes a key for the epoch only when it gives this. */
  readonly opens: string;
  /** The key of the epoch before, under this epoch's key, as base64url; null for epoch 0. */
  readonly link: string | null;
  /** The place of the entry that opened it. */
  readonly seq: number;
}

/**
 * What a member lets in, as plain data: JSON saves it and readListState reads it again. It begins with the
 * signers' state. Nothing is ever deleted from `signers`, `devices`, `invites`, `pcs` or `pc_keys`: a device or
 * an invite is in only while its key is a signer (its row's `ended` is null), and a PC while its row's `removed`
 * is null. `pc_keys` names, for every key a PC ever had here, that PC's relay key: such a key is never anything
 * else again. `epochs` holds one row for each epoch, epoch 0 first; the last is the current one, and its number
 * is `epoch`.
 */
export interface ListState extends SignersState {
  readonly signers: { readonly [key: string]: ListSignerRow };
  readonly devices: { readonly [key: string]: DeviceRow };
  readonly pcs: { readonly [endpoint: string]: PcRow };
  readonly pc_keys: { readonly [key: string]: string };
  readonly invites: { readonly [key: string]: InviteRow };
  readonly epoch: number;
  readonly epochs: readonly EpochRow[];
}

/** What became of an entry that holds; `code` is the refusal's name. */
export type ListOutcome =
  /** Nothing in it applies. A `join` takes the invite's name here too. It is loose when its signer is no signer for the member. */
  | { readonly outcome: "passed_over"; readonly code: PassedOverCode | InviteCode; readonly loose: boolean }
  /** A member that is behind cannot place it: it takes neither this entry nor any after it until it replays. */
  | { readonly outcome: "stops"; readonly code: "needs_replay" }
  /** Its `v` is above the member's level: `adds` and `ends` have applied, and its kind does nothing. */
  | { readonly outcome: "cannot_read" }
  /** `adds` and `ends` have applied; its kind lets nothing in and takes no PC out. */
  | { readonly outcome: "no_effect"; readonly code: NoEffectCode }
  /** Its kind's rule counts it. A member that is behind still takes nothing in from it but a removal. */
  | { readonly outcome: "counts" };

/** An entry's names as it carries them: the bytes of its `sealed` field, and the epoch whose key sealed them (its `epoch`). */
export interface Sealed {
  readonly epoch: number;
  readonly bytes: Uint8Array;
}

/**
 * The own fields of the kinds, each in its form. `sealed` is null for an entry that carries no names: its
 * writer had no key to seal them with.
 */
export type ListKind =
  /** `opens` is the commitment to the key of epoch 0. */
  | { readonly kind: "genesis"; readonly account: string; readonly enc: string; readonly opens: string; readonly sealed: Sealed | null }
  /** `rotates`: the entry also ends its own signer, which so hands its place to `key`. */
  | { readonly kind: "device"; readonly key: string; readonly power: SignerPower; readonly role: ListRole; readonly until: number | null; readonly enc: string; readonly card: string; readonly sealed: Sealed | null; readonly rotates: boolean }
  | { readonly kind: "pc"; readonly key: string; readonly endpoint: string; readonly enc: string; readonly card: string; readonly sealed: Sealed | null }
  | { readonly kind: "invite"; readonly key: string; readonly exp: number; readonly uses: number; readonly auto: boolean; readonly sealed: Sealed | null }
  | { readonly kind: "join"; readonly endpoint: string; readonly pc: string; readonly enc: string; readonly card: string; readonly sealed: Sealed | null }
  | { readonly kind: "remove"; readonly ends: string }
  | { readonly kind: "remove"; readonly endpoint: string }
  | { readonly kind: "carried"; readonly key: string; readonly role: ListRole; readonly sealed: Sealed | null }
  | { readonly kind: "carried"; readonly endpoint: string; readonly sealed: Sealed | null }
  | { readonly kind: "card"; readonly enc: string }
  /** `epoch` is the epoch that is current where the entry stands; it opens the next one, whose key `opens` commits to and under which `link` holds the current key. */
  | { readonly kind: "epoch"; readonly epoch: number; readonly opens: string; readonly link: Uint8Array };

/** Where an entry stands and who signs it: the seven fields of every entry but `kind` and `v`. */
export interface EntryPlace {
  readonly issued_at: number;
  readonly list: string;
  readonly prev: string;
  readonly seq: number;
  readonly signer: string;
}

/** What a member holds: every entry it took, from entry 0, each as its one text, and the state they gave it. */
export interface ListCopy {
  readonly entries: readonly string[];
  readonly state: ListState;
}

export interface TakenListEntry {
  readonly held: HeldEntry;
  readonly outcome: ListOutcome;
}

/** Where a member stopped: an entry that does not hold, one it cannot place, or an entry 0 that is no `genesis` it can read. */
export interface ListStopped {
  readonly seq: number;
  readonly code: ListRefusalCode | "needs_replay" | "entry_invalid";
}

export interface ListReplay {
  /** Null when there is no entry 0, it does not hold, the member does not follow its list, or the replay would give a shorter history than the saved member's. */
  readonly member: ListCopy | null;
  /** Every entry it took, entry 0 first, each with what became of it. */
  readonly took: readonly TakenListEntry[];
  readonly stopped: ListStopped | null;
  readonly stuck: boolean;
}

/** What came of one answer of the log: as the signers' shownEntries says it, with the whole state. */
export type ListShown = Omit<ShownResult, "member" | "took"> & { readonly member: ListCopy; readonly took: readonly TakenListEntry[] };

/**
 * A card: the key that signs it, the encryption key it names for itself, the list it asks to join, for a PC its
 * relay key, and for a PC that joins by an invite that invite's key.
 */
export interface ListCard {
  readonly key: string;
  readonly enc: string;
  readonly list: string;
  /** A PC's relay key; null for a device. */
  readonly endpoint: string | null;
  /** The key of the invite a PC joins with by itself; null for a device and for a PC that a person adds. */
  readonly invite: string | null;
}

/** What an entry seals: a name, and the OS word when one is known. */
export interface ListNames {
  readonly label: string;
  readonly os: AccountOs | null;
}

/** What a proof for reading says: the invite's key, the list, the place its page follows (null for the start), and when it was made, in seconds since 1970. */
export interface ReadProof {
  readonly key: string;
  readonly list: string;
  readonly after: number | null;
  readonly at: number;
}

const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
/** A PC's relay key. */
const ENDPOINT = /^[0-9a-f]{64}$/;
/** White space that is no control character and no U+0020: U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. */
const OTHER_SPACE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
/** The decoding drops nothing: a byte order mark is the character U+FEFF, which is white space at the start of a name. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const NONE = new Uint8Array();

/** The bytes a base64url text spells when it is their one spelling (no padding); null for anything else. */
function oneSpelling(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  const bytes = fromBase64Url(text);
  return toBase64Url(bytes) === text ? bytes : null;
}

/** A key in its one spelling whose point is on the curve: what an encryption key and a PC's key must be to be of any use. */
export function isListKey(text: string): boolean {
  return isListKeyEncoding(text) && isListPoint(text);
}

/**
 * A name, by the check of a device's name (shared/account-records.ts): 1 to 48 UTF-16 units, no control
 * character and no unpaired surrogate, and of white space only single U+0020, each between two other characters.
 */
export function isListLabel(text: string): boolean {
  if (text.length < 1 || text.length > ACCOUNT_LABEL_MAX) return false;
  if (/[\p{Cc}\p{Cs}]/u.test(text) || OTHER_SPACE.test(text)) return false;
  return !/^ | $| {2}/.test(text);
}

/** Bytes as one character each, so a byte above 0x7f never matches a form. */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/** A row of its own, or null: what every object answers to is no row. */
function rowOf<Row>(rows: { readonly [name: string]: Row }, name: string): Row | null {
  return Object.hasOwn(rows, name) ? (rows[name] ?? null) : null;
}

function isKindName(kind: string): kind is keyof typeof LIST_LEVEL_TABLE {
  return Object.hasOwn(LIST_LEVEL_TABLE, kind);
}

function isOs(text: string): text is AccountOs {
  return (ACCOUNT_OSES as readonly string[]).includes(text);
}

const field = (name: string, value: string | Uint8Array): ListField => ({ name, value: typeof value === "string" ? utf8ToBytes(value) : value });

/**
 * An entry's own fields, read by its kind: one of the kinds at a `v` that the level table defines, with exactly
 * the fields of its kind, each value in its form, and `adds` and `ends` only where its kind has them. A kind that
 * has names carries `sealed` and `epoch` together or neither. Null for anything else. Entry 0's `account` is read
 * here: the state does not hold it. What the list holds (which epoch is current, whether an invite is open,
 * whether a relay key joined before, whether a card is its key's) is not a question of form.
 */
export function readKind(body: EntryBody): ListKind | null {
  const { adds, ends, kind, own, signer, v } = body;
  if (!isKindName(kind) || !Object.hasOwn(LIST_LEVEL_TABLE[kind], v)) return null;
  const all = own.map(({ name }) => name);
  if (new Set(all).size !== all.length) return null;
  const bytes = (name: string): Uint8Array => own.find((item) => item.name === name)?.value ?? NONE;
  const text = (name: string): string => latin1(bytes(name));
  const number = (name: string): number => (isListNumber(text(name)) ? Number(text(name)) : Number.NaN);
  /** The names of its fields but `sealed` and `epoch`, which a kind that has names may carry or not. */
  const named = all.filter((name) => name !== "sealed" && name !== "epoch").sort().join(" ");
  /** Its names: null when it carries none, undefined when `sealed` or `epoch` stands alone or is out of form. */
  const sealed = (): Sealed | null | undefined => {
    if (!all.includes("sealed") && !all.includes("epoch")) return null;
    const epoch = number("epoch");
    return all.includes("sealed") && all.includes("epoch") && !Number.isNaN(epoch) && bytes("sealed").length >= SEALED_MIN_BYTES ? { epoch, bytes: bytes("sealed") } : undefined;
  };
  const key = (name: string): string | null => (isListKey(text(name)) ? text(name) : null);
  const card = (): string | null => (text("card").length === CARD_SIGNATURE_CHARS && oneSpelling(text("card")) !== null ? text("card") : null);
  const endpoint = (): string | null => (ENDPOINT.test(text("endpoint")) ? text("endpoint") : null);
  const role = (): ListRole | null => (text("role") === "drive" || text("role") === "watch" ? (text("role") as ListRole) : null);
  switch (kind) {
    case "genesis": {
      const [enc, seal, opens] = [key("enc"), sealed(), text("epoch_opens")];
      if (named !== "account enc epoch_opens" || adds !== undefined || ends !== undefined || !ACCOUNT.test(text("account")) || enc === null || !isListHash(opens)) return null;
      // Entry 0 opens epoch 0, and seals under no other.
      if (seal === undefined || (seal !== null && seal.epoch !== 0)) return null;
      return { kind, account: text("account"), enc, opens, sealed: seal };
    }
    case "device": {
      const timed = named === "card enc role until";
      const [enc, seal, signed, part] = [key("enc"), sealed(), card(), role()];
      if ((!timed && named !== "card enc role") || adds === undefined || (ends !== undefined && ends !== signer)) return null;
      if (enc === null || seal === undefined || signed === null || part === null || (timed && Number.isNaN(number("until")))) return null;
      return { kind, key: adds.key, power: adds.power, role: part, until: timed ? number("until") : null, enc, card: signed, sealed: seal, rotates: ends !== undefined };
    }
    case "pc": {
      const [enc, seal, signed, at] = [key("enc"), sealed(), card(), endpoint()];
      if (named !== "card enc endpoint" || adds === undefined || adds.power !== "full" || ends !== undefined) return null;
      if (enc === null || seal === undefined || signed === null || at === null) return null;
      return { kind, key: adds.key, endpoint: at, enc, card: signed, sealed: seal };
    }
    case "invite": {
      const [exp, uses, auto, seal] = [number("exp"), number("uses"), text("auto"), sealed()];
      if (named !== "auto exp uses" || adds === undefined || adds.power !== "bound" || ends !== undefined || seal === undefined) return null;
      if ((auto !== "0" && auto !== "1") || !(uses >= 1 && uses <= INVITE_USES_MAX) || !(exp <= body.issued_at + INVITE_SECONDS_MAX)) return null;
      return { kind, key: adds.key, exp, uses, auto: auto === "1", sealed: seal };
    }
    case "join": {
      const [enc, seal, signed, at, pc] = [key("enc"), sealed(), card(), endpoint(), key("pc")];
      if (named !== "card enc endpoint pc" || adds !== undefined || ends !== undefined) return null;
      if (enc === null || seal === undefined || signed === null || at === null || pc === null) return null;
      return { kind, endpoint: at, pc, enc, card: signed, sealed: seal };
    }
    case "remove": {
      if (adds !== undefined || all.length !== (ends === undefined ? 1 : 0)) return null;
      if (ends !== undefined) return { kind, ends };
      const at = endpoint();
      return all[0] === "endpoint" && at !== null ? { kind, endpoint: at } : null;
    }
    case "carried": {
      const seal = sealed();
      if (ends !== undefined || seal === undefined) return null;
      if (adds !== undefined) {
        const part = role();
        return named === "role" && adds.power === "full" && part !== null ? { kind, key: adds.key, role: part, sealed: seal } : null;
      }
      const at = endpoint();
      return named === "endpoint" && at !== null ? { kind, endpoint: at, sealed: seal } : null;
    }
    case "card": {
      const enc = key("enc");
      return all.join(" ") === "enc" && adds === undefined && ends === undefined && enc !== null ? { kind, enc } : null;
    }
    case "epoch": {
      const [epoch, opens, link] = [number("epoch"), text("epoch_opens"), bytes("epoch_link")];
      if ([...all].sort().join(" ") !== "epoch epoch_link epoch_opens" || adds !== undefined || ends !== undefined) return null;
      return !Number.isNaN(epoch) && isListHash(opens) && link.length === EPOCH_LINK_BYTES ? { kind, epoch, opens, link } : null;
    }
  }
}

/**
 * The body of an entry of one of the kinds at `v` 1, for signEntry; refuses `entry_invalid` for what no member
 * would read as that kind. A `device` that rotates ends its own signer, which is the place's.
 */
export function kindBody(place: EntryPlace, kind: ListKind): EntryBody {
  const names = (sealed: Sealed | null): ListField[] => (sealed === null ? [] : [field("epoch", String(sealed.epoch)), field("sealed", sealed.bytes)]);
  const fields = (): Pick<EntryBody, "adds" | "ends" | "own"> => {
    switch (kind.kind) {
      case "genesis": return { own: [field("account", kind.account), field("enc", kind.enc), field("epoch_opens", kind.opens), ...names(kind.sealed)] };
      case "device": return {
        adds: { key: kind.key, power: kind.power },
        ...(kind.rotates ? { ends: place.signer } : {}),
        own: [field("card", kind.card), field("enc", kind.enc), field("role", kind.role), ...names(kind.sealed), ...(kind.until === null ? [] : [field("until", String(kind.until))])],
      };
      case "pc": return { adds: { key: kind.key, power: "full" }, own: [field("card", kind.card), field("enc", kind.enc), field("endpoint", kind.endpoint), ...names(kind.sealed)] };
      case "invite": return { adds: { key: kind.key, power: "bound" }, own: [field("auto", kind.auto ? "1" : "0"), field("exp", String(kind.exp)), field("uses", String(kind.uses)), ...names(kind.sealed)] };
      case "join": return { own: [field("card", kind.card), field("enc", kind.enc), field("endpoint", kind.endpoint), field("pc", kind.pc), ...names(kind.sealed)] };
      case "remove": return "ends" in kind ? { ends: kind.ends, own: [] } : { own: [field("endpoint", kind.endpoint)] };
      case "carried": return "key" in kind
        ? { adds: { key: kind.key, power: "full" }, own: [field("role", kind.role), ...names(kind.sealed)] }
        : { own: [field("endpoint", kind.endpoint), ...names(kind.sealed)] };
      case "card": return { own: [field("enc", kind.enc)] };
      case "epoch": return { own: [field("epoch", String(kind.epoch)), field("epoch_link", kind.link), field("epoch_opens", kind.opens)] };
    }
  };
  const made = fields();
  const body: EntryBody = { ...place, kind: kind.kind, v: 1, ...made, own: [...made.own].sort((a, b) => (a.name < b.name ? -1 : 1)) };
  if (readKind(body) === null) throw new ListKindError(`These are not the fields of a ${kind.kind} in their form`);
  return body;
}

/**
 * A card's bytes: `ovis-list-card/1` and the fields `enc`, `key` and `list`, for a PC `endpoint`, and for a PC
 * that joins by an invite `invite`, in the entry's field form. So a device's card is no PC's, and the card a PC
 * made for a person to add it is not one an invite's holder can join it with. Refuses `entry_invalid` for a value
 * out of its form, and for an `invite` with no `endpoint`: only a PC joins by one.
 */
export function cardBytes(card: ListCard): Uint8Array {
  const { key, enc, list, endpoint, invite } = card;
  if (!isListKey(key) || !isListKey(enc) || !isListHash(list) || !(endpoint === null || ENDPOINT.test(endpoint)) || !(invite === null || (endpoint !== null && isListKeyEncoding(invite)))) {
    throw new ListKindError("A card names a key, an encryption key and a list, for a PC its relay key, and for a PC that joins by an invite that invite's key");
  }
  return writeFieldsUnder(LIST_CARD_PREFIX, [
    field("enc", enc), ...(endpoint === null ? [] : [field("endpoint", endpoint)]), ...(invite === null ? [] : [field("invite", invite)]), field("key", key), field("list", list),
  ]);
}

/**
 * What a comparison of numbers on two screens is bound to when a person adds a PC (shared/relay-pair-sas.ts:
 * its `binding`): SHA-256 over the card's bytes, 32 bytes. Both ends work it out from the card each holds, so the
 * numbers agree only where the cards do. A number that is digits of this hash alone proves nothing: whoever
 * carries the card between the two can try keys until one fits.
 */
export function cardBinding(card: ListCard): Uint8Array {
  return sha256(cardBytes(card));
}

/**
 * A card, made by the newcomer with the private half of `key` before anybody lets it in: its signature over
 * cardBytes, `r || s`, as 86 characters of base64url. The entry that lets the key in carries it in `card`.
 */
export async function signCard(card: ListCard, privateKey: CryptoKey): Promise<string> {
  const bytes = cardBytes(card);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, new Uint8Array(bytes))));
}

/** Whether `signature` is the card's own: `key`'s signature over cardBytes. False for a card or a signature out of form. */
export async function cardHolds(card: ListCard, signature: string): Promise<boolean> {
  const signed = signature.length === CARD_SIGNATURE_CHARS ? oneSpelling(signature) : null;
  if (signed === null) return false;
  let bytes: Uint8Array;
  try {
    bytes = cardBytes(card);
  } catch (error) {
    if (error instanceof ListKindError) return false;
    throw error;
  }
  return await verifySignature(bytes, signed, card.key);
}

/**
 * What an entry seals, as the fields that are sealed: `label` and, when the OS is known, `os`. Refuses
 * `entry_invalid` for a label that is no name: it is checked as text before it is encoded, since an unpaired
 * surrogate would be written as U+FFFD and two names would share one text.
 */
export function namesFields(names: ListNames): ListField[] {
  const { label, os } = names;
  if (!isListLabel(label)) throw new ListKindError("label is a name: 1 to 48 units, no control character, single spaces, none at the ends");
  if (os !== null && !isOs(os)) throw new ListKindError("os is one of the OS words, or none");
  return [field("label", label), ...(os === null ? [] : [field("os", os)])];
}

/**
 * The names among the fields an opened `sealed` value holds, or null where no `label` is a name. An OS word this
 * build does not know reads as no OS, and a field it does not know is passed by, so that a later build may say
 * more. Nobody is let in or put out by anything read here.
 */
export function readNames(fields: readonly ListField[]): ListNames | null {
  const value = (name: string): Uint8Array | null => fields.find((item) => item.name === name)?.value ?? null;
  const labelBytes = value("label");
  if (labelBytes === null) return null;
  let label: string;
  try {
    label = UTF8.decode(labelBytes);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (!isListLabel(label)) return null;
  const osBytes = value("os");
  const os = osBytes === null ? "" : latin1(osBytes);
  return { label, os: isOs(os) ? os : null };
}

/**
 * The invite of a key when it is open as far as a member can tell, or its refusal, the first that applies. A key
 * is an invite when it has a member among the invites. A missing row means that the list holds no such key.
 */
function openInvite(state: ListState, key: string): InviteRow | InviteCode {
  const row = rowOf(state.signers, key);
  const invite = rowOf(state.invites, key);
  if (row === null || invite === null) return "invite_unknown";
  if (row.ended !== null) return "invite_revoked";
  const placer = row.by === null ? null : rowOf(state.signers, row.by);
  if (placer === null || placer.ended !== null) return "invite_void";
  return invite.joins < invite.uses ? invite : "invite_spent";
}

/**
 * An invite's refusal by what the list holds, the first that applies: the list holds no invite of that key,
 * whatever else the key is or was (`invite_unknown`); its key is ended (`invite_revoked`); the device or PC that
 * placed it is no signer (`invite_void`); no use is left (`invite_spent`). Null for an invite that is open as far
 * as a member can tell. It reads the key's row, the invite's row and the row of whoever placed it.
 */
export function inviteRefusal(state: ListState, key: string): InviteCode | null {
  const invite = openInvite(state, key);
  return typeof invite === "string" ? invite : null;
}

/**
 * Whether a person's `pc` may take a relay key: it has no row, or the one it has was carried in, is in, and so
 * only waits for its keys. An invite's `join` takes only a relay key that has no row: no holder of a line gives a
 * PC that was in the account keys of its own choosing.
 */
function endpointFree(state: ListState, endpoint: string): boolean {
  const row = rowOf(state.pcs, endpoint);
  return row === null || (row.how === "carried" && row.removed === null);
}

const named = (row: SignerRow | null, as: ListSignerRow["as"]): ListSignerRow | null =>
  (row === null ? null : { power: row.power, seq: row.seq, by: row.by, ended: row.ended, as });

/** The state with the signers' own part as `after` has it. */
function withBase(after: SignersState, rest: Pick<ListState, "signers" | "devices" | "pcs" | "pc_keys" | "invites" | "epoch" | "epochs">): ListState {
  const { level, list, footing, needs, behind, needs_replay } = after;
  const { signers, devices, pcs, pc_keys, invites, epoch, epochs } = rest;
  return { level, list, footing, needs, behind, signers, devices, pcs, pc_keys, invites, epoch, epochs, ...(needs_replay === undefined ? {} : { needs_replay }) };
}

/**
 * The state after entry 0, which holds: the list starts, its signer is the first device, of power `full` and
 * role `drive`, and epoch 0 is open. A member follows a list only when its entry 0 is a `genesis` that it can read: anything else
 * refuses `entry_invalid`.
 */
export function firstListState(first: HeldEntry, level: number): ListState {
  const kind = readKind(first.body);
  if (kind === null || kind.kind !== "genesis") throw new ListKindError("Entry 0 is no genesis that a member can read");
  const base = firstSignersState(first, level);
  const signers: { [key: string]: ListSignerRow } = {};
  const devices: { [key: string]: DeviceRow } = {};
  for (const [key, row] of Object.entries(base.signers)) {
    signers[key] = { ...row, as: "device" };
    devices[key] = { role: "drive", until: null, enc: kind.enc, carried: false };
  }
  return withBase(base, { signers, devices, pcs: {}, pc_keys: {}, invites: {}, epoch: 0, epochs: [{ opens: kind.opens, link: null, seq: 0 }] });
}

/**
 * What one entry does: the new state, what became of the entry, and for a refusal its name. The entry holds on
 * this state's list after the entry before it (entryHolds has checked that). Nothing that was given is changed.
 * It reads no row but those the entry names (rowsNamed): a state that holds only those rows, a missing row
 * meaning that the list holds no such key, gives the same result as the whole state.
 *
 * Who may sign is the signers' to say (judgeEntry), and `adds` and `ends` apply as they say, whatever the kind:
 * a key that `ends` puts out is out, and the PC whose key it is with it. Then the kind:
 *
 * - `device`: the key in `adds` is a device with that role, `until` and encryption key.
 * - `pc`: the key in `adds` is a PC that a person added, at that relay key.
 * - `invite`: the key in `adds` is an invite.
 * - `join`: signed by an open invite that is `auto`, it lets the PC at that relay key in; the PC's key is no signer.
 * - `remove`: with `ends` the signers have done it; with `endpoint` a signer of power `full` puts out a PC whose
 *   key is no signer.
 * - `carried`: signed by the first signer alone, it carries a device in (`adds`) or a PC (`endpoint`).
 * - `card`: a device that has no encryption key yet names its own.
 * - `epoch`: a signer of power `full` opens the epoch after the current one.
 *
 * An entry that has no effect for more than one reason takes the first name of this order: `entry_invalid`, for
 * its fields and the forms of their values; `epoch_other`, for names sealed under another epoch than the current
 * one, or an `epoch` that names another; then what the list holds, as the kind's rule writes it: for a `join`
 * the invite's names, `invite_not_auto`, `endpoint_reused`, `key_reused`; for a `pc` `endpoint_reused`, then
 * `key_reused`; for a `remove` of a PC `signer_not_allowed`, `already_out`, `ends_needed`; and last
 * `card_invalid`, the one check that asks the runtime.
 */
export async function takeEntry(state: ListState, held: HeldEntry): Promise<{ readonly outcome: ListOutcome; readonly state: ListState }> {
  const { body } = held;
  const { adds, ends, seq, signer } = body;
  const judged = judgeEntry(state, held);
  const kept = { signers: state.signers, devices: state.devices, pcs: state.pcs, pc_keys: state.pc_keys, invites: state.invites, epoch: state.epoch, epochs: state.epochs };
  if (judged.outcome.outcome === "stops") return { outcome: judged.outcome, state: withBase(judged.state, kept) };
  if (judged.outcome.outcome === "passed_over") {
    // Nothing in it applies, and it is not asked for its kind's form. A `join` at a `v` that the level table defines takes the invite's name.
    const invite = body.kind === "join" && Object.hasOwn(LIST_LEVEL_TABLE.join, body.v) ? inviteRefusal(state, signer) : null;
    return { outcome: { outcome: "passed_over", code: invite ?? judged.outcome.code, loose: judged.outcome.loose }, state: withBase(judged.state, kept) };
  }
  // `adds` and `ends` have applied, read or not: the key that comes in is a signer with no name until its kind names it, and the key that goes keeps what it was.
  const signers: { [key: string]: ListSignerRow } = { ...state.signers };
  const came = adds === undefined ? null : named(rowOf(judged.state.signers, adds.key), null);
  if (adds !== undefined && came !== null) signers[adds.key] = came;
  const went = ends === undefined ? null : named(rowOf(judged.state.signers, ends), ends === adds?.key ? null : (rowOf(state.signers, ends)?.as ?? null));
  if (ends !== undefined && went !== null) signers[ends] = went;
  // A PC that a person added is in while its key is a signer: the entry that ends the key puts the PC out.
  let pcs = state.pcs;
  const at = ends === undefined ? null : rowOf(state.pc_keys, ends);
  const pc = at === null ? null : rowOf(state.pcs, at);
  if (at !== null && pc !== null && pc.how === "added" && pc.key === ends && pc.removed === null) pcs = { ...pcs, [at]: { ...pc, removed: seq } };
  const next = withBase(judged.state, { ...kept, signers, pcs });
  if (judged.outcome.outcome === "cannot_read") return { outcome: { outcome: "cannot_read" }, state: next };

  const counts = (after: ListState) => ({ outcome: { outcome: "counts" }, state: after }) as const;
  const noEffect = (code: NoEffectCode) => ({ outcome: { outcome: "no_effect", code }, state: next }) as const;
  // A kind that its `v` does not define, a missing or an extra field, a value out of form; and a `genesis` after entry 0.
  const kind = readKind(body);
  if (kind === null || kind.kind === "genesis") return noEffect("entry_invalid");
  // Names sealed under another epoch than the current one: a member that was put out could read them, or nobody can.
  if ("sealed" in kind && kind.sealed !== null && kind.sealed.epoch !== state.epoch) return noEffect("epoch_other");
  // While it is behind a member lets nobody new in: the entry counts, and its state takes nothing in but a removal.
  const letsIn = state.behind === null;
  // A key that was ever a PC's is never anything else: the signers have made it a signer, and it stays one with no name.
  const used = (key: string): boolean => rowOf(state.pc_keys, key) !== null;
  switch (kind.kind) {
    case "device": {
      if (used(kind.key)) return noEffect("key_reused");
      if (!(await cardHolds({ key: kind.key, enc: kind.enc, list: state.list, endpoint: null, invite: null }, kind.card))) return noEffect("card_invalid");
      if (!letsIn || came === null) return counts(next);
      return counts({
        ...next,
        signers: { ...signers, [kind.key]: { ...came, as: "device" } },
        devices: { ...state.devices, [kind.key]: { role: kind.role, until: kind.until, enc: kind.enc, carried: false } },
      });
    }
    case "pc": {
      if (!endpointFree(state, kind.endpoint)) return noEffect("endpoint_reused");
      if (used(kind.key)) return noEffect("key_reused");
      if (!(await cardHolds({ key: kind.key, enc: kind.enc, list: state.list, endpoint: kind.endpoint, invite: null }, kind.card))) return noEffect("card_invalid");
      if (!letsIn || came === null) return counts(next);
      return counts({
        ...next,
        signers: { ...signers, [kind.key]: { ...came, as: "pc" } },
        pcs: { ...pcs, [kind.endpoint]: { how: "added", key: kind.key, enc: kind.enc, seq, invite: null, removed: null } },
        pc_keys: { ...state.pc_keys, [kind.key]: kind.endpoint },
      });
    }
    case "invite": {
      if (used(kind.key)) return noEffect("key_reused");
      if (!letsIn || came === null) return counts(next);
      return counts({
        ...next,
        signers: { ...signers, [kind.key]: { ...came, as: "invite" } },
        invites: { ...state.invites, [kind.key]: { exp: kind.exp, uses: kind.uses, joins: 0, auto: kind.auto } },
      });
    }
    case "join": {
      const invite = openInvite(state, signer);
      if (typeof invite === "string") return noEffect(invite);
      if (!invite.auto) return noEffect("invite_not_auto");
      if (rowOf(state.pcs, kind.endpoint) !== null) return noEffect("endpoint_reused");
      if (used(kind.pc) || rowOf(state.signers, kind.pc) !== null) return noEffect("key_reused");
      if (!(await cardHolds({ key: kind.pc, enc: kind.enc, list: state.list, endpoint: kind.endpoint, invite: signer }, kind.card))) return noEffect("card_invalid");
      if (!letsIn) return counts(next);
      return counts({
        ...next,
        invites: { ...state.invites, [signer]: { ...invite, joins: invite.joins + 1 } },
        pcs: { ...pcs, [kind.endpoint]: { how: "joined", key: kind.pc, enc: kind.enc, seq, invite: signer, removed: null } },
        pc_keys: { ...state.pc_keys, [kind.pc]: kind.endpoint },
      });
    }
    case "remove": {
      // With `ends`, the signers have put the key out, and its PC with it.
      if ("ends" in kind) return counts(next);
      if (judged.outcome.power !== "full") return noEffect("signer_not_allowed");
      const row = rowOf(state.pcs, kind.endpoint);
      if (row === null || row.removed !== null) return noEffect("already_out");
      // A PC that a person added goes with its key, by `ends`: put out by its relay key alone, its key would stay a signer.
      if (row.how === "added") return noEffect("ends_needed");
      return counts({ ...next, pcs: { ...pcs, [kind.endpoint]: { ...row, removed: seq } } });
    }
    case "carried": {
      const own = rowOf(state.signers, signer);
      if (own === null || own.seq !== 0) return noEffect("signer_not_allowed");
      if ("key" in kind) {
        if (used(kind.key)) return noEffect("key_reused");
        if (!letsIn || came === null) return counts(next);
        return counts({
          ...next,
          signers: { ...signers, [kind.key]: { ...came, as: "device" } },
          devices: { ...state.devices, [kind.key]: { role: kind.role, until: null, enc: null, carried: true } },
        });
      }
      if (rowOf(state.pcs, kind.endpoint) !== null) return noEffect("endpoint_reused");
      if (!letsIn) return counts(next);
      return counts({ ...next, pcs: { ...pcs, [kind.endpoint]: { how: "carried", key: null, enc: null, seq, invite: null, removed: null } } });
    }
    case "card": {
      const device = rowOf(state.signers, signer)?.as === "device" ? rowOf(state.devices, signer) : null;
      if (device === null) return noEffect("signer_not_allowed");
      if (device.enc !== null) return noEffect("enc_set");
      return counts(letsIn ? { ...next, devices: { ...state.devices, [signer]: { ...device, enc: kind.enc } } } : next);
    }
    case "epoch": {
      // Two members that open the next epoch at once name the same one: the second is of another epoch by then.
      if (kind.epoch !== state.epoch) return noEffect("epoch_other");
      if (judged.outcome.power !== "full") return noEffect("signer_not_allowed");
      return counts({ ...next, epoch: state.epoch + 1, epochs: [...state.epochs, { opens: kind.opens, link: toBase64Url(kind.link), seq }] });
    }
  }
}

/** The relay key an entry names in `endpoint`, when it has the form of one. */
function endpointOf(body: EntryBody): string | null {
  const key = latin1(body.own.find((item) => item.name === "endpoint")?.value ?? NONE);
  return ENDPOINT.test(key) ? key : null;
}

/**
 * The state cut down to the rows that one entry names: what the account service may load to judge the entry, and
 * takeEntry on it gives the same outcome and the same rows as on the whole state. The rows are those of its
 * `signer`, its `adds`, its `ends` and the key in its `pc`, among the signers, the devices, the invites and the
 * PCs' keys; the PC of its `endpoint` and the PC whose key it ends; and, for an entry that an invite signed, the
 * row of whoever placed that invite.
 */
export function rowsNamed(state: ListState, body: EntryBody): ListState {
  const pick = <Row>(rows: { readonly [name: string]: Row }, names: readonly (string | null | undefined)[]): { [name: string]: Row } => {
    const picked: { [name: string]: Row } = {};
    for (const name of names) {
      const row = typeof name === "string" ? rowOf(rows, name) : null;
      if (typeof name === "string" && row !== null) picked[name] = row;
    }
    return picked;
  };
  const keys = [body.signer, body.adds?.key, body.ends, latin1(body.own.find((item) => item.name === "pc")?.value ?? NONE)];
  const signer = rowOf(state.signers, body.signer);
  return {
    ...state,
    signers: pick(state.signers, [...keys, signer !== null && signer.as === "invite" ? signer.by : null]),
    devices: pick(state.devices, keys),
    invites: pick(state.invites, keys),
    pc_keys: pick(state.pc_keys, keys),
    pcs: pick(state.pcs, [endpointOf(body), body.ends === undefined ? null : rowOf(state.pc_keys, body.ends)]),
  };
}

/** The member's state as the signers left it, with what the kinds made of it: a stop the signers kept is the member's stop. */
function settled(state: ListState, signers: SignersState): ListState {
  return signers.needs_replay === undefined ? state : { ...state, needs_replay: signers.needs_replay };
}

/**
 * A member's entries from entry 0, each taken by its level: how it starts, and how it replays every entry it
 * kept after an update. It is the signers' replay, which checks that each entry holds, keeps loose entries apart
 * and never gives a shorter history than the saved member's (replayEntries: it is told the member's saved state,
 * or null for a first replay), with takeEntry for each entry it took. Given a list id, only the entry with that
 * hash is entry 0.
 */
export async function replayList(entries: readonly string[], level: number, options: { readonly saved: ListState | null; readonly given?: string }): Promise<ListReplay> {
  const { saved, given } = options;
  const replayed = await replayEntries(entries, level, given === undefined ? { saved } : { saved, given });
  const [first, ...rest] = replayed.took;
  if (replayed.member === null || first === undefined) return { member: null, took: [], stopped: replayed.stopped, stuck: replayed.stuck };
  let state: ListState;
  try {
    state = firstListState(first.held, level);
  } catch (error) {
    if (!(error instanceof ListKindError)) throw error;
    return { member: null, took: [], stopped: { seq: 0, code: error.code }, stuck: replayed.stuck };
  }
  const took: TakenListEntry[] = [{ held: first.held, outcome: { outcome: "counts" } }];
  for (const { held } of rest) {
    const taken = await takeEntry(state, held);
    state = taken.state;
    took.push({ held, outcome: taken.outcome });
  }
  return { member: { entries: replayed.member.entries, state: settled(state, replayed.member.state) }, took, stopped: replayed.stopped, stuck: replayed.stuck };
}

/**
 * What a member does with one answer of the log: the signers' shownEntries (taking, going back, `stuck`), with
 * takeEntry for each entry it took. What it drops was loose and had no effect of its kind either, so its state
 * is as if it had never seen it.
 */
export async function shownList(member: ListCopy, answer: ShownAnswer): Promise<ListShown> {
  const shown = await shownEntries(member, answer);
  let { state } = member;
  const took: TakenListEntry[] = [];
  for (const { held } of shown.took) {
    const taken = await takeEntry(state, held);
    state = taken.state;
    took.push({ held, outcome: taken.outcome });
  }
  return { ...shown, member: { entries: shown.member.entries, state: settled(state, shown.member.state) }, took };
}

/** A device as a caller lists it: its key, its signer's row and its own. */
export interface DeviceView extends DeviceRow {
  readonly key: string;
  readonly power: SignerPower;
  /** The place of the entry that let it in: its names are sealed there. */
  readonly seq: number;
  /** The signer of that entry. */
  readonly by: string | null;
  /** The place of the entry that put it out, or null while it is in. */
  readonly ended: number | null;
}

/** A PC as a caller lists it. `allows`: it is in and its key may sign for others, so a person at it can allow a device. */
export interface PcView extends PcRow {
  readonly endpoint: string;
  readonly allows: boolean;
}

/** An invite as a caller lists it. `refusal` is null while it is open as far as a member can tell. */
export interface InviteView extends InviteRow {
  readonly key: string;
  readonly seq: number;
  readonly by: string | null;
  readonly refusal: InviteCode | null;
}

/**
 * The devices, the PCs and the invites of a state, those that are out among them (a device's `ended`, a PC's
 * `removed`, an invite's `refusal`), each in the order it came in. A member that is stopped for a replay lists
 * what it held, and lets nobody in meanwhile (admitsDevice).
 */
export function listView(state: ListState): { readonly devices: readonly DeviceView[]; readonly pcs: readonly PcView[]; readonly invites: readonly InviteView[] } {
  const bySeq = <Row extends { readonly seq: number }>(rows: Row[]): Row[] => rows.sort((a, b) => a.seq - b.seq);
  const devices: DeviceView[] = [];
  const invites: InviteView[] = [];
  for (const [key, row] of Object.entries(state.signers)) {
    const device = row.as === "device" ? rowOf(state.devices, key) : null;
    if (device !== null) devices.push({ key, power: row.power, seq: row.seq, by: row.by, ended: row.ended, ...device });
    const invite = row.as === "invite" ? rowOf(state.invites, key) : null;
    if (invite !== null) invites.push({ key, seq: row.seq, by: row.by, refusal: inviteRefusal(state, key), ...invite });
  }
  const pcs = Object.entries(state.pcs).map(([endpoint, row]): PcView =>
    ({ endpoint, ...row, allows: row.how === "added" && row.removed === null && row.key !== null && signerPower(state, row.key) === "full" }));
  return { devices: bySeq(devices), pcs: bySeq(pcs), invites: bySeq(invites) };
}

/**
 * Whether a PC lets the device with this key in at `now` (seconds since 1970, by the PC's own clock), and as
 * what: its role, or null. A device is let in while its key is a signer and, when it has an `until`, before
 * that hour. A member that is stopped for a replay answers for nobody.
 */
export function admitsDevice(state: ListState, key: string, now: number): ListRole | null {
  if (signerPower(state, key) === null) return null;
  // Only a key that its kind made a device has a row among the devices.
  const device = rowOf(state.devices, key);
  if (device === null || (device.until !== null && !(now < device.until))) return null;
  return device.role;
}

/**
 * The encryption keys that the key of an epoch is wrapped to at `now` (seconds since 1970, by the caller's own
 * clock), in the order they came in: that of every device that is in, has named one and is not past its `until`;
 * that of every PC that is in and has one; and the own key of every open invite that a PC joins with by itself
 * and that is not past its `exp`. The last lets such a PC, which joins with nobody else awake, open the names,
 * seal its own and wrap the key to itself. Whoever is out is not among them, and neither is an invite or a
 * borrowed browser whose time is over: whoever still holds its key would otherwise read every later name. The
 * clock chooses only whom a key is wrapped to; it is no verdict on any entry, and no member lets anybody in or
 * puts anybody out by it.
 */
export function wrapKeys(state: ListState, now: number): string[] {
  const view = listView(state);
  const keys = [
    ...view.devices.filter((row) => row.ended === null && (row.until === null || now < row.until)).map((row) => ({ seq: row.seq, key: row.enc })),
    ...view.pcs.filter((row) => row.removed === null).map((row) => ({ seq: row.seq, key: row.enc })),
    ...view.invites.filter((row) => row.refusal === null && row.auto && now < row.exp).map((row) => ({ seq: row.seq, key: row.key })),
  ];
  return [...new Set(keys.sort((a, b) => a.seq - b.seq).flatMap(({ key }) => (key === null ? [] : [key])))];
}

/**
 * The epoch a writer seals an entry's names under, with the commitment to its key, or null when it must seal
 * nothing and write its entry with no names. It is the current epoch, and only when the entry that opened it
 * stands after the last entry that put out a key an epoch's key may have been wrapped to: the `ends` of a
 * device's, a PC's or an invite's key (a revoked invite among them), and the `remove` of a PC by its relay key.
 * Whoever was put out holds the key of every epoch opened before that, so names sealed under one of those are
 * names it reads. Entry 0 is the one entry this is not asked for: it opens epoch 0 itself. No writer decides
 * this for itself; a member that is stopped for a replay seals nothing.
 */
export function sealEpoch(state: ListState): { readonly epoch: number; readonly opens: string } | null {
  if (state.needs_replay !== undefined) return null;
  const current = state.epochs[state.epoch];
  if (current === undefined) return null;
  const out = [
    ...Object.values(state.signers).map((row) => (row.as === null ? null : row.ended)),
    ...Object.values(state.pcs).map((row) => row.removed),
  ];
  return out.some((seq) => seq !== null && seq >= current.seq) ? null : { epoch: state.epoch, opens: current.opens };
}

/** Whether the PC with this relay key is in the list: any row that is not out. A member that is stopped for a replay answers for nobody. */
export function holdsPc(state: ListState, endpoint: string): boolean {
  if (state.needs_replay !== undefined) return false;
  const row = rowOf(state.pcs, endpoint);
  return row !== null && row.removed === null;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A saved state, read again by a build of this level: the state when the value has its form and agrees with
 * itself, null for anything else. As the signers' readSignersState, on which it stands: the value comes from the
 * member's own store, and a state that a higher level wrote is read back stopped.
 */
export function readListState(value: unknown, level: number): ListState | null {
  const base = readSignersState(value, level);
  if (base === null || !isRecord(value)) return null;
  const { signers: savedSigners, devices: savedDevices, pcs: savedPcs, pc_keys: savedKeys, invites: savedInvites, epoch, epochs: savedEpochs } = value;
  if (!isRecord(savedSigners) || !isRecord(savedDevices) || !isRecord(savedPcs) || !isRecord(savedKeys) || !isRecord(savedInvites) || !Array.isArray(savedEpochs)) return null;
  const top = base.footing.seq;
  // One row for each epoch, epoch 0 opened by entry 0 and each later one by a later entry than the one before.
  const epochs: EpochRow[] = [];
  for (const saved of savedEpochs as readonly unknown[]) {
    if (!isRecord(saved)) return null;
    const { opens, link, seq } = saved;
    const before = epochs.at(-1);
    if (typeof opens !== "string" || !isListHash(opens) || !isCount(seq) || seq > top || (before === undefined ? seq !== 0 : seq <= before.seq)) return null;
    if (before === undefined ? link !== null : typeof link !== "string" || oneSpelling(link)?.length !== EPOCH_LINK_BYTES) return null;
    epochs.push({ opens, link: typeof link === "string" ? link : null, seq });
  }
  if (epochs.length === 0 || epoch !== epochs.length - 1) return null;
  // While it is behind a member lets nobody new in. So no member is behind from entry 0: it read it, and its signer is a device.
  const letIn = (seq: number): boolean => base.behind === null || seq < base.behind;

  const signers: { [key: string]: ListSignerRow } = {};
  for (const [key, row] of Object.entries(base.signers)) {
    const saved = savedSigners[key];
    const as = isRecord(saved) ? saved.as : undefined;
    if (as !== null && as !== "device" && as !== "pc" && as !== "invite") return null;
    // The first signer is the first device. A PC that a person added is `full`; an invite is `bound`, and an `adds` made it a signer.
    if (row.seq === 0 && as !== "device") return null;
    if (as === "pc" && row.power !== "full") return null;
    if (as === "invite" && (row.power !== "bound" || row.by === null)) return null;
    if (as !== null && !letIn(row.seq)) return null;
    signers[key] = { ...row, as };
  }

  const devices: { [key: string]: DeviceRow } = {};
  for (const [key, saved] of Object.entries(savedDevices)) {
    if (signers[key]?.as !== "device" || !isRecord(saved)) return null;
    const { role, until, enc, carried } = saved;
    if ((role !== "drive" && role !== "watch") || !(until === null || isCount(until)) || typeof carried !== "boolean") return null;
    // Only a device that was carried in may be without an encryption key.
    if (enc === null ? !carried : typeof enc !== "string" || !isListKey(enc)) return null;
    devices[key] = { role, until, enc: typeof enc === "string" ? enc : null, carried };
  }

  const pcs: { [endpoint: string]: PcRow } = {};
  const joined = new Map<string, number>();
  const keyed = new Map<string, string>();
  for (const [endpoint, saved] of Object.entries(savedPcs)) {
    if (!ENDPOINT.test(endpoint) || !isRecord(saved)) return null;
    const { how, key, enc, seq, invite, removed } = saved;
    if (!isCount(seq) || seq < 1 || seq > top || !letIn(seq)) return null;
    if (removed !== null && !(isCount(removed) && removed > seq && removed <= top)) return null;
    if (how === "carried") {
      if (key !== null || enc !== null || invite !== null) return null;
      pcs[endpoint] = { how, key, enc, seq, invite, removed };
      continue;
    }
    if (typeof key !== "string" || !isListKeyEncoding(key) || typeof enc !== "string" || !isListKey(enc) || keyed.has(key)) return null;
    if (how === "added") {
      const row = signers[key];
      // Its key is the signer that its entry made, and it is out exactly when that key is.
      if (invite !== null || row === undefined || row.as !== "pc" || row.seq !== seq || row.ended !== removed) return null;
    } else if (how === "joined") {
      const placed = typeof invite === "string" ? signers[invite] : undefined;
      // It joined after its invite was placed, while that invite's key was a signer and whoever placed it was one.
      if (typeof invite !== "string" || placed === undefined || placed.as !== "invite" || seq <= placed.seq || (placed.ended !== null && seq >= placed.ended)) return null;
      const placer = signers[placed.by ?? ""];
      if (placer !== undefined && placer.ended !== null && seq >= placer.ended) return null;
      joined.set(invite, (joined.get(invite) ?? 0) + 1);
    } else {
      return null;
    }
    keyed.set(key, endpoint);
    pcs[endpoint] = { how, key, enc, seq, invite: how === "joined" && typeof invite === "string" ? invite : null, removed };
  }

  // One member of `pc_keys` for each PC that has a key, and no other.
  const pc_keys: { [key: string]: string } = {};
  for (const [key, endpoint] of Object.entries(savedKeys)) {
    if (keyed.get(key) !== endpoint || typeof endpoint !== "string") return null;
    pc_keys[key] = endpoint;
  }
  if (Object.keys(pc_keys).length !== keyed.size) return null;

  // One member of `invites` for each key that is an invite, and no other; its joins are the PCs that joined with it.
  const invites: { [key: string]: InviteRow } = {};
  for (const [key, saved] of Object.entries(savedInvites)) {
    if (signers[key]?.as !== "invite" || !isRecord(saved)) return null;
    const { exp, uses, joins, auto } = saved;
    const count = joined.get(key) ?? 0;
    if (!isCount(exp) || !isCount(uses) || uses < 1 || uses > INVITE_USES_MAX || joins !== count || count > uses || typeof auto !== "boolean") return null;
    if (count > 0 && !auto) return null;
    invites[key] = { exp, uses, joins: count, auto };
  }
  const rows = Object.values(signers);
  if (rows.filter((row) => row.as === "invite").length !== Object.keys(invites).length) return null;
  if (rows.filter((row) => row.as === "device").length !== Object.keys(devices).length) return null;
  if (rows.filter((row) => row.as === "pc").length !== Object.values(pcs).filter((row) => row.how === "added").length) return null;
  return withBase(base, { signers, devices, pcs, pc_keys, invites, epoch: epochs.length - 1, epochs });
}

/** What the entry's functions refuse as `entry_malformed` is `proof_malformed` here: nothing that is not an entry has a name with `entry` in it. */
function asProof<Result>(read: () => Result): Result {
  try {
    return read();
  } catch (error) {
    if (error instanceof ListEntryError) throw new ReadProofError("proof_malformed", error.message);
    throw error;
  }
}

/** A proof's body: `ovis-list-read/1` and the fields `after at key list` in the entry's field form, and no other, each value in its form. */
function readProofBody(body: Uint8Array): ReadProof {
  const fields = asProof(() => readFieldsUnder(LIST_READ_PREFIX, body));
  if (fields.map(({ name }) => name).join(" ") !== "after at key list") throw new ReadProofError("proof_malformed", "A proof for reading has the fields after, at, key and list, and no other");
  const text = (name: string): string => latin1(fields.find((item) => item.name === name)?.value ?? NONE);
  const [after, at, key, list] = [text("after"), text("at"), text("key"), text("list")];
  if (!isListKeyEncoding(key) || !isListHash(list) || !isListNumber(at) || !(after === "" || isListNumber(after))) {
    throw new ReadProofError("proof_malformed", "key is a key, list a hash, at a number, and after a number or empty");
  }
  return { key, list, after: after === "" ? null : Number(after), at: Number(at) };
}

/** The invite's proof for reading, made by the holder of the line with the invite's private key: one text, as an entry is. Refuses `proof_malformed` for what no reader would take. */
export async function signReadProof(proof: ReadProof, privateKey: CryptoKey): Promise<string> {
  const body = asProof(() => writeFieldsUnder(LIST_READ_PREFIX, [
    field("after", proof.after === null ? "" : String(proof.after)), field("at", String(proof.at)), field("key", proof.key), field("list", proof.list),
  ]));
  readProofBody(body);
  const signature = new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, new Uint8Array(body)));
  return entryToText({ body, signature });
}

/**
 * A proof for reading, checked as the service checks it before it looks the invite up: its one text and its
 * body's form (`proof_malformed`), then its signature under the key it names (`signature_invalid`). What the
 * list holds of its invite is readProofRefusal's to say; whether `at` is near the reader's clock and whether the
 * invite's `exp` has passed are the service's.
 */
export async function checkReadProof(text: string): Promise<ReadProof> {
  const entry = asProof(() => entryFromText(text));
  const proof = readProofBody(entry.body);
  if (!(await verifySignature(entry.body, entry.signature, proof.key))) throw new ReadProofError("signature_invalid", "The signature is not that of the key the proof names");
  return proof;
}

/**
 * What the list holds against a proof whose form and signature are good: `invite_unknown` for a proof of another
 * list, which holds no invite of its key; otherwise the invite's refusal, the first that applies
 * (inviteRefusal). Null for a proof that reads.
 */
export function readProofRefusal(state: ListState, proof: ReadProof): InviteCode | null {
  return proof.list === state.list ? inviteRefusal(state, proof.key) : "invite_unknown";
}

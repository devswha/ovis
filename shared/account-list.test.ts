import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import {
  entryFromText, entryHash, entryToText, readBody, readFields, signEntry, writeFieldsUnder,
  type EntryBody, type HeldEntry, type SignerPower,
} from "./account-list-entry.ts";
import {
  CARD_SIGNATURE_CHARS, EPOCH_LINK_BYTES, INVITE_SECONDS_MAX, INVITE_USES_MAX, LIST_CARD_PREFIX, LIST_LEVEL, LIST_LEVEL_TABLE, LIST_READ_PREFIX, ListKindError, ReadProofError,
  SEALED_MIN_BYTES, admitsDevice, cardBytes, cardHolds, checkReadProof, firstListState, holdsPc, inviteRefusal, isListKey, isListLabel, kindBody, listView, namesFields, readKind,
  readListState, readNames, readProofRefusal, replayList, rowsNamed, sealEpoch, shownList, signCard, signReadProof, takeEntry, wrapKeys,
  type EntryPlace, type ListCard, type ListCopy, type ListKind, type ListOutcome, type ListRole, type ListState, type ReadProof, type Sealed,
} from "./account-list.ts";
import { judgeEntry, listHead, readSignersState, signerPower, signingPlace } from "./account-list-signers.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const T0 = 1767225600;
/** Four hours after the first entry: at most 7 days after any entry of a test list. */
const EXP = T0 + 14400;
/** A sealed value as this file sees one: bytes it never opens, no shorter than a sealed value can be. */
const SEALED = Uint8Array.from({ length: 60 }, (_, index) => index);
/** The commitment to an epoch's key, and the key of the epoch before under it: values this file never opens either. */
const OPENS = (epoch: number) => (epoch + 10).toString(16).padStart(2, "0").repeat(32);
const LINK = (epoch: number) => new Uint8Array(EPOCH_LINK_BYTES).fill(epoch);
/** The epoch whose key the entries a test writes are sealed under: 0 until a test moves it. */
let sealedUnder = 0;
const sealed = (): Own => ({ epoch: String(sealedUnder), sealed: SEALED });
const SEAL: Sealed = { epoch: 0, bytes: SEALED };

interface Key { readonly name: string; readonly key: string; readonly enc: string; readonly pair: CryptoKeyPair }
const names = new Map<string, string>();
const spki = async (key: CryptoKey) => toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
async function newKey(name: string): Promise<Key> {
  const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
  const key = await spki(pair.publicKey);
  const enc = await spki((await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])).publicKey);
  names.set(key, name);
  return { name, key, enc, pair };
}
/** The first device; two more devices; a PC that a person adds and another; an invite that needs no person, a second, and one that needs a person; a device added late; a key no entry adds; another key. */
const owner = await newKey("owner");
const phone = await newKey("phone");
const tablet = await newKey("tablet");
const desk = await newKey("desk");
const tower = await newKey("tower");
const pool = await newKey("pool");
const pool2 = await newKey("pool2");
const plain = await newKey("plain");
const late = await newKey("late");
const stranger = await newKey("stranger");
const other = await newKey("other");
/** A PC's relay key. */
const E = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
/** The keys of the PC at relay key n: made once. */
const machines = new Map<number, Key>();
async function machine(n: number): Promise<Key> {
  const made = machines.get(n) ?? await newKey(`machine${n}`);
  machines.set(n, made);
  return made;
}

type Own = Readonly<Record<string, string | Uint8Array>>;
/** An entry as a test writes it: any kind, any fields. */
interface Raw {
  readonly kind: string;
  readonly v?: number;
  readonly adds?: readonly [Key, SignerPower];
  readonly ends?: Key;
  readonly own?: Own;
  /** Signed with this key while `signer` names another. */
  readonly signedWith?: Key;
}

function bodyOf(raw: Raw, by: Key, place: { readonly seq: number; readonly list: string; readonly prev: string }): EntryBody {
  return {
    issued_at: T0 + 60 * place.seq, kind: raw.kind, list: place.list, prev: place.prev, seq: place.seq, signer: by.key, v: raw.v ?? 1,
    ...(raw.adds ? { adds: { key: raw.adds[0].key, power: raw.adds[1] } } : {}),
    ...(raw.ends ? { ends: raw.ends.key } : {}),
    own: Object.entries(raw.own ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, value]) => ({ name, value: typeof value === "string" ? utf8ToBytes(value) : value })),
  };
}
/** An entry of a test list: its text, and the entry as it holds. */
interface Link { readonly text: string; readonly held: HeldEntry }
async function link(body: EntryBody, signedWith: Key, list: string | null): Promise<Link> {
  const entry = await signEntry(body, signedWith.pair.privateKey);
  const hash = entryHash(entry.body);
  return { text: entryToText(entry), held: { entry, body: readBody(entry.body), hash, list: list ?? hash } };
}
const genesis = (by: Key = owner, account = "TEST-ONLY-account"): Raw => ({ kind: "genesis", own: { account, enc: by.enc, epoch: "0", epoch_opens: OPENS(0), sealed: SEALED } });
/** Entry 0: the owner's genesis unless the test says otherwise. */
const first = (raw: Raw = genesis(), by: Key = owner) => link(bodyOf(raw, by, { seq: 0, list: "", prev: "" }), raw.signedWith ?? by, null);
const next = (before: Link, by: Key, raw: Raw) =>
  link(bodyOf(raw, by, { seq: before.held.body.seq + 1, list: before.held.list, prev: before.held.hash }), raw.signedWith ?? by, before.held.list);
/** The id of every test list that starts with the owner's genesis: an entry's hash is of its body, which has nothing random in it. */
const LIST = (await first()).held.hash;

const card = (key: Key, endpoint: string | null = null, more: Partial<ListCard> = {}) => signCard({ key: key.key, enc: key.enc, list: LIST, endpoint, invite: null, ...more }, key.pair.privateKey);
const device = async (key: Key, power: SignerPower = "full", role: ListRole = "drive", more: Own = {}): Promise<Raw> =>
  ({ kind: "device", adds: [key, power], own: { card: await card(key), enc: key.enc, role, ...sealed(), ...more } });
const pc = async (key: Key, n: number): Promise<Raw> => ({ kind: "pc", adds: [key, "full"], own: { card: await card(key, E(n)), enc: key.enc, endpoint: E(n), ...sealed() } });
const invite = (key: Key, uses: number | string = 5, auto: boolean | string = true, exp: number | string = EXP): Raw =>
  ({ kind: "invite", adds: [key, "bound"], own: { auto: typeof auto === "string" ? auto : auto ? "1" : "0", exp: String(exp), ...sealed(), uses: String(uses) } });
/** The join of the PC at relay key n, with the invite `by`: the PC's card names the invite it joins with. */
const join = async (n: number, as?: Key, by: Key = pool): Promise<Raw> => {
  const key = as ?? await machine(n);
  return { kind: "join", own: { card: await card(key, E(n), { invite: by.key }), enc: key.enc, endpoint: E(n), pc: key.key, ...sealed() } };
};
const remove = (key: Key): Raw => ({ kind: "remove", ends: key });
const removePc = (n: number): Raw => ({ kind: "remove", own: { endpoint: E(n) } });
const carried = (key: Key, role: ListRole = "drive"): Raw => ({ kind: "carried", adds: [key, "full"], own: { role, ...sealed() } });
const carriedPc = (n: number): Raw => ({ kind: "carried", own: { endpoint: E(n), ...sealed() } });
const cardOf = (key: Key): Raw => ({ kind: "card", own: { enc: key.enc } });
/** The entry that opens the epoch after `current`. */
const opening = (current: number): Raw => ({ kind: "epoch", own: { epoch: String(current), epoch_link: LINK(current + 1), epoch_opens: OPENS(current + 1) } });
/** The same entry with no names: what a member writes that holds no key to seal them with. */
const bare = (raw: Raw): Raw => less(less(raw, "sealed"), "epoch");
const later = (v = 2, more: Partial<Raw> = {}): Raw => ({ kind: "later_kind", v, ...more });
/** The same entry with one more own field, with one own field less, and with one own field's value changed. */
const plus = (raw: Raw, own: Own = { note: "x" }): Raw => ({ ...raw, own: { ...raw.own, ...own } });
const less = (raw: Raw, name: string): Raw => ({ ...raw, own: Object.fromEntries(Object.entries(raw.own ?? {}).filter(([field]) => field !== name)) });

const who = (key: string | null): string => (key === null ? "a proof" : names.get(key) ?? "?");
const pcName = (endpoint: string): string => `e${Number.parseInt(endpoint.slice(0, 2), 16)}`;
/** What became of an entry, in a word or two. */
const said = (outcome: ListOutcome): string => ("code" in outcome ? `${outcome.outcome} ${outcome.code}` : outcome.outcome);
/** A state in a few words: each key that was made a signer, each device, each PC, each invite's joins of its uses. */
function seen(state: ListState) {
  return {
    signers: Object.fromEntries(Object.entries(state.signers).map(([key, row]) =>
      [who(key), `${row.power} ${row.as ?? "no name"} @${row.seq} by ${who(row.by)}${row.ended === null ? "" : ` ended@${row.ended}`}`])),
    devices: Object.fromEntries(Object.entries(state.devices).map(([key, row]) =>
      [who(key), `${row.role}${row.until === null ? "" : ` until ${row.until - T0}`}${row.enc === null ? " no enc" : ""}${row.carried ? " carried" : ""}`])),
    pcs: Object.fromEntries(Object.entries(state.pcs).map(([endpoint, row]) =>
      [pcName(endpoint), `${row.how}${row.key === null ? "" : ` ${who(row.key)}`} @${row.seq}${row.invite === null ? "" : ` with ${who(row.invite)}`}${row.removed === null ? "" : ` removed@${row.removed}`}`])),
    invites: Object.fromEntries(Object.entries(state.invites).map(([key, row]) => [who(key), `${row.joins} of ${row.uses}${row.auto ? " auto" : ""}`])),
  };
}
const OWNER = "full device @0 by owner";

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}
const only = <Row>(rows: { readonly [name: string]: Row }, wanted: readonly (string | null | undefined)[]): { [name: string]: Row } =>
  Object.fromEntries(Object.entries(rows).filter(([name]) => wanted.includes(name)));
const ownText = (body: EntryBody, name: string): string | null => {
  const field = body.own.find((item) => item.name === name);
  return field === undefined ? null : Buffer.from(field.value).toString("latin1");
};
/**
 * The rows one entry names, written here from the text and not taken from the library: its `signer`, its `adds`, its `ends` and the key
 * in its `pc`, among the signers, the devices, the invites and the PCs' keys; the PC of its `endpoint` and the PC whose key it ends;
 * and, for an entry that an invite signed, whoever placed it.
 */
function cutDown(state: ListState, body: EntryBody): ListState {
  const keys = [body.signer, body.adds?.key, body.ends, ownText(body, "pc")];
  const signer = state.signers[body.signer];
  return {
    ...state,
    signers: only(state.signers, [...keys, signer?.as === "invite" ? signer.by : null]),
    devices: only(state.devices, keys),
    invites: only(state.invites, keys),
    pc_keys: only(state.pc_keys, keys),
    pcs: only(state.pcs, [ownText(body, "endpoint"), body.ends === undefined ? null : state.pc_keys[body.ends]]),
  };
}
const withoutNames = (state: ListState) => Object.fromEntries(Object.entries(state.signers).map(([key, { power, seq, by, ended }]) => [key, { power, seq, by, ended }]));
const PARTS = ["signers", "devices", "pcs", "pc_keys", "invites"] as const;
/**
 * takeEntry, with what holds for every entry checked beside it: it changes nothing it was given; on the rows the entry names it gives
 * the same outcome and the same rows; the rows it gives back, put into the whole state, are the whole new state; the new state reads
 * again from its JSON; and its signers are the signers' own.
 */
async function taken(state: ListState, held: HeldEntry) {
  const given = JSON.stringify(state);
  const whole = await takeEntry(deepFreeze(state), held);
  expect(JSON.stringify(state)).toBe(given);
  const cut = cutDown(state, held.body);
  expect(rowsNamed(state, held.body)).toEqual(cut);
  const onCut = await takeEntry(deepFreeze(cut), held);
  expect(onCut.outcome).toEqual(whole.outcome);
  expect(onCut.state).toEqual(cutDown(whole.state, held.body));
  const merged = { ...onCut.state, ...Object.fromEntries(PARTS.map((part) => [part, { ...state[part], ...onCut.state[part] }])) };
  expect(merged as ListState).toEqual(whole.state);
  expect(readListState(JSON.parse(JSON.stringify(whole.state)), whole.state.level)).toEqual(whole.state);
  const signers = judgeEntry(state, held).state;
  expect([whole.state.footing, whole.state.needs, whole.state.behind, withoutNames(whole.state)])
    .toEqual([signers.footing, signers.needs, signers.behind, { ...(readSignersState(JSON.parse(JSON.stringify(signers)), signers.level)?.signers ?? {}) }]);
  return whole;
}

type Step = readonly [by: Key, what: Raw | Promise<Raw>];
interface Played {
  readonly links: readonly Link[];
  readonly texts: readonly string[];
  /** The state after each entry, entry 0 first. */
  readonly states: readonly ListState[];
  /** What became of each entry after entry 0. */
  readonly said: readonly string[];
  readonly state: ListState;
}
/** A list from the owner's genesis, each step signed on the one before and taken on the state before it. */
async function play(steps: readonly Step[], level = 1): Promise<Played> {
  let head = await first();
  let state = firstListState(head.held, level);
  const links = [head];
  const states = [state];
  const told: string[] = [];
  for (const [by, raw] of steps) {
    head = await next(head, by, await raw);
    const result = await taken(state, head.held);
    state = result.state;
    links.push(head);
    states.push(state);
    told.push(said(result.outcome));
  }
  const texts = links.map((item) => item.text);
  // The replay of a member from entry 0 is that function for every entry, and nothing else.
  const replayed = await replayList(texts, level, { saved: null });
  expect([replayed.stopped, replayed.member?.state, replayed.took.slice(1).map((item) => said(item.outcome))]).toEqual([null, state, told]);
  return { links, texts, states, said: told, state };
}
/** What became of the last entry of a list. */
const last = async (steps: readonly Step[], level = 1) => (await play(steps, level)).said.at(-1) ?? "";
const at = <Item>(items: readonly Item[], index: number): Item => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
};

describe("the names an entry seals", () => {
  test("a name is 1 to 48 UTF-16 units, with no control character, no unpaired surrogate, and of white space only single spaces inside it", () => {
    for (const label of ["a", "Home laptop", "x".repeat(48), "집 노트북", "a b c", "😀".repeat(24)]) expect({ label, name: isListLabel(label) }).toEqual({ label, name: true });
    for (const label of ["", "x".repeat(49), "😀".repeat(25), " a", "a ", "a  b", "a\tb", "a\nb", "a\u0000b", "a\u007fb", "a\u00a0b", "a\u3000b", "\ufeffa", "a\u2028b", "\ud800", "a\udc00b"]) {
      expect({ label, name: isListLabel(label) }).toEqual({ label, name: false });
    }
  });

  test("names are the fields label and, when the OS is known, os, and read back as they were", () => {
    const fields = namesFields({ label: "Home laptop", os: "macos" });
    expect(fields).toEqual([{ name: "label", value: utf8ToBytes("Home laptop") }, { name: "os", value: utf8ToBytes("macos") }]);
    expect(readNames(fields)).toEqual({ label: "Home laptop", os: "macos" });
    expect(namesFields({ label: "집 노트북", os: null }).map((item) => item.name)).toEqual(["label"]);
    expect(readNames(namesFields({ label: "집 노트북", os: null }))).toEqual({ label: "집 노트북", os: null });
    // They are fields in the form of an entry's: what seals them writes them under its own prefix.
    expect(readFields(writeFieldsUnder("ovis-list/1", fields)).map((item) => item.name)).toEqual(["label", "os"]);
  });

  test("a writer refuses a label that is no name and an OS word nobody knows, and checks the label before it encodes it", () => {
    for (const names of [{ label: "", os: null }, { label: " a", os: null }, { label: "\ud800", os: null }, { label: "a", os: "beos" }] as const) {
      expect(() => namesFields(names as { label: string; os: null })).toThrow(ListKindError);
    }
  });

  test("a reader gives no names where no label is a name; an OS word or a field it does not know costs nothing else", () => {
    const fields = (values: Record<string, string | Uint8Array>) => Object.entries(values).map(([name, value]) => ({ name, value: typeof value === "string" ? utf8ToBytes(value) : value }));
    expect(readNames(fields({ label: "Desk", os: "beos" }))).toEqual({ label: "Desk", os: null });
    expect(readNames(fields({ label: "Desk", os: "linux", room: "attic" }))).toEqual({ label: "Desk", os: "linux" });
    // What pads a sealed text to a fixed size is a field named `pad`: it is no name, and a writer of names writes none.
    expect(readNames(fields({ label: "Desk", os: "linux", pad: new Uint8Array(200) }))).toEqual({ label: "Desk", os: "linux" });
    expect(readNames(fields({ pad: new Uint8Array(200) }))).toBeNull();
    expect(namesFields({ label: "Desk", os: "linux" }).some((item) => item.name === "pad")).toBe(false);
    expect(readNames(fields({ os: "linux" }))).toBeNull();
    expect(readNames(fields({ label: " Desk" }))).toBeNull();
    expect(readNames(fields({ label: Uint8Array.from([0xff, 0xfe]) }))).toBeNull();
    expect(readNames(fields({ label: Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]) }))).toBeNull();
    expect(readNames([])).toBeNull();
  });
});

describe("a card: the newcomer's own word for its encryption key", () => {
  const good: ListCard = { key: phone.key, enc: phone.enc, list: LIST, endpoint: null, invite: null };

  test("its bytes are the fields enc, key and list under ovis-list-card/1, for a PC endpoint too, and for a PC that joins by an invite that invite's key", () => {
    const text = (value: string) => ({ value: utf8ToBytes(value) });
    expect(cardBytes(good)).toEqual(writeFieldsUnder(LIST_CARD_PREFIX, [{ name: "enc", ...text(phone.enc) }, { name: "key", ...text(phone.key) }, { name: "list", ...text(LIST) }]));
    expect(cardBytes({ ...good, endpoint: E(1) })).toEqual(writeFieldsUnder("ovis-list-card/1", [
      { name: "enc", ...text(phone.enc) }, { name: "endpoint", ...text(E(1)) }, { name: "key", ...text(phone.key) }, { name: "list", ...text(LIST) },
    ]));
    expect(cardBytes({ ...good, endpoint: E(1), invite: pool.key })).toEqual(writeFieldsUnder("ovis-list-card/1", [
      { name: "enc", ...text(phone.enc) }, { name: "endpoint", ...text(E(1)) }, { name: "invite", ...text(pool.key) }, { name: "key", ...text(phone.key) }, { name: "list", ...text(LIST) },
    ]));
    // Only a PC joins by an invite.
    expect(() => cardBytes({ ...good, invite: pool.key })).toThrow(ListKindError);
  });

  test("the key signs it, and it holds for exactly what was signed", async () => {
    const signature = await signCard(good, phone.pair.privateKey);
    expect(signature.length).toBe(CARD_SIGNATURE_CHARS);
    expect(await cardHolds(good, signature)).toBe(true);
    for (const changed of [{ enc: tablet.enc }, { key: tablet.key }, { list: "0".repeat(64) }, { endpoint: E(1) }]) expect(await cardHolds({ ...good, ...changed }, signature)).toBe(false);
    expect(await cardHolds(good, await signCard(good, tablet.pair.privateKey))).toBe(false);
    // A PC's card is no device's, and the other way round.
    const ofPc = await signCard({ ...good, endpoint: E(1) }, phone.pair.privateKey);
    expect([await cardHolds({ ...good, endpoint: E(1) }, ofPc), await cardHolds(good, ofPc), await cardHolds({ ...good, endpoint: E(2) }, ofPc)]).toEqual([true, false, false]);
    // The card a PC made for a person to add it is not one an invite joins it with, nor is a card for one invite another's.
    const ofJoin = await signCard({ ...good, endpoint: E(1), invite: pool.key }, phone.pair.privateKey);
    expect([await cardHolds({ ...good, endpoint: E(1), invite: pool.key }, ofJoin), await cardHolds({ ...good, endpoint: E(1) }, ofJoin), await cardHolds({ ...good, endpoint: E(1), invite: pool2.key }, ofJoin),
      await cardHolds({ ...good, endpoint: E(1), invite: pool.key }, ofPc)]).toEqual([true, false, false, false]);
  });

  test("a card or a signature out of its form holds nothing, and a writer refuses such a card", async () => {
    const signature = await signCard(good, phone.pair.privateKey);
    for (const text of ["", signature.slice(1), `${signature}A`, `${signature.slice(0, -1)}=`]) expect(await cardHolds(good, text)).toBe(false);
    for (const bad of [{ key: "x" }, { enc: "x" }, { list: "x" }, { endpoint: "x" }, { endpoint: E(171).toUpperCase() }, { endpoint: E(1), invite: "x" }]) {
      expect(await cardHolds({ ...good, ...bad }, signature)).toBe(false);
      expect(() => cardBytes({ ...good, ...bad })).toThrow(ListKindError);
    }
  });

  test("an encryption key is a key whose point is on the curve", () => {
    const bytes = fromBase64Url(phone.enc);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect([isListKey(phone.enc), isListKey(toBase64Url(bytes)), isListKey(phone.enc.slice(1))]).toEqual([true, false, false]);
  });
});

describe("the kinds of level 1 and the state they build", () => {
  test("the level table: nine kinds, each at v 1", () => {
    expect(LIST_LEVEL).toBe(1);
    expect(LIST_LEVEL_TABLE).toEqual({ genesis: { 1: 1 }, device: { 1: 1 }, pc: { 1: 1 }, invite: { 1: 1 }, join: { 1: 1 }, remove: { 1: 1 }, carried: { 1: 1 }, card: { 1: 1 }, epoch: { 1: 1 } });
  });

  test("genesis: the list starts, and its signer is the first device, which drives and has its encryption key", async () => {
    const { state, links } = await play([]);
    expect(seen(state)).toEqual({ signers: { owner: OWNER }, devices: { owner: "drive" }, pcs: {}, invites: {} });
    expect([state.list, state.footing, state.needs, state.behind, state.level]).toEqual([LIST, { seq: 0, hash: LIST }, 1, null, 1]);
    expect(state.devices[owner.key]?.enc).toBe(owner.enc);
    expect(readKind(at(links, 0).held.body)).toEqual({ kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: OPENS(0), sealed: SEAL });
    expect([state.epoch, state.epochs]).toEqual([0, [{ opens: OPENS(0), link: null, seq: 0 }]]);
  });

  test("device: the key in adds is a device with its power, its role, its until and its encryption key", async () => {
    const { said: told, state } = await play([[owner, device(phone)], [phone, device(tablet, "bound", "watch", { until: String(T0 + 86400) })], [owner, device(late, "full", "watch")]]);
    expect(told).toEqual(["counts", "counts", "counts"]);
    expect(seen(state)).toEqual({
      signers: { owner: OWNER, phone: "full device @1 by owner", tablet: "bound device @2 by phone", late: "full device @3 by owner" },
      devices: { owner: "drive", phone: "drive", tablet: "watch until 86400", late: "watch" }, pcs: {}, invites: {},
    });
    expect(state.devices[tablet.key]).toEqual({ role: "watch", until: T0 + 86400, enc: tablet.enc, carried: false });
  });

  test("pc: the key in adds is a PC at that relay key, a full signer, with its encryption key", async () => {
    const { said: told, state } = await play([[owner, pc(desk, 1)]]);
    expect(told).toEqual(["counts"]);
    expect(seen(state)).toEqual({ signers: { owner: OWNER, desk: "full pc @1 by owner" }, devices: { owner: "drive" }, pcs: { e1: "added desk @1" }, invites: {} });
    expect([state.pcs[E(1)], state.pc_keys]).toEqual([{ how: "added", key: desk.key, enc: desk.enc, seq: 1, invite: null, removed: null }, { [desk.key]: E(1) }]);
  });

  test("a PC that a person added signs as a device does: it allows a device, adds a PC, places an invite and removes", async () => {
    const { said: told, state } = await play([[owner, pc(desk, 1)], [desk, device(phone)], [desk, pc(tower, 2)], [desk, invite(pool)], [desk, remove(owner)]]);
    expect(told).toEqual(["counts", "counts", "counts", "counts", "counts"]);
    expect(seen(state).signers).toEqual({ owner: `${OWNER} ended@5`, desk: "full pc @1 by owner", phone: "full device @2 by desk", tower: "full pc @3 by desk", pool: "bound invite @4 by desk" });
  });

  test("invite: the key in adds is an invite, with its exp, its uses, whether it needs a person, who placed it and no join yet", async () => {
    const { said: told, state } = await play([[owner, invite(pool, 3)], [owner, invite(plain, 1, false)]]);
    expect(told).toEqual(["counts", "counts"]);
    expect(seen(state)).toEqual({ signers: { owner: OWNER, pool: "bound invite @1 by owner", plain: "bound invite @2 by owner" }, devices: { owner: "drive" }, pcs: {}, invites: { pool: "0 of 3 auto", plain: "0 of 1" } });
    expect(state.invites[pool.key]).toEqual({ exp: EXP, uses: 3, joins: 0, auto: true });
  });

  test("join: the PC at that relay key is in with its key, which is no signer, and one use is taken", async () => {
    const { said: told, state } = await play([[owner, invite(pool)], [pool, join(1)]]);
    const m1 = await machine(1);
    expect(told).toEqual(["counts", "counts"]);
    expect(seen(state)).toEqual({ signers: { owner: OWNER, pool: "bound invite @1 by owner" }, devices: { owner: "drive" }, pcs: { e1: "joined machine1 @2 with pool" }, invites: { pool: "1 of 5 auto" } });
    expect([state.pcs[E(1)], state.pc_keys, signerPower(state, m1.key)]).toEqual([{ how: "joined", key: m1.key, enc: m1.enc, seq: 2, invite: pool.key, removed: null }, { [m1.key]: E(1) }, null]);
  });

  test("remove: with ends the device, the PC or the invite with that key is out; with endpoint a PC whose key is no signer is out; nothing is ever deleted", async () => {
    const { said: told, state } = await play([
      [owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool)], [pool, join(2)], [owner, carriedPc(3)],
      [owner, remove(phone)], [owner, remove(desk)], [owner, remove(pool)], [owner, removePc(2)], [owner, removePc(3)],
    ]);
    expect(told).toEqual(new Array<string>(10).fill("counts"));
    expect(seen(state)).toEqual({
      signers: { owner: OWNER, phone: "full device @1 by owner ended@6", desk: "full pc @2 by owner ended@7", pool: "bound invite @3 by owner ended@8" },
      devices: { owner: "drive", phone: "drive" },
      pcs: { e1: "added desk @2 removed@7", e2: "joined machine2 @4 with pool removed@9", e3: "carried @5 removed@10" },
      invites: { pool: "1 of 5 auto" },
    });
  });

  test("carried: the first signer carries in a device, which has no encryption key yet, and a PC, which has no key yet", async () => {
    const { said: told, state } = await play([[owner, carried(phone)], [owner, carried(tablet, "watch")], [owner, carriedPc(1)]]);
    expect(told).toEqual(["counts", "counts", "counts"]);
    expect(seen(state)).toEqual({
      signers: { owner: OWNER, phone: "full device @1 by owner", tablet: "full device @2 by owner" },
      devices: { owner: "drive", phone: "drive no enc carried", tablet: "watch no enc carried" }, pcs: { e1: "carried @3" }, invites: {},
    });
  });

  test("card: a device that was carried in names its encryption key, once", async () => {
    const { said: told, state } = await play([[owner, carried(phone)], [phone, cardOf(phone)], [phone, cardOf(tablet)], [owner, cardOf(owner)], [owner, pc(desk, 1)], [desk, cardOf(desk)], [stranger, cardOf(stranger)]]);
    expect(told).toEqual(["counts", "counts", "no_effect enc_set", "no_effect enc_set", "counts", "no_effect signer_not_allowed", "passed_over signer_unknown"]);
    expect([seen(state).devices, state.devices[phone.key]?.enc]).toEqual([{ owner: "drive", phone: "drive carried" }, phone.enc]);
  });

  test("a key that is a signer without being a device signs a device that counts", async () => {
    const nameless = { ...(await device(phone)), own: { note: "x" } };
    const { said: told, state } = await play([[owner, nameless], [phone, device(tablet)]]);
    expect(told).toEqual(["no_effect entry_invalid", "counts"]);
    expect(seen(state).signers).toEqual({ owner: OWNER, phone: "full no name @1 by owner", tablet: "full device @2 by phone" });
  });

  test("the level table says which kinds a level reads: a kind it does not hold, and a form of a kind it does not hold, have no effect", async () => {
    expect(await last([[owner, { kind: "later_kind" }]])).toBe("no_effect entry_invalid");
    expect(await last([[owner, { ...(await device(phone)), v: 2 }]], 2)).toBe("no_effect entry_invalid");
    expect(await last([[owner, genesis()]])).toBe("no_effect entry_invalid");
  });
});

describe("a missing or an extra field, a value out of form: the kind has no effect (`entry_invalid`), and adds and ends have still applied", () => {
  const offCurve = (() => {
    const bytes = fromBase64Url(phone.enc);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    return toBase64Url(bytes);
  })();
  const cases: [string, () => Promise<Step>][] = [
    ["device: no card", async () => [owner, less(await device(phone), "card")]],
    ["device: no enc", async () => [owner, less(await device(phone), "enc")]],
    ["device: no role", async () => [owner, less(await device(phone), "role")]],
    ["device: an epoch with nothing sealed", async () => [owner, less(await device(phone), "sealed")]],
    ["device: names sealed under no epoch", async () => [owner, less(await device(phone), "epoch")]],
    ["device: an epoch that is no number", async () => [owner, plus(await device(phone), { epoch: "00" })]],
    ["device: one more field", async () => [owner, plus(await device(phone))]],
    ["device: a role nobody has", async () => [owner, plus(await device(phone), { role: "admin" })]],
    ["device: an until that is no number", async () => [owner, plus(await device(phone), { until: "01" })]],
    ["device: an empty until", async () => [owner, plus(await device(phone), { until: "" })]],
    ["device: an enc that is no key", async () => [owner, plus(await device(phone), { enc: phone.enc.slice(1) })]],
    ["device: an enc whose point is off the curve", async () => [owner, plus(await device(phone), { enc: offCurve })]],
    ["device: a card of 85 characters", async () => [owner, plus(await device(phone), { card: (await card(phone)).slice(1) })]],
    ["device: a card in a second spelling", async () => [owner, plus(await device(phone), { card: `${(await card(phone)).slice(0, -1)}B` })]],
    ["device: a sealed value of 46 bytes", async () => [owner, plus(await device(phone), { sealed: new Uint8Array(46) })]],
    ["device: ends of another key", async () => [owner, { ...(await device(late)), ends: tablet }]],
    ["pc: no endpoint", async () => [owner, less(await pc(desk, 1), "endpoint")]],
    ["pc: an endpoint in upper case", async () => [owner, plus(await pc(desk, 1), { endpoint: E(171).toUpperCase() })]],
    ["pc: an endpoint of 63 characters", async () => [owner, plus(await pc(desk, 1), { endpoint: E(1).slice(1) })]],
    ["pc: power bound", async () => [owner, { ...(await pc(desk, 1)), adds: [desk, "bound"] }]],
    ["pc: a role", async () => [owner, plus(await pc(desk, 1), { role: "drive" })]],
    ["pc: ends", async () => [owner, { ...(await pc(desk, 1)), ends: tablet }]],
    ["invite: no auto", async () => [owner, less(invite(pool2), "auto")]],
    ["invite: an auto that is neither 0 nor 1", async () => [owner, invite(pool2, 5, "true")]],
    ["invite: an epoch with nothing sealed", async () => [owner, less(invite(pool2), "sealed")]],
    ["invite: one more field", async () => [owner, plus(invite(pool2))]],
    ["invite: ends", async () => [owner, { ...invite(pool2), ends: tablet }]],
    ["join: no pc", async () => [pool, less(await join(1), "pc")]],
    ["join: a pc that is no key", async () => [pool, plus(await join(1), { pc: "x" })]],
    ["join: no card", async () => [pool, less(await join(1), "card")]],
    ["join: no enc", async () => [pool, less(await join(1), "enc")]],
    ["join: one more field", async () => [pool, plus(await join(1))]],
    ["remove: neither ends nor endpoint", async () => [owner, { kind: "remove" }]],
    ["remove: ends and endpoint", async () => [owner, { ...removePc(1), ends: tablet }]],
    ["remove: one more field", async () => [owner, plus(removePc(1))]],
    ["remove: ends and a field", async () => [owner, { ...remove(tablet), own: { note: "x" } }]],
    ["carried: a device with no role", async () => [owner, less(carried(late), "role")]],
    ["carried: a device of power bound", async () => [owner, { ...carried(late), adds: [late, "bound"] }]],
    ["carried: a device with an encryption key", async () => [owner, plus(carried(late), { enc: late.enc })]],
    ["carried: a PC with an epoch and nothing sealed", async () => [owner, less(carriedPc(4), "sealed")]],
    ["carried: neither a device nor a PC", async () => [owner, { kind: "carried", own: sealed() }]],
    ["carried: both a device and a PC", async () => [owner, plus(carried(late), { endpoint: E(4) })]],
    ["card: no enc", async () => [owner, { kind: "card" }]],
    ["card: one more field", async () => [owner, plus(cardOf(owner))]],
    ["card: adds", async () => [owner, { ...cardOf(owner), adds: [late, "full"] }]],
    ["card: names", async () => [owner, plus(cardOf(owner), sealed())]],
    ["remove: names", async () => [owner, plus(removePc(1), sealed())]],
    ["epoch: no link", async () => [owner, less(opening(0), "epoch_link")]],
    ["epoch: a link of 60 bytes", async () => [owner, plus(opening(0), { epoch_link: new Uint8Array(60) })]],
    ["epoch: a link of 62 bytes", async () => [owner, plus(opening(0), { epoch_link: new Uint8Array(62) })]],
    ["epoch: an opening that is no hash", async () => [owner, plus(opening(0), { epoch_opens: OPENS(1).toUpperCase() })]],
    ["epoch: no epoch", async () => [owner, less(opening(0), "epoch")]],
    ["epoch: names", async () => [owner, plus(opening(0), { sealed: SEALED })]],
    ["epoch: adds", async () => [owner, { ...opening(0), adds: [late, "full"] }]],
    ["epoch: ends", async () => [owner, { ...opening(0), ends: tablet }]],
  ];
  const before = async (): Promise<Step[]> => [[owner, await device(tablet)], [owner, invite(pool)]];

  for (const [name, step] of cases) {
    test(name, async () => {
      const made = await step();
      const { said: told, state, links } = await play([...(await before()), made]);
      expect(told.at(-1)).toBe("no_effect entry_invalid");
      const body = at(links, 3).held.body;
      expect(readKind(body)).toBeNull();
      // What the entry adds is a signer with no name, and what it ends is out: neither waits for the kind.
      if (body.adds !== undefined) expect(seen(state).signers[who(body.adds.key)]).toBe(`${body.adds.power} no name @3 by ${made[0].name}`);
      if (body.ends !== undefined) expect(state.signers[body.ends]?.ended).toBe(3);
      expect([Object.keys(state.devices).length, Object.keys(state.pcs).length, Object.keys(state.invites).length, state.epoch]).toEqual([2, 0, 1, 0]);
    });
  }

  test("readKind reads exactly the fields of a kind, whatever order a caller holds them in", async () => {
    const body = at((await play([[owner, device(phone)]])).links, 1).held.body;
    expect(readKind(body)?.kind).toBe("device");
    expect(readKind({ ...body, own: [...body.own].reverse() })?.kind).toBe("device");
    expect(readKind({ ...body, own: [...body.own, at([...body.own], 0)] })).toBeNull();
  });
});

describe("a card that is not its key's: the kind has no effect (`card_invalid`), and the key is a signer with no name", () => {
  test("a device's card: by another key, for another encryption key, for another list, or a PC's", async () => {
    const wrong: Promise<string>[] = [
      signCard({ key: phone.key, enc: phone.enc, list: LIST, endpoint: null, invite: null }, tablet.pair.privateKey),
      card(phone, null, { enc: tablet.enc }), card(phone, null, { list: "0".repeat(64) }), card(phone, E(1)),
    ];
    for (const signature of wrong) {
      const { said: told, state } = await play([[owner, plus(await device(phone), { card: await signature })]]);
      expect([told, seen(state).signers.phone, seen(state).devices]).toEqual([["no_effect card_invalid"], "full no name @1 by owner", { owner: "drive" }]);
    }
  });

  test("a PC's card: a device's, for another relay key, or one made to join by an invite; and a join's the same, or one made for a person or another invite", async () => {
    for (const signature of [card(desk), card(desk, E(2)), card(desk, E(1), { invite: pool.key })]) {
      const { said: told, state } = await play([[owner, plus(await pc(desk, 1), { card: await signature })]]);
      expect([told, seen(state).signers.desk, seen(state).pcs, state.pc_keys]).toEqual([["no_effect card_invalid"], "full no name @1 by owner", {}, {}]);
    }
    const m1 = await machine(1);
    for (const signature of [card(m1), card(m1, E(2), { invite: pool.key }), card(other, E(1), { invite: pool.key }), card(m1, E(1)), card(m1, E(1), { invite: pool2.key })]) {
      const { said: told, state } = await play([[owner, invite(pool)], [pool, plus(await join(1), { card: await signature })]]);
      expect([told.at(-1), seen(state).pcs, seen(state).invites]).toEqual(["no_effect card_invalid", {}, { pool: "0 of 5 auto" }]);
    }
  });

  test("a card made for one list lets nobody into another", async () => {
    const elsewhere = await first(genesis(owner, "TEST-ONLY-other-account"));
    expect(elsewhere.held.hash).not.toBe(LIST);
    const entry = await next(elsewhere, owner, await device(phone));
    const result = await takeEntry(firstListState(elsewhere.held, 1), entry.held);
    expect(said(result.outcome)).toBe("no_effect card_invalid");
  });
});

describe("an invite", () => {
  test("uses is a number from 1 to 256", async () => {
    for (const [uses, word] of [[0, "no_effect entry_invalid"], [1, "counts"], [256, "counts"], [257, "no_effect entry_invalid"], ["01", "no_effect entry_invalid"], ["", "no_effect entry_invalid"]] as const) {
      expect({ uses, word: await last([[owner, invite(pool, uses)]]) }).toEqual({ uses, word });
    }
    expect(INVITE_USES_MAX).toBe(256);
  });

  test("exp is at most issued_at and 7 days; no member judges it against a clock", async () => {
    const issued = T0 + 60;
    expect(await last([[owner, invite(pool, 5, true, issued + INVITE_SECONDS_MAX)]])).toBe("counts");
    expect(await last([[owner, invite(pool, 5, true, issued + INVITE_SECONDS_MAX + 1)]])).toBe("no_effect entry_invalid");
    // An exp long past: a member lets its join in all the same.
    expect((await play([[owner, invite(pool, 5, true, 1)], [pool, join(1)]])).said).toEqual(["counts", "counts"]);
  });

  test("power is bound: the key of an invite whose power is full stays a full signer with no name", async () => {
    const { said: told, state } = await play([[owner, { ...invite(pool), adds: [pool, "full"] }], [pool, join(1)]]);
    expect([told, seen(state).signers.pool, seen(state).invites]).toEqual([["no_effect entry_invalid", "no_effect invite_unknown"], "full no name @1 by owner", {}]);
  });

  test("an invite that needs a person lets no PC in by itself: its join has no effect, and the person's pc does", async () => {
    const m1 = await machine(1);
    const { said: told, state } = await play([[owner, invite(plain, 1, false)], [plain, join(1)], [owner, pc(m1, 1)]]);
    expect(told).toEqual(["counts", "no_effect invite_not_auto", "counts"]);
    expect([seen(state).pcs, seen(state).invites]).toEqual([{ e1: "added machine1 @3" }, { plain: "0 of 1" }]);
  });
});

describe("a join", () => {
  test("invite_unknown: the list holds no invite of its signer's key, whatever else that key is or was", async () => {
    expect(await last([[owner, device(phone)], [phone, join(1)]])).toBe("no_effect invite_unknown");
    expect(await last([[owner, device(tablet, "bound")], [tablet, join(1)]])).toBe("no_effect invite_unknown");
    expect(await last([[owner, pc(desk, 2)], [desk, join(1)]])).toBe("no_effect invite_unknown");
    expect(await last([[stranger, join(1)]])).toBe("passed_over invite_unknown");
  });

  test("invite_revoked: after the invite's remove, by a full signer or by the holder of the line itself; the PCs that had joined stay", async () => {
    for (const by of [owner, pool]) {
      const { said: told, state } = await play([[owner, invite(pool)], [pool, join(1)], [by, remove(pool)], [pool, join(2)]]);
      expect([told, seen(state).pcs]).toEqual([["counts", "counts", "counts", "passed_over invite_revoked"], { e1: "joined machine1 @2 with pool" }]);
    }
  });

  test("invite_void: an invite dies with whoever placed it; the PCs already in stay", async () => {
    const { said: told, state } = await play([[owner, device(phone)], [phone, invite(pool)], [pool, join(1)], [owner, remove(phone)], [pool, join(2)]]);
    expect([told.slice(2), seen(state).pcs]).toEqual([["counts", "counts", "no_effect invite_void"], { e1: "joined machine1 @3 with pool" }]);
    expect(inviteRefusal(state, pool.key)).toBe("invite_void");
  });

  test("invite_spent: a join past uses; twelve joins on uses 5, of which exactly five count", async () => {
    const steps: Step[] = [[owner, invite(pool, 5)]];
    for (let n = 1; n <= 12; n++) steps.push([pool, join(n)]);
    const { said: told, state } = await play(steps);
    expect(told.slice(1)).toEqual([...new Array<string>(5).fill("counts"), ...new Array<string>(7).fill("no_effect invite_spent")]);
    expect([Object.keys(state.pcs).length, seen(state).invites]).toEqual([5, { pool: "5 of 5 auto" }]);
  });

  test("endpoint_reused: a relay key comes in once, also after its PC was removed, with another invite, or as a person's PC", async () => {
    const m1 = await machine(1);
    const again = await newKey("again");
    const before: Step[] = [[owner, invite(pool)], [owner, invite(pool2)], [pool, join(1)]];
    expect(await last([...before, [pool, join(1, again)]])).toBe("no_effect endpoint_reused");
    expect(await last([...before, [pool2, join(1, again)]])).toBe("no_effect endpoint_reused");
    expect(await last([...before, [owner, removePc(1)], [pool, join(1, again)]])).toBe("no_effect endpoint_reused");
    expect(await last([...before, [owner, pc(again, 1)]])).toBe("no_effect endpoint_reused");
    expect(await last([[owner, pc(desk, 1)], [owner, pc(again, 1)]])).toBe("no_effect endpoint_reused");
    expect(await last([[owner, pc(desk, 1)], [owner, remove(desk)], [owner, pc(again, 1)]])).toBe("no_effect endpoint_reused");
    expect(names.get(m1.key)).toBe("machine1");
  });

  test("key_reused: a PC's key comes in once, at one relay key, and a key that is or was a signer is no PC's", async () => {
    const m1 = await machine(1);
    const before: Step[] = [[owner, invite(pool)], [pool, join(1)]];
    expect(await last([...before, [pool, join(2, m1)]])).toBe("no_effect key_reused");
    expect(await last([...before, [owner, removePc(1)], [pool, join(2, m1)]])).toBe("no_effect key_reused");
    expect(await last([[owner, invite(pool)], [owner, device(phone)], [pool, join(1, phone)]])).toBe("no_effect key_reused");
    expect(await last([[owner, invite(pool)], [owner, device(phone)], [owner, remove(phone)], [pool, join(1, phone)]])).toBe("no_effect key_reused");
    expect(await last([[owner, invite(pool)], [pool, join(1, pool)]])).toBe("no_effect key_reused");
    // The key of a PC that joined is made a signer by a full signer's adds, as any key is: it has no name, opens nothing and is no PC.
    for (const entry of [device(m1), pc(m1, 2), Promise.resolve(invite(m1)), Promise.resolve(carried(m1))]) {
      const { said: told, state } = await play([...before, [owner, entry]]);
      expect([told.at(-1), seen(state).signers.machine1, seen(state).pcs, Object.keys(state.devices).length, Object.keys(state.invites).length])
        .toEqual(["no_effect key_reused", "full no name @3 by owner".replace("full", (await entry).adds?.[1] ?? "full"), { e1: "joined machine1 @2 with pool" }, 1, 1]);
    }
  });

  test("the names keep their order: the invite's unknown, revoked, void, spent, then invite_not_auto, endpoint_reused, key_reused, card_invalid", async () => {
    const m1 = await machine(1);
    const spent: Step[] = [[owner, device(phone)], [phone, invite(pool, 1)], [pool, join(1)]];
    const reusedBadCard = plus(await join(1, m1), { card: await card(other, E(1)) });
    expect(await last([...spent, [pool, reusedBadCard]])).toBe("no_effect invite_spent");
    expect(await last([...spent, [owner, remove(phone)], [pool, reusedBadCard]])).toBe("no_effect invite_void");
    expect(await last([...spent, [owner, remove(phone)], [owner, remove(pool)], [pool, reusedBadCard]])).toBe("passed_over invite_revoked");
    expect(await last([[owner, invite(plain, 5, false)], [owner, pc(desk, 1)], [plain, plus(await join(1, desk), { card: await card(other, E(1)) })]])).toBe("no_effect invite_not_auto");
    expect(await last([[owner, invite(pool)], [pool, join(1)], [pool, reusedBadCard]])).toBe("no_effect endpoint_reused");
    expect(await last([[owner, invite(pool)], [pool, join(1)], [pool, plus(await join(2, m1), { card: await card(other, E(2)) })]])).toBe("no_effect key_reused");
  });

  test("the entry's form stands before what the list holds, and who may sign before both", async () => {
    expect(await last([[owner, invite(pool, 1)], [pool, join(1)], [pool, plus(await join(2))]])).toBe("no_effect entry_invalid");
    expect(await last([[stranger, plus(await join(2))]])).toBe("passed_over invite_unknown");
    // At a v no level defines it keeps the name the signers give it.
    expect(await last([[stranger, { ...(await join(2)), v: 2 }]])).toBe("passed_over signer_unknown");
  });
});

describe("the removals", () => {
  test("a full signer removes any device, itself and the first one too: the key is out for good, and keeps what it was", async () => {
    const { said: told, state } = await play([[owner, device(phone)], [phone, remove(owner)], [phone, remove(phone)]]);
    expect([told, seen(state).signers]).toEqual([["counts", "counts", "counts"], { owner: `${OWNER} ended@2`, phone: "full device @1 by owner ended@3" }]);
  });

  test("a bound device ends only itself, and an invite ends only itself", async () => {
    const before: Step[] = [[owner, device(phone)], [owner, device(tablet, "bound")], [owner, invite(pool)], [pool, join(1)], [owner, pc(desk, 2)]];
    for (const by of [tablet, pool]) {
      for (const what of [remove(phone), remove(owner), remove(desk), removePc(1), removePc(2)]) {
        const { said: told, state, states } = await play([...before, [by, what]]);
        expect(told.at(-1)).toBe("ends" in what ? "passed_over signer_not_allowed" : "no_effect signer_not_allowed");
        expect(seen(state)).toEqual(seen(at(states, 5)));
      }
      expect(await last([...before, [by, remove(by)]])).toBe("counts");
    }
  });

  test("out is out: a removed key is never made a signer again, and the remove of a key that is no signer is passed over", async () => {
    const before: Step[] = [[owner, device(phone)], [owner, remove(phone)]];
    expect(await last([...before, [owner, device(phone)]])).toBe("passed_over key_reused");
    expect(await last([...before, [owner, carried(phone)]])).toBe("passed_over key_reused");
    expect(await last([...before, [owner, pc(phone, 1)]])).toBe("passed_over key_reused");
    expect(await last([...before, [owner, remove(phone)]])).toBe("passed_over already_out");
    expect(await last([...before, [owner, remove(stranger)]])).toBe("passed_over already_out");
    expect(await last([...before, [phone, remove(owner)]])).toBe("passed_over signer_unknown");
  });

  test("a PC that a person added goes with its key: ends puts it out, and its relay key alone does not", async () => {
    const before: Step[] = [[owner, pc(desk, 1)]];
    expect(await last([...before, [owner, removePc(1)]])).toBe("no_effect ends_needed");
    const { said: told, state } = await play([...before, [owner, remove(desk)], [owner, removePc(1)], [desk, device(phone)]]);
    expect([told, seen(state).pcs, signerPower(state, desk.key), holdsPc(state, E(1))]).toEqual([["counts", "counts", "no_effect already_out", "passed_over signer_unknown"], { e1: "added desk @1 removed@2" }, null, false]);
    // It ends itself the same way: a person at that PC takes it out of the account.
    expect(seen((await play([...before, [desk, remove(desk)]])).state).pcs).toEqual({ e1: "added desk @1 removed@2" });
  });

  test("a PC is put out by any entry that ends its key, also one a member cannot read", async () => {
    const { said: told, state } = await play([[owner, pc(desk, 1)], [owner, later(2, { ends: desk })]]);
    expect([told, seen(state).pcs, seen(state).signers.desk]).toEqual([["counts", "cannot_read"], { e1: "added desk @1 removed@2" }, "full pc @1 by owner ended@2"]);
    const unknown = await play([[owner, pc(desk, 1)], [owner, later(1, { ends: desk })]]);
    expect([unknown.said, seen(unknown.state).pcs]).toEqual([["counts", "no_effect entry_invalid"], { e1: "added desk @1 removed@2" }]);
  });

  test("a PC that joined or was carried is put out by its relay key, by a full signer, once", async () => {
    const before: Step[] = [[owner, invite(pool)], [pool, join(1)], [owner, carriedPc(2)], [owner, device(phone)]];
    const { said: told, state } = await play([...before, [phone, removePc(1)], [phone, removePc(2)], [owner, removePc(1)], [owner, removePc(9)]]);
    expect([told.slice(4), seen(state).pcs]).toEqual([["counts", "counts", "no_effect already_out", "no_effect already_out"], { e1: "joined machine1 @2 with pool removed@5", e2: "carried @3 removed@6" }]);
  });

  test("the ends of the last full signer is lawful, and the list then takes no change but a bound key's end of itself", async () => {
    const { said: told, state } = await play([[owner, device(tablet, "bound")], [owner, invite(pool)], [owner, remove(owner)], [tablet, device(phone)], [pool, join(1)], [tablet, remove(tablet)], [pool, remove(pool)]]);
    expect(told).toEqual(["counts", "counts", "counts", "passed_over signer_not_allowed", "no_effect invite_void", "counts", "counts"]);
    expect(Object.values(state.signers).every((row) => row.ended !== null)).toBe(true);
  });
});

describe("those that were in before the list (carried)", () => {
  test("only the first signer carries anybody in", async () => {
    const before: Step[] = [[owner, device(phone)], [owner, pc(desk, 1)]];
    for (const by of [phone, desk]) {
      const { said: told, state } = await play([...before, [by, carried(late)], [by, carriedPc(2)]]);
      expect([told.slice(2), seen(state).signers.late, seen(state).devices.late, seen(state).pcs.e2]).toEqual([["no_effect signer_not_allowed", "no_effect signer_not_allowed"], "full no name @3 by " + by.name, undefined, undefined]);
    }
    expect((await play([[owner, device(tablet, "bound")], [tablet, carriedPc(2)]])).said.at(-1)).toBe("no_effect signer_not_allowed");
  });

  test("a relay key is carried in once, and never onto a PC the list holds", async () => {
    expect(await last([[owner, carriedPc(1)], [owner, carriedPc(1)]])).toBe("no_effect endpoint_reused");
    expect(await last([[owner, pc(desk, 1)], [owner, carriedPc(1)]])).toBe("no_effect endpoint_reused");
    expect(await last([[owner, carriedPc(1)], [owner, removePc(1)], [owner, carriedPc(1)]])).toBe("no_effect endpoint_reused");
  });

  test("a carried PC that is in gets its keys from a person's pc at its relay key, never from an invite's join; one that is out gets none", async () => {
    const added = await play([[owner, carriedPc(1)], [owner, pc(desk, 1)]]);
    expect([added.said, seen(added.state).pcs, added.state.pc_keys]).toEqual([["counts", "counts"], { e1: "added desk @2" }, { [desk.key]: E(1) }]);
    const joined = await play([[owner, carriedPc(1)], [owner, invite(pool)], [pool, join(1)]]);
    expect([joined.said.at(-1), seen(joined.state).pcs, seen(joined.state).invites]).toEqual(["no_effect endpoint_reused", { e1: "carried @1" }, { pool: "0 of 5 auto" }]);
    expect(await last([[owner, carriedPc(1)], [owner, removePc(1)], [owner, pc(desk, 1)]])).toBe("no_effect endpoint_reused");
  });

  test("a device hands its place to a new key in one entry: the new key is in and the old one out", async () => {
    const rotation = { ...(await device(late)), ends: phone };
    const { said: told, state } = await play([[owner, carried(phone)], [phone, rotation], [phone, device(tablet)], [late, device(tablet)]]);
    expect(told).toEqual(["counts", "counts", "passed_over signer_unknown", "counts"]);
    expect(seen(state).signers).toEqual({ owner: OWNER, phone: "full device @1 by owner ended@2", late: "full device @2 by phone", tablet: "full device @4 by late" });
    expect(readKind(bodyOf(rotation, phone, { seq: 2, list: LIST, prev: LIST }))).toMatchObject({ kind: "device", rotates: true });
  });
});

describe("the names an entry carries, and the epochs they are sealed under", () => {
  test("an entry with no names counts as one with names does: a member that holds no key to seal them with still adds and removes", async () => {
    const { said: told, state } = await play([[owner, bare(await device(phone))], [phone, bare(await pc(desk, 1))], [desk, bare(invite(pool))], [pool, bare(await join(2))], [owner, bare(carried(late))], [owner, bare(carriedPc(3))]]);
    expect(told).toEqual(new Array<string>(6).fill("counts"));
    expect([Object.keys(state.devices).length, Object.keys(state.pcs).length, Object.keys(state.invites).length]).toEqual([3, 3, 1]);
    const head = await first(bare(genesis()));
    expect(readKind(head.held.body)).toEqual({ kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: OPENS(0), sealed: null });
    expect(firstListState(head.held, 1).epoch).toBe(0);
  });

  test("epoch: a full signer opens the epoch after the current one, with the commitment to its key and the link to the key before", async () => {
    const { said: told, state } = await play([[owner, pc(desk, 1)], [owner, opening(0)], [desk, opening(1)]]);
    expect(told).toEqual(["counts", "counts", "counts"]);
    expect([state.epoch, state.epochs]).toEqual([2, [
      { opens: OPENS(0), link: null, seq: 0 }, { opens: OPENS(1), link: toBase64Url(LINK(1)), seq: 2 }, { opens: OPENS(2), link: toBase64Url(LINK(2)), seq: 3 },
    ]]);
  });

  test("an epoch entry that names another epoch than the current one has no effect: of two members that open the next at once, one does", async () => {
    const { said: told, state } = await play([[owner, device(phone)], [owner, opening(0)], [phone, opening(0)], [phone, opening(2)], [phone, opening(1)]]);
    expect([told.slice(1), state.epoch]).toEqual([["counts", "no_effect epoch_other", "no_effect epoch_other", "counts"], 2]);
  });

  test("only a full signer opens an epoch: a bound device, an invite and a key nobody added do not", async () => {
    const { said: told, state } = await play([[owner, device(tablet, "bound")], [owner, invite(pool)], [tablet, opening(0)], [pool, opening(0)], [stranger, opening(0)]]);
    expect([told.slice(2), state.epoch]).toEqual([["no_effect signer_not_allowed", "no_effect signer_not_allowed", "passed_over signer_unknown"], 0]);
  });

  test("names sealed under another epoch than the current one: the entry has no effect, and what it adds is a signer with no name", async () => {
    const stale = await device(phone);
    const ahead = plus(await pc(desk, 1), { epoch: "2" });
    sealedUnder = 1;
    const current = await device(late).finally(() => { sealedUnder = 0; });
    const { said: told, state } = await play([[owner, opening(0)], [owner, stale], [owner, ahead], [owner, current], [owner, bare(invite(pool))]]);
    expect(told).toEqual(["counts", "no_effect epoch_other", "no_effect epoch_other", "counts", "counts"]);
    expect(seen(state).signers).toEqual({ owner: OWNER, phone: "full no name @2 by owner", desk: "full no name @3 by owner", late: "full device @4 by owner", pool: "bound invite @5 by owner" });
    // The form stands before the epoch, and the epoch before what the list holds.
    expect(await last([[owner, opening(0)], [owner, plus(await device(phone), { role: "admin" })]])).toBe("no_effect entry_invalid");
    expect(await last([[owner, opening(0)], [owner, invite(pool)], [owner, carriedPc(1)], [owner, carriedPc(1)]])).toBe("no_effect epoch_other");
  });

  test("a removal moves no epoch by itself, and an epoch is opened whether or not anybody was put out", async () => {
    const { said: told, state } = await play([[owner, device(phone)], [owner, remove(phone)], [owner, opening(0)], [owner, opening(1)]]);
    expect([told, state.epoch, state.epochs.map((row) => row.seq)]).toEqual([["counts", "counts", "counts", "counts"], 2, [0, 3, 4]]);
  });

  test("a member that is behind still follows the epochs", async () => {
    const { said: told, state } = await play([[owner, later()], [owner, opening(0)]]);
    expect([told, state.behind, state.epoch]).toEqual([["cannot_read", "counts"], 1, 1]);
  });

  test("the keys an epoch's key is wrapped to: the encryption key of each device and PC that is in, and the own key of each open invite a PC joins with by itself", async () => {
    const m2 = await machine(2);
    const { state } = await play([
      [owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool, 2)], [pool, join(2)], [owner, invite(plain, 1, false)], [owner, carried(late)], [owner, carriedPc(3)],
      [owner, device(tablet, "bound")], [tablet, remove(tablet)], [owner, invite(pool2, 1)], [owner, remove(pool2)],
    ]);
    expect(wrapKeys(state, T0)).toEqual([owner.enc, phone.enc, desk.enc, pool.key, m2.enc]);
    const after = await play([[owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool, 1)], [pool, join(2)], [owner, carried(late)], [late, cardOf(late)], [owner, remove(phone)], [owner, remove(desk)], [owner, removePc(2)]]);
    expect(wrapKeys(after.state, T0)).toEqual([owner.enc, late.enc]);
  });

  test("an invite past its exp and a device past its until get no key, by the clock of whoever wraps; nobody is put out by that clock", async () => {
    const { state } = await play([[owner, device(tablet, "bound", "drive", { until: String(T0 + 86400) })], [owner, invite(pool, 2, true, T0 + 900)], [owner, invite(pool2, 2, true, T0 + 7200)]]);
    expect(wrapKeys(state, T0)).toEqual([owner.enc, tablet.enc, pool.key, pool2.key]);
    expect(wrapKeys(state, T0 + 899)).toEqual([owner.enc, tablet.enc, pool.key, pool2.key]);
    expect(wrapKeys(state, T0 + 900)).toEqual([owner.enc, tablet.enc, pool2.key]);
    expect(wrapKeys(state, T0 + 86399)).toEqual([owner.enc, tablet.enc]);
    expect(wrapKeys(state, T0 + 86400)).toEqual([owner.enc]);
    // The clock chooses only whom a key is wrapped to: the invite still lets a PC in, and the device is still a signer.
    expect([inviteRefusal(state, pool.key), signerPower(state, tablet.key), (await play([[owner, invite(pool, 2, true, 1)], [pool, join(1)]])).said.at(-1)]).toEqual([null, "bound", "counts"]);
  });

  test("the epoch a writer seals under: the current one, and only when it was opened after the last entry that put a key out", async () => {
    const at0 = { epoch: 0, opens: OPENS(0) };
    const sealing = async (steps: readonly Step[]) => sealEpoch((await play(steps)).state);
    expect(await sealing([])).toEqual(at0);
    expect(await sealing([[owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool)], [pool, join(2)], [owner, carriedPc(3)]])).toEqual(at0);
    // Whoever is put out holds the key of the epoch it was put out in: nothing more is sealed under it.
    const before: Step[] = [[owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool)], [pool, join(2)], [owner, carriedPc(3)], [owner, device(tablet, "bound")]];
    for (const out of [[owner, remove(phone)], [owner, remove(desk)], [owner, remove(pool)], [pool, remove(pool)], [owner, removePc(2)], [owner, removePc(3)], [tablet, remove(tablet)]] as Step[]) {
      expect(await sealing([...before, out])).toBeNull();
      expect(await sealing([...before, out, [owner, device(late)]])).toBeNull();
      expect(await sealing([...before, out, [owner, opening(0)]])).toEqual({ epoch: 1, opens: OPENS(1) });
    }
    // A device that hands its place to a new key puts the old key out; so does an entry a member cannot read.
    expect(await sealing([[owner, carried(phone)], [phone, { ...(await device(late)), ends: phone }]])).toBeNull();
    expect(await sealing([[owner, device(phone)], [owner, later(2, { ends: phone })]])).toBeNull();
    // An epoch opened before the removal does not count, and one opened by the member that is then put out is used by nobody.
    expect(await sealing([[owner, device(phone)], [owner, opening(0)], [owner, remove(phone)]])).toBeNull();
    expect(await sealing([[owner, device(phone)], [phone, opening(0)], [owner, remove(phone)]])).toBeNull();
    expect(await sealing([[owner, device(phone)], [phone, opening(0)], [owner, remove(phone)], [owner, opening(1)]])).toEqual({ epoch: 2, opens: OPENS(2) });
    // What put nobody out changes nothing: a refused removal, a key that was no member's, a signer with no name.
    expect(await sealing([[owner, device(phone)], [owner, remove(stranger)], [owner, removePc(9)]])).toEqual(at0);
    expect(await sealing([[owner, plus(await device(phone), { role: "admin" })], [owner, remove(phone)]])).toEqual(at0);
  });

  test("a member that is stopped for a replay seals nothing", async () => {
    const { links, state } = await play([[owner, later()]]);
    const entry = await next(at(links, 1), stranger, later());
    const stopped = (await takeEntry(state, entry.held)).state;
    expect([sealEpoch(state), stopped.needs_replay?.seq, sealEpoch(stopped)]).toEqual([{ epoch: 0, opens: OPENS(0) }, 2, null]);
  });
});

describe("what a caller reads from a state", () => {
  test("a PC lets a device in while its key is a signer and before its until, as what its role says", async () => {
    const { state } = await play([[owner, device(phone, "full", "watch")], [owner, device(tablet, "bound", "drive", { until: String(T0 + 86400) })], [owner, pc(desk, 1)], [owner, invite(pool)], [owner, device(late)], [owner, remove(late)]]);
    expect([admitsDevice(state, owner.key, T0), admitsDevice(state, phone.key, T0)]).toEqual(["drive", "watch"]);
    expect([admitsDevice(state, tablet.key, T0 + 86399), admitsDevice(state, tablet.key, T0 + 86400), admitsDevice(state, tablet.key, T0 + 90000)]).toEqual(["drive", null, null]);
    // A PC, an invite, a key that is out and a key nobody added are no devices.
    for (const key of [desk, pool, late, stranger]) expect(admitsDevice(state, key.key, T0)).toBeNull();
    // Past its until a bound device is still a signer, and still ends itself.
    expect(signerPower(state, tablet.key)).toBe("bound");
  });

  test("the devices, the PCs and the invites, each in the order it came in, those that are out among them", async () => {
    const { state } = await play([[owner, pc(desk, 1)], [owner, device(phone)], [owner, invite(pool, 1)], [pool, join(2)], [owner, carriedPc(3)], [owner, remove(phone)], [owner, invite(plain, 1, false)]]);
    const view = listView(state);
    expect(view.devices.map((row) => [who(row.key), row.power, row.role, row.seq, who(row.by), row.ended])).toEqual([["owner", "full", "drive", 0, "owner", null], ["phone", "full", "drive", 2, "owner", 6]]);
    expect(view.pcs.map((row) => [pcName(row.endpoint), row.how, row.allows, row.seq])).toEqual([["e1", "added", true, 1], ["e2", "joined", false, 4], ["e3", "carried", false, 5]]);
    expect(view.invites.map((row) => [who(row.key), row.joins, row.uses, row.auto, row.refusal])).toEqual([["pool", 1, 1, true, "invite_spent"], ["plain", 0, 1, false, null]]);
    expect([holdsPc(state, E(1)), holdsPc(state, E(2)), holdsPc(state, E(3)), holdsPc(state, E(4))]).toEqual([true, true, true, false]);
  });

  test("a PC that was put out allows nobody and is not in", async () => {
    const { state } = await play([[owner, pc(desk, 1)], [owner, remove(desk)]]);
    expect([listView(state).pcs.map((row) => [row.allows, row.removed]), holdsPc(state, E(1))]).toEqual([[[false, 2]], false]);
  });
});

describe("a member that is behind", () => {
  const before = async (): Promise<Step[]> => [[owner, await device(phone)], [owner, invite(pool)], [pool, await join(1)], [owner, later()]];

  test("an entry that its kind's rule counts still counts, and the state takes nothing in: nobody new is let in", async () => {
    const { said: told, state } = await play([...(await before()), [owner, device(late)], [late, invite(pool2)], [pool, join(2)], [owner, pc(desk, 3)], [owner, carriedPc(4)]]);
    expect(told.slice(3)).toEqual(["cannot_read", "counts", "counts", "counts", "counts", "counts"]);
    expect(seen(state)).toEqual({
      signers: { owner: OWNER, phone: "full device @1 by owner", pool: "bound invite @2 by owner", late: "full no name @5 by owner", pool2: "bound no name @6 by late", desk: "full no name @8 by owner" },
      devices: { owner: "drive", phone: "drive" }, pcs: { e1: "joined machine1 @3 with pool" }, invites: { pool: "1 of 5 auto" },
    });
    expect([state.level, state.needs, state.behind]).toEqual([1, 2, 4]);
  });

  test("it keeps its devices and applies every removal, also one signed by a device added after it fell behind", async () => {
    const { said: told, state } = await play([...(await before()), [owner, device(late)], [late, removePc(1)], [late, remove(pool)], [phone, remove(owner)], [late, remove(phone)]]);
    expect(told.slice(4)).toEqual(new Array<string>(5).fill("counts"));
    expect(seen(state)).toEqual({
      signers: { owner: `${OWNER} ended@8`, phone: "full device @1 by owner ended@9", pool: "bound invite @2 by owner ended@7", late: "full no name @5 by owner" },
      devices: { owner: "drive", phone: "drive" }, pcs: { e1: "joined machine1 @3 with pool removed@6" }, invites: { pool: "1 of 5 auto" },
    });
  });

  test("with its level raised it replays to the full state", async () => {
    const steps: Step[] = [...(await before()), [owner, device(late)], [late, invite(pool2)], [pool2, join(3, undefined, pool2)], [pool, join(2)], [late, removePc(1)]];
    const lower = await play(steps);
    const raised = await replayList(lower.texts, 2, { saved: lower.state });
    expect(lower.said.slice(3)).toEqual(["cannot_read", "counts", "counts", "no_effect invite_unknown", "counts", "counts"]);
    expect(raised.took.slice(4).map((item) => said(item.outcome))).toEqual(["no_effect entry_invalid", "counts", "counts", "counts", "counts", "counts"]);
    expect(raised.member === null ? null : seen(raised.member.state)).toEqual({
      signers: { owner: OWNER, phone: "full device @1 by owner", pool: "bound invite @2 by owner", late: "full device @5 by owner", pool2: "bound invite @6 by late" },
      devices: { owner: "drive", phone: "drive", late: "drive" },
      pcs: { e1: "joined machine1 @3 with pool removed@9", e3: "joined machine3 @7 with pool2", e2: "joined machine2 @8 with pool" },
      invites: { pool: "2 of 5 auto", pool2: "1 of 5 auto" },
    });
    expect([raised.member?.state.level, raised.member?.state.needs, raised.member?.state.behind]).toEqual([2, 2, null]);
  });

  test("an entry it cannot read does nothing of its kind, and adds and ends have applied; only a full signer's makes it behind", async () => {
    const higher = await play([[owner, { ...(await device(phone)), v: 2 }]]);
    expect([higher.said, seen(higher.state).signers.phone, higher.state.behind, higher.state.needs]).toEqual([["cannot_read"], "full no name @1 by owner", 1, 2]);
    const ending = await play([[owner, device(phone)], [owner, invite(pool)], [pool, later(2, { ends: pool })], [stranger, later()], [owner, device(tablet, "bound")]]);
    expect(ending.said).toEqual(["counts", "counts", "cannot_read", "passed_over signer_unknown", "counts"]);
    expect([seen(ending.state).signers.pool, seen(ending.state).signers.tablet, ending.state.behind]).toEqual(["bound invite @2 by owner ended@3", "bound device @5 by owner", null]);
  });
});

describe("a member from entry 0", () => {
  test("no entry, an entry 0 that does not hold, and one that is not the list it was given", async () => {
    expect(await replayList([], 1, { saved: null })).toEqual({ member: null, took: [], stopped: null, stuck: false });
    const forged = await first({ ...genesis(), signedWith: other });
    expect(await replayList([forged.text], 1, { saved: null })).toEqual({ member: null, took: [], stopped: { seq: 0, code: "signature_invalid" }, stuck: false });
    const head = await first();
    expect((await replayList([head.text], 1, { saved: null, given: "0".repeat(64) })).stopped).toEqual({ seq: 0, code: "list_mismatch" });
    expect((await replayList([head.text], 1, { saved: null, given: LIST })).member?.state.list).toBe(LIST);
  });

  test("a member follows a list only when its entry 0 is a genesis it can read: anything else stops it at entry 0 with entry_invalid", async () => {
    const stops = async (raw: Raw) => {
      const head = await first(raw);
      expect(() => firstListState(head.held, 1)).toThrow(ListKindError);
      return await replayList([head.text, (await next(head, owner, await device(phone))).text], 1, { saved: null });
    };
    for (const raw of [{ kind: "device", own: {} }, less(genesis(), "enc"), less(genesis(), "sealed"), less(genesis(), "epoch"), less(genesis(), "epoch_opens"), plus(genesis()),
      plus(genesis(), { account: "a".repeat(65) }), plus(genesis(), { account: "" }), plus(genesis(), { epoch: "1" }), plus(genesis(), { epoch_opens: "x" }),
      { ...genesis(), v: 2 }, { kind: "later_kind" }, plus(genesis(), { sealed: new Uint8Array(SEALED_MIN_BYTES - 1) })]) {
      expect(await stops(raw)).toEqual({ member: null, took: [], stopped: { seq: 0, code: "entry_invalid" }, stuck: false });
    }
  });

  test("it takes each entry it is given, entry 0 first, and stops at one that does not hold with what it took before", async () => {
    const { links, states } = await play([[owner, device(phone)], [phone, invite(pool)]]);
    const forged = await next(at(links, 2), pool, { ...(await join(1)), signedWith: other });
    const after = await next(forged, pool, await join(2));
    const replayed = await replayList([...links.map((item) => item.text), forged.text, after.text], 1, { saved: null });
    expect([replayed.stopped, replayed.member?.state, replayed.member?.entries.length, replayed.took.length]).toEqual([{ seq: 3, code: "signature_invalid" }, at(states, 2), 3, 3]);
  });

  test("a loose entry has no effect of its kind either, and is no footing", async () => {
    const { state, links, said: told } = await play([[owner, invite(pool)], [stranger, device(stranger)], [stranger, pc(other, 7)], [stranger, carriedPc(8)]]);
    expect(told.slice(1)).toEqual(["passed_over signer_unknown", "passed_over signer_unknown", "passed_over signer_unknown"]);
    expect([seen(state).signers, seen(state).pcs, state.footing]).toEqual([{ owner: OWNER, pool: "bound invite @1 by owner" }, {}, { seq: 1, hash: at(links, 1).held.hash }]);
    // The member signs its next entry on its footing, not on what a stranger put on top.
    expect(signingPlace({ entries: links.map((item) => item.text), state }, listHead({ entries: links.map((item) => item.text).slice(0, 2), state }))).toEqual({ list: LIST, prev: at(links, 1).held.hash, seq: 2 });
  });

  test("a replay is told the member's saved state and never gives a shorter history than that", async () => {
    const { texts, state } = await play([[owner, device(phone)], [phone, invite(pool)]]);
    expect((await replayList(texts, 1, { saved: state })).member?.state).toEqual(state);
    await expect(replayList(texts.slice(0, 2), 1, { saved: state })).rejects.toThrow(RangeError);
  });
});

describe("going back, on the signers' shownEntries", () => {
  test("padding of kinds that would let somebody in, and then the true list: its state is as if it had never seen the padding", async () => {
    const { links, state } = await play([[owner, invite(pool)]]);
    const head = at(links, 1);
    const padding = [await next(head, stranger, await device(stranger))];
    padding.push(await next(at(padding, 0), stranger, await join(9, stranger)));
    padding.push(await next(at(padding, 1), stranger, await pc(other, 8)));
    const truth = [await next(head, pool, await join(1))];
    truth.push(await next(at(truth, 0), owner, await device(phone)));
    const member = { entries: links.map((item) => item.text), state };

    const padded = await shownList(member, { after: 1, entries: padding.map((item) => item.text), head: { seq: 4, hash: at(padding, 2).held.hash } });
    expect(padded.took.map((item) => said(item.outcome))).toEqual(["passed_over signer_unknown", "passed_over invite_unknown", "passed_over signer_unknown"]);
    expect([padded.member.state, padded.member.entries.length, padded.stopped, padded.asks_after]).toEqual([state, 5, null, null]);
    const back = await shownList(padded.member, { after: 1, entries: truth.map((item) => item.text), head: { seq: 3, hash: at(truth, 1).held.hash } });
    expect([back.dropped_from, back.took.map((item) => said(item.outcome)), back.stopped, back.stuck]).toEqual([2, ["counts", "counts"], null, false]);
    const clean = await replayList([...member.entries, ...truth.map((item) => item.text)], 1, { saved: null });
    if (clean.member === null) throw new Error("the true list does not replay");
    expect([back.member.state, back.member.entries, listHead(back.member)]).toEqual([clean.member.state, clean.member.entries, { seq: 3, hash: at(truth, 1).held.hash }]);
    expect(seen(back.member.state)).toEqual({ signers: { owner: OWNER, pool: "bound invite @1 by owner", phone: "full device @3 by owner" }, devices: { owner: "drive", phone: "drive" }, pcs: { e1: "joined machine1 @2 with pool" }, invites: { pool: "1 of 5 auto" } });
  });

  test("another history under its footing stops it, and it keeps its state; an entry that does not hold stops it there", async () => {
    const { links, state } = await play([[owner, invite(pool)], [pool, join(1)]]);
    const member = { entries: links.map((item) => item.text), state };
    const otherTwo = await next(at(links, 1), pool, await join(2));
    const otherThree = await next(otherTwo, pool, await join(3));
    const stuck = await shownList(member, { after: 2, entries: [otherThree.text], head: { seq: 3, hash: otherThree.held.hash } });
    expect([stuck.stopped, stuck.stuck, stuck.member.state, stuck.took]).toEqual([{ seq: 3, code: "chain_broken" }, true, state, []]);
    const forged = await next(at(links, 2), pool, { ...(await join(2)), signedWith: other });
    const stopped = await shownList(member, { after: 2, entries: [forged.text], head: { seq: 3, hash: forged.held.hash } });
    expect([stopped.stopped, stopped.stuck, stopped.member.state]).toEqual([{ seq: 3, code: "signature_invalid" }, false, state]);
    const good = await next(at(links, 2), pool, await join(2));
    const went = await shownList(member, { after: 2, entries: [good.text], head: { seq: 3, hash: good.held.hash } });
    expect([went.took.map((item) => said(item.outcome)), seen(went.member.state).pcs]).toEqual([["counts"], { e1: "joined machine1 @2 with pool", e2: "joined machine2 @3 with pool" }]);
  });

  test("a member that is behind stops at an entry it cannot place, keeps the stop, and answers for nobody until it replays", async () => {
    // A level above 1 that the list needs, then an entry of that level by a key that has no row: a later kind may have let that key in.
    const { links, state } = await play([[owner, device(phone)], [owner, pc(desk, 1)], [owner, later()]]);
    const entry = await next(at(links, 3), stranger, later());
    const member = { entries: links.map((item) => item.text), state };
    const shown = await shownList(member, { after: 3, entries: [entry.text], head: { seq: 4, hash: entry.held.hash } });
    expect([shown.stopped, shown.stuck, shown.took, shown.member.state.needs_replay]).toEqual([{ seq: 4, code: "needs_replay" }, true, [], { seq: 4, hash: entry.held.hash }]);
    expect([admitsDevice(state, owner.key, T0), holdsPc(state, E(1)), listView(state).pcs.map((row) => row.allows)]).toEqual(["drive", true, [true]]);
    expect([admitsDevice(shown.member.state, owner.key, T0), holdsPc(shown.member.state, E(1)), listView(shown.member.state).pcs.map((row) => row.allows)]).toEqual([null, false, [false]]);
    expect(said((await takeEntry(state, entry.held)).outcome)).toBe("stops needs_replay");
    // The stop is saved and read again with the state.
    expect(readListState(JSON.parse(JSON.stringify(shown.member.state)), 1)).toEqual(shown.member.state);
    const replayed = await replayList(shown.member.entries, 1, { saved: shown.member.state });
    expect([replayed.stuck, replayed.stopped, replayed.member?.state]).toEqual([true, { seq: 4, code: "needs_replay" }, shown.member.state]);
  });
});

describe("a saved state: plain data that can be stored and loaded", () => {
  /** Played once: a card is a signature, so the same steps played again give other bodies and other hashes. */
  let played: Promise<ListState> | null = null;
  const saved = (): Promise<ListState> => (played ??= play([
    [owner, device(phone)], [owner, device(tablet, "bound", "watch", { until: String(T0 + 86400) })], [owner, pc(desk, 1)], [owner, invite(pool, 2)], [pool, join(2)],
    [owner, carried(late)], [owner, carriedPc(3)], [owner, invite(plain, 1, false)], [owner, remove(tablet)], [owner, opening(0)],
  ]).then((result) => result.state));
  type Loose = Record<string, Record<string, Record<string, unknown>>> & Record<string, unknown>;
  const changed = async (change: (state: Loose) => void): Promise<ListState | null> => {
    const value = JSON.parse(JSON.stringify(await saved())) as Loose;
    change(value);
    return readListState(value, 1);
  };
  const row = (state: Loose, part: string, key: string): Record<string, unknown> => {
    const found = state[part]?.[key];
    if (found === undefined) throw new Error(`no ${part} row`);
    return found;
  };
  const put = (state: Loose, part: string, value: unknown): void => { (state as Record<string, unknown>)[part] = value; };
  const epochRow = (state: Loose, epoch: number): Record<string, unknown> => {
    const found = (state.epochs as unknown as Record<string, unknown>[])[epoch];
    if (found === undefined) throw new Error(`no epoch ${epoch}`);
    return found;
  };

  test("is JSON values only, and reads again as it was saved", async () => {
    const state = await saved();
    const text = JSON.stringify(state);
    expect(readListState(JSON.parse(text), 1)).toEqual(state);
    expect(JSON.stringify(readListState(JSON.parse(text), 1))).toBe(text);
    expect(Object.keys(state).sort()).toEqual(["behind", "devices", "epoch", "epochs", "footing", "invites", "level", "list", "needs", "pc_keys", "pcs", "signers"]);
  });

  test("anything that is no state of the signers, or lacks a part, is null", async () => {
    for (const value of [null, 1, "x", [], {}]) expect(readListState(value, 1)).toBeNull();
    for (const part of ["signers", "devices", "pcs", "pc_keys", "invites", "footing", "list", "epoch", "epochs"]) expect(await changed((state) => { delete state[part]; })).toBeNull();
    for (const part of ["devices", "pcs", "pc_keys", "invites"]) expect(await changed((state) => { put(state, part, []); })).toBeNull();
    expect(await changed((state) => { put(state, "epochs", {}); })).toBeNull();
  });

  test("a state that does not agree with itself is null", async () => {
    const m2 = await machine(2);
    const changes: [string, (state: Loose) => void][] = [
      ["a signer's row with no as", (state) => { delete row(state, "signers", phone.key).as; }],
      ["an as nobody is", (state) => { row(state, "signers", phone.key).as = "machine"; }],
      ["a first signer that is no device", (state) => { row(state, "signers", owner.key).as = null; }],
      ["a PC that is no full signer", (state) => { row(state, "signers", tablet.key).as = "pc"; }],
      ["an invite that is no bound signer", (state) => { row(state, "signers", phone.key).as = "invite"; }],
      ["a device with no row among the devices", (state) => { delete state.devices?.[phone.key]; }],
      ["a device's row for a key that is no device", (state) => { (state.devices ?? {})[pool.key] = { role: "drive", until: null, enc: phone.enc, carried: false }; }],
      ["a role nobody has", (state) => { row(state, "devices", phone.key).role = "admin"; }],
      ["an until that is no number", (state) => { row(state, "devices", tablet.key).until = "soon"; }],
      ["no encryption key on a device that was not carried", (state) => { row(state, "devices", phone.key).enc = null; }],
      ["an encryption key that is no key", (state) => { row(state, "devices", phone.key).enc = "x"; }],
      ["a relay key out of form", (state) => { (state.pcs ?? {}).e = row(state, "pcs", E(1)); }],
      ["a how nobody is", (state) => { row(state, "pcs", E(1)).how = "found"; }],
      ["a PC a person added whose key is no PC", (state) => { row(state, "signers", desk.key).as = null; }],
      ["a PC a person added that is out while its key is not", (state) => { row(state, "pcs", E(1)).removed = 5; }],
      ["a PC a person added at another place than its key's", (state) => { row(state, "pcs", E(1)).seq = 4; }],
      ["a PC that joined with no invite", (state) => { row(state, "pcs", E(2)).invite = null; }],
      ["a PC that joined with a key that is no invite", (state) => { row(state, "pcs", E(2)).invite = phone.key; }],
      ["a PC that joined before its invite was placed", (state) => { row(state, "pcs", E(2)).seq = 4; }],
      ["a PC that joined with no key", (state) => { row(state, "pcs", E(2)).key = null; }],
      ["a carried PC with a key", (state) => { row(state, "pcs", E(3)).key = m2.key; }],
      ["a PC removed before it came in", (state) => { row(state, "pcs", E(3)).removed = 2; }],
      ["a PC past the footing", (state) => { row(state, "pcs", E(3)).seq = 99; }],
      ["two PCs with one key", (state) => { (state.pcs ?? {})[E(9)] = { ...row(state, "pcs", E(2)) }; }],
      ["a PC's key missing from pc_keys", (state) => { delete state.pc_keys?.[m2.key]; }],
      ["a pc_keys member for no PC", (state) => { (state.pc_keys as unknown as Record<string, string>)[phone.key] = E(1); }],
      ["a pc_keys member at another relay key", (state) => { (state.pc_keys as unknown as Record<string, string>)[m2.key] = E(1); }],
      ["an invite with no row among the invites", (state) => { delete state.invites?.[pool.key]; }],
      ["an invite's row for a key that is no invite", (state) => { (state.invites ?? {})[phone.key] = { exp: EXP, uses: 1, joins: 0, auto: true }; }],
      ["joins that are not the PCs that joined", (state) => { row(state, "invites", pool.key).joins = 2; }],
      ["uses below its joins", (state) => { row(state, "invites", pool.key).uses = 0; }],
      ["uses past 256", (state) => { row(state, "invites", pool.key).uses = 257; }],
      ["an auto that is no boolean", (state) => { row(state, "invites", pool.key).auto = "1"; }],
      ["a join on an invite that needs a person", (state) => { row(state, "invites", pool.key).auto = false; }],
      ["an epoch that is not the last one opened", (state) => { put(state, "epoch", 0); }],
      ["no epoch at all", (state) => { put(state, "epochs", []); }],
      ["an epoch 0 that entry 0 did not open", (state) => { epochRow(state, 0).seq = 1; }],
      ["an epoch 0 with a link", (state) => { epochRow(state, 0).link = toBase64Url(LINK(1)); }],
      ["a later epoch with no link", (state) => { epochRow(state, 1).link = null; }],
      ["a link of another length", (state) => { epochRow(state, 1).link = toBase64Url(new Uint8Array(60)); }],
      ["an opening that is no hash", (state) => { epochRow(state, 1).opens = "x"; }],
      ["an epoch opened past the footing", (state) => { epochRow(state, 1).seq = 99; }],
      ["an epoch opened before the one before it", (state) => { epochRow(state, 1).seq = 0; }],
    ];
    for (const [name, change] of changes) expect({ name, state: await changed(change) }).toEqual({ name, state: null });
    expect(await changed(() => undefined)).toEqual(await saved());
  });

  test("a PC joined while whoever placed its invite was a signer: a row that says it joined after that is no state", async () => {
    const { state } = await play([[owner, device(phone)], [phone, invite(pool)], [pool, join(1)], [owner, remove(phone)]]);
    const value = JSON.parse(JSON.stringify(state)) as Loose;
    expect(readListState(value, 1)).toEqual(state);
    row(value, "pcs", E(1)).seq = 4;
    expect(readListState(value, 1)).toBeNull();
  });

  test("behind: while it is behind it lets nobody new in, so no named row stands at or past that place", async () => {
    const { state } = await play([[owner, device(phone)], [owner, later()], [owner, device(late)]]);
    expect([state.behind, seen(state).signers.late]).toEqual([2, "full no name @3 by owner"]);
    const value = JSON.parse(JSON.stringify(state)) as Loose;
    expect(readListState(value, 1)).toEqual(state);
    row(value, "signers", late.key).as = "device";
    (value.devices ?? {})[late.key] = { role: "drive", until: null, enc: late.enc, carried: false };
    expect(readListState(value, 1)).toBeNull();
  });

  test("a state that a higher level wrote is read back stopped at its footing", async () => {
    const { texts } = await play([[owner, device(phone)]]);
    const higher = (await replayList(texts, 2, { saved: null })).member?.state;
    if (!higher) throw new Error("no member");
    const read = readListState(JSON.parse(JSON.stringify(higher)), 1);
    expect([read?.needs_replay, read === null ? null : admitsDevice(read, phone.key, T0)]).toEqual([higher.footing, null]);
  });
});

describe("writing an entry of one of the kinds (kindBody)", () => {
  const place: EntryPlace = { issued_at: T0 + 60, list: LIST, prev: LIST, seq: 1, signer: owner.key };

  test("each kind is written at v 1 with exactly its fields, and reads again as it was given", async () => {
    const m1 = await machine(1);
    const kinds: ListKind[] = [
      { kind: "device", key: phone.key, power: "full", role: "drive", until: null, enc: phone.enc, card: await card(phone), sealed: SEAL, rotates: false },
      { kind: "device", key: tablet.key, power: "bound", role: "watch", until: T0 + 86400, enc: tablet.enc, card: await card(tablet), sealed: { epoch: 3, bytes: SEALED }, rotates: false },
      { kind: "device", key: late.key, power: "full", role: "drive", until: null, enc: late.enc, card: await card(late), sealed: null, rotates: true },
      { kind: "pc", key: desk.key, endpoint: E(1), enc: desk.enc, card: await card(desk, E(1)), sealed: SEAL },
      { kind: "pc", key: desk.key, endpoint: E(1), enc: desk.enc, card: await card(desk, E(1)), sealed: null },
      { kind: "invite", key: pool.key, exp: EXP, uses: 5, auto: true, sealed: SEAL },
      { kind: "invite", key: plain.key, exp: EXP, uses: 1, auto: false, sealed: null },
      { kind: "join", endpoint: E(1), pc: m1.key, enc: m1.enc, card: await card(m1, E(1)), sealed: SEAL },
      { kind: "join", endpoint: E(1), pc: m1.key, enc: m1.enc, card: await card(m1, E(1)), sealed: null },
      { kind: "remove", ends: phone.key },
      { kind: "remove", endpoint: E(1) },
      { kind: "carried", key: phone.key, role: "watch", sealed: SEAL },
      { kind: "carried", endpoint: E(1), sealed: null },
      { kind: "card", enc: owner.enc },
      { kind: "epoch", epoch: 0, opens: OPENS(1), link: LINK(1) },
    ];
    for (const kind of kinds) {
      const body = kindBody(place, kind);
      expect([body.kind, body.v, body.seq, body.signer]).toEqual([kind.kind, 1, 1, owner.key]);
      expect(readKind(body)).toEqual(kind);
      // It is what a signer signs: the entry reads back to the same kind from its bytes.
      const entry = await signEntry(body, owner.pair.privateKey);
      expect(readKind(readBody(entry.body))).toEqual(kind);
    }
    const first0 = kindBody({ issued_at: T0, list: "", prev: "", seq: 0, signer: owner.key }, { kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: OPENS(0), sealed: SEAL });
    expect(entryHash((await signEntry(first0, owner.pair.privateKey)).body)).toBe(LIST);
    // A rotation ends the place's own signer, and nobody else.
    expect(kindBody(place, at(kinds, 2)).ends).toBe(owner.key);
  });

  test("the fields of an entry as it is signed, in their order", async () => {
    const entry = await signEntry(kindBody(place, { kind: "pc", key: desk.key, endpoint: E(1), enc: desk.enc, card: await card(desk, E(1)), sealed: SEAL }), owner.pair.privateKey);
    expect(readFields(entry.body).map((item) => item.name)).toEqual(["adds", "card", "enc", "endpoint", "epoch", "issued_at", "kind", "list", "power", "prev", "sealed", "seq", "signer", "v"]);
  });

  test("what no member would read as that kind is refused as entry_invalid", async () => {
    const good = await card(phone);
    const refused: ListKind[] = [
      { kind: "genesis", account: "", enc: owner.enc, opens: OPENS(0), sealed: SEAL },
      { kind: "genesis", account: "TEST-ONLY-account", enc: "x", opens: OPENS(0), sealed: SEAL },
      { kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: "x", sealed: SEAL },
      { kind: "genesis", account: "TEST-ONLY-account", enc: owner.enc, opens: OPENS(0), sealed: { epoch: 1, bytes: SEALED } },
      { kind: "device", key: phone.key, power: "full", role: "drive", until: null, enc: phone.enc, card: good.slice(1), sealed: SEAL, rotates: false },
      { kind: "device", key: phone.key, power: "full", role: "admin" as ListRole, until: null, enc: phone.enc, card: good, sealed: SEAL, rotates: false },
      { kind: "device", key: phone.key, power: "full", role: "drive", until: -1, enc: phone.enc, card: good, sealed: SEAL, rotates: false },
      { kind: "device", key: phone.key, power: "full", role: "drive", until: null, enc: phone.enc, card: good, sealed: { epoch: 0, bytes: new Uint8Array(46) }, rotates: false },
      { kind: "device", key: phone.key, power: "full", role: "drive", until: null, enc: phone.enc, card: good, sealed: { epoch: -1, bytes: SEALED }, rotates: false },
      { kind: "pc", key: desk.key, endpoint: "x", enc: desk.enc, card: good, sealed: SEAL },
      { kind: "invite", key: pool.key, exp: EXP, uses: 0, auto: true, sealed: SEAL },
      { kind: "invite", key: pool.key, exp: T0 + 60 + INVITE_SECONDS_MAX + 1, uses: 1, auto: true, sealed: SEAL },
      { kind: "join", endpoint: E(1), pc: "x", enc: desk.enc, card: good, sealed: SEAL },
      { kind: "remove", endpoint: E(171).toUpperCase() },
      { kind: "carried", endpoint: "x", sealed: SEAL },
      { kind: "card", enc: "x" },
      { kind: "epoch", epoch: 0, opens: "x", link: LINK(1) },
      { kind: "epoch", epoch: 0, opens: OPENS(1), link: new Uint8Array(60) },
    ];
    for (const kind of refused) expect(() => kindBody(place, kind)).toThrow(ListKindError);
  });
});

describe("the invite's proof for reading", () => {
  const proofOf = (more: Partial<ReadProof> = {}): ReadProof => ({ key: pool.key, list: LIST, after: null, at: T0 + 600, ...more });
  const refusal = async (text: string) => {
    try {
      await checkReadProof(text);
    } catch (error) {
      if (error instanceof ReadProofError) return error.code;
      throw error;
    }
    return null;
  };
  const signed = async (fields: Record<string, string>, by: Key = pool, prefix = LIST_READ_PREFIX) => {
    const body = writeFieldsUnder(prefix, Object.entries(fields).map(([name, value]) => ({ name, value: utf8ToBytes(value) })));
    return entryToText({ body, signature: new Uint8Array(await crypto.subtle.sign(SIGN, by.pair.privateKey, body as Uint8Array<ArrayBuffer>)) });
  };
  const fields = { after: "", at: String(T0 + 600), key: pool.key, list: LIST };

  test("the holder of the line makes it with the invite's key: one text as an entry is, a body ovis-list-read/1 with the fields after, at, key and list", async () => {
    for (const proof of [proofOf(), proofOf({ after: 7 }), proofOf({ after: 0 })]) {
      const text = await signReadProof(proof, pool.pair.privateKey);
      expect(await checkReadProof(text)).toEqual(proof);
      expect(Buffer.from(entryFromText(text).body.subarray(0, 16)).toString()).toBe("ovis-list-read/1");
    }
    expect(await refusal(await signed(fields))).toBeNull();
  });

  test("a proof whose form fails is proof_malformed, and one whose signature fails is signature_invalid, its form asked first", async () => {
    const { after: _after, ...noAfter } = fields;
    for (const text of [await signed(noAfter), await signed({ ...fields, note: "x" }), await signed({ ...fields, at: "" }), await signed({ ...fields, at: "01" }), await signed({ ...fields, after: "x" }),
      await signed({ ...fields, key: "x" }), await signed({ ...fields, list: "" }), await signed(fields, pool, "ovis-list/1"), "x", `${await signed(fields)}=`]) {
      expect(await refusal(text)).toBe("proof_malformed");
    }
    expect(await refusal(await signed(fields, other))).toBe("signature_invalid");
    expect(await refusal(await signed({ ...fields, at: "" }, other))).toBe("proof_malformed");
    await expect(signReadProof(proofOf({ key: "x" }), pool.pair.privateKey)).rejects.toThrow(ReadProofError);
  });

  test("what the list holds of its invite, after its form and its signature: the first of invite_unknown, invite_revoked, invite_void, invite_spent", async () => {
    const open = (await play([[owner, device(phone)], [phone, invite(pool, 1)]])).state;
    expect(readProofRefusal(open, proofOf())).toBeNull();
    expect(readProofRefusal(open, proofOf({ list: "0".repeat(64) }))).toBe("invite_unknown");
    expect(readProofRefusal(open, proofOf({ key: phone.key }))).toBe("invite_unknown");
    const spent = (await play([[owner, device(phone)], [phone, invite(pool, 1)], [pool, join(1)]])).state;
    expect(readProofRefusal(spent, proofOf())).toBe("invite_spent");
    const voided = (await play([[owner, device(phone)], [phone, invite(pool, 1)], [pool, join(1)], [owner, remove(phone)]])).state;
    expect(readProofRefusal(voided, proofOf())).toBe("invite_void");
    const revoked = (await play([[owner, device(phone)], [phone, invite(pool, 1)], [pool, join(1)], [owner, remove(phone)], [pool, remove(pool)]])).state;
    expect(readProofRefusal(revoked, proofOf())).toBe("invite_revoked");
  });
});

/** A small generator with a seed, so a failing history can be played again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

describe("over generated histories", () => {
  /** The keys a history draws from: members to be, and keys that no entry of a member ever adds (a lying service's own). */
  const actors = [owner, phone, tablet, desk, tower, pool, pool2, plain, late];
  const outsiders = [stranger, other];
  /** Who is in, as a caller would ask: the keys that may sign, the devices a PC lets in, the PCs, the open invites. */
  const membership = (state: ListState) => ({
    signers: Object.entries(state.signers).filter(([key]) => signerPower(state, key) !== null).map(([key, row]) => `${who(key)} ${row.power} ${row.as}`).sort(),
    devices: Object.keys(state.devices).filter((key) => admitsDevice(state, key, T0) !== null).map((key) => `${who(key)} ${admitsDevice(state, key, T0)}`).sort(),
    pcs: Object.keys(state.pcs).filter((endpoint) => holdsPc(state, endpoint)).map((endpoint) => `${pcName(endpoint)} ${state.pcs[endpoint]?.how} ${who(state.pcs[endpoint]?.key ?? null)}`).sort(),
    invites: Object.keys(state.invites).filter((key) => inviteRefusal(state, key) === null).map(who).sort(),
  });
  /** One entry of any kind, lawful or not, by anybody, about anybody. */
  async function anyEntry(random: () => number, state: ListState): Promise<Step> {
    const pick = <Item>(items: readonly Item[]): Item => at(items, Math.floor(random() * items.length));
    const everyone = [...actors, ...outsiders];
    // Now and then a key that the list holds signs: histories with only strangers in them show little.
    const insiders = everyone.filter((key) => signerPower(state, key.key) !== null);
    const by = insiders.length > 0 && random() < 0.6 ? pick(insiders) : pick(random() < 0.15 ? outsiders : everyone);
    const about = pick(everyone);
    const n = 1 + Math.floor(random() * 12);
    const power: SignerPower = random() < 0.25 ? "bound" : "full";
    // Names are sealed under the epoch that is current, most of the time.
    sealedUnder = random() < 0.9 ? state.epoch : state.epoch + 1;
    const makers: (() => Promise<Raw> | Raw)[] = [
      () => opening(random() < 0.8 ? state.epoch : state.epoch + 1),
      async () => bare(await device(about, power)),
      () => device(about, power, random() < 0.3 ? "watch" : "drive", random() < 0.3 ? { until: String(T0 + 86400) } : {}),
      () => pc(about, n),
      () => invite(about, 1 + Math.floor(random() * 3), random() < 0.7),
      async () => join(n, random() < 0.5 ? await machine(n) : about, random() < 0.8 ? by : about),
      () => remove(about),
      () => removePc(n),
      () => carried(about),
      () => carriedPc(n),
      () => cardOf(about),
      async () => ({ ...(await device(about)), ends: by }),
      async () => plus(await device(about), { card: await card(other) }),
      () => ({ kind: "later_kind", adds: [about, power] }),
      () => ({ kind: "later_kind", ends: about }),
    ];
    // An invite mostly does what an invite is for: it lets the PC at a relay key in. And now and then somebody signs itself out.
    const made = state.signers[by.key]?.as === "invite" && random() < 0.6 ? join(n, undefined, by) : random() < 0.05 ? remove(by) : pick(makers)();
    return [by, await Promise.resolve(made).finally(() => { sealedUnder = 0; })];
  }

  test("nobody comes in but by a full signer's entry, or by the join of an open invite that a full signer placed; a bound key changes nothing but its own end; out is out", async () => {
    const happened = new Map<string, number>();
    for (let seed = 1; seed <= 30; seed++) {
      const random = seeded(seed);
      let head = await first();
      let state = firstListState(head.held, 1);
      const out = { keys: new Set<string>(), endpoints: new Set<string>(), pcKeys: new Set<string>() };
      for (let step = 0; step < 70; step++) {
        const [by, raw] = await anyEntry(random, state);
        const before = state;
        const power = signerPower(before, by.key);
        const was = membership(before);
        head = await next(head, by, await raw);
        const result = await taken(before, head.held);
        state = result.state;
        const now = membership(state);
        const where = `seed ${seed} step ${step} ${by.name} ${(await raw).kind} ${said(result.outcome)}`;
        const word = `${power ?? "nobody"}: ${(await raw).kind} ${said(result.outcome)}`;
        happened.set(word, (happened.get(word) ?? 0) + 1);
        const body = head.held.body;
        const came = (part: keyof typeof now) => now[part].filter((item) => !was[part].includes(item));
        const left = (part: keyof typeof now) => was[part].filter((item) => !now[part].includes(item));
        if (power === null) {
          // No signer for this member: a lying service's entry, or one by a key that is out. Nothing moves.
          expect({ where, now, epoch: state.epoch }).toEqual({ where, now: was, epoch: before.epoch });
          expect(state.footing).toEqual(before.footing);
        } else if (power === "bound") {
          // A browser on a borrowed computer, or an invite: nobody else comes in or goes out, but for the PC an open invite lets in.
          const joined = body.kind === "join" && result.outcome.outcome === "counts";
          expect({ where, came: [came("signers"), came("devices"), came("invites")] }).toEqual({ where, came: [[], [], []] });
          expect({ where, pcs: came("pcs").length }).toEqual({ where, pcs: joined ? 1 : 0 });
          expect({ where, left: left("pcs") }).toEqual({ where, left: [] });
          for (const item of [...left("signers"), ...left("devices")]) expect({ where, item: item.split(" ")[0] }).toEqual({ where, item: by.name });
          expect({ where, epoch: state.epoch }).toEqual({ where, epoch: before.epoch });
          // What its own end takes with it: an invite that is void without it. No such invite was placed by a bound key, so none goes.
          expect({ where, left: left("invites").filter((name) => name !== by.name) }).toEqual({ where, left: [] });
          if (joined) {
            const placer = before.signers[by.key]?.by ?? "";
            expect({ where, placed: before.signers[placer]?.power, auto: before.invites[by.key]?.auto, signer: signerPower(state, ownText(body, "pc") ?? "") }).toEqual({ where, placed: "full", auto: true, signer: null });
          }
        }
        // Out is out, whoever signs what: a key that was ended never signs or opens again, a PC that was put out is never in again, and its key is never a PC's again.
        for (const key of out.keys) expect({ where, key: who(key), power: signerPower(state, key), admitted: admitsDevice(state, key, T0) }).toEqual({ where, key: who(key), power: null, admitted: null });
        for (const endpoint of out.endpoints) expect({ where, endpoint: pcName(endpoint), held: holdsPc(state, endpoint) }).toEqual({ where, endpoint: pcName(endpoint), held: false });
        for (const key of out.pcKeys) {
          const row = state.signers[key];
          expect({ where, key: who(key), as: row?.as ?? null, pcs: Object.values(state.pcs).filter((item) => item.key === key && item.removed === null).length }).toEqual({ where, key: who(key), as: row?.as === "pc" ? "pc" : null, pcs: 0 });
        }
        for (const [key, row] of Object.entries(state.signers)) if (row.ended !== null) out.keys.add(key);
        for (const [endpoint, row] of Object.entries(state.pcs)) {
          if (row.removed === null) continue;
          out.endpoints.add(endpoint);
          if (row.key !== null) out.pcKeys.add(row.key);
        }
        // A PC that joined by an invite is a signer only when a full signer's own entry added its key afterwards: never by its join.
        for (const row of Object.values(state.pcs)) {
          if (row.how !== "joined" || row.key === null) continue;
          const signer = state.signers[row.key];
          if (signer !== undefined) expect({ where, as: signer.as, after: signer.seq > row.seq, by: state.signers[signer.by ?? ""]?.power }).toEqual({ where, as: null, after: true, by: "full" });
        }
      }
    }
    // The histories are no walk through refusals alone: each kind counted, by each kind of signer that may place it, and each was refused.
    if (process.env["LIST_HISTORIES"]) console.log([...happened].sort().map(([word, count]) => `${count} ${word}`).join("\n"));
    for (const word of ["full: device counts", "full: pc counts", "full: invite counts", "bound: join counts", "full: remove counts", "bound: remove counts", "full: carried counts", "full: epoch counts",
      "bound: device passed_over signer_not_allowed", "bound: remove passed_over signer_not_allowed", "bound: epoch no_effect signer_not_allowed", "nobody: device passed_over signer_unknown",
      "nobody: join passed_over invite_unknown", "full: device passed_over key_reused", "full: device no_effect card_invalid", "full: device no_effect epoch_other", "full: epoch no_effect epoch_other"]) {
      expect({ word, times: (happened.get(word) ?? 0) > 0 }).toEqual({ word, times: true });
    }
  }, 120_000);

  test("a lying service's entries on top of a member's list never add anybody, and the member's state is as if it had never been shown them", async () => {
    for (let seed = 21; seed <= 26; seed++) {
      const random = seeded(seed);
      const { links, state } = await play([[owner, device(phone)], [owner, pc(desk, 1)], [owner, invite(pool, 3)], [pool, join(2)], [phone, device(tablet, "bound")]]);
      const member = { entries: links.map((item) => item.text), state };
      // The service holds no member's key: it signs with its own, and with the key of a device it makes up a card for.
      const padding: Link[] = [];
      for (let index = 0; index < 8; index++) {
        const by = at(outsiders, Math.floor(random() * outsiders.length));
        const makers: (() => Promise<Raw> | Raw)[] = [
          () => device(by), () => device(stranger, "full", "drive"), () => pc(other, 6), () => invite(by), () => join(5, by), () => remove(phone), () => removePc(2), () => carried(by), () => carriedPc(4), () => cardOf(by),
        ];
        padding.push(await next(padding.at(-1) ?? at(links, 5), by, await at(makers, Math.floor(random() * makers.length))()));
      }
      const head = at(padding, padding.length - 1);
      const shown = await shownList(member, { after: 5, entries: padding.map((item) => item.text), head: { seq: head.held.body.seq, hash: head.held.hash } });
      expect(shown.took.every((item) => item.outcome.outcome === "passed_over" && item.outcome.loose)).toBe(true);
      expect([shown.member.state, shown.stopped]).toEqual([state, null]);
      // The member still signs on its footing, and what an honest member then places takes the padding's place.
      expect(signingPlace(shown.member, { seq: 5, hash: at(links, 5).held.hash })).toEqual({ list: LIST, prev: at(links, 5).held.hash, seq: 6 });
      const honest = await next(at(links, 5), owner, await device(late));
      const back = await shownList(shown.member, { after: 5, entries: [honest.text], head: { seq: 6, hash: honest.held.hash } });
      const clean = await replayList([...member.entries, honest.text], 1, { saved: null });
      expect([back.dropped_from, back.member.state, back.member.entries]).toEqual([6, clean.member?.state ?? null, clean.member?.entries ?? []]);
    }
  }, 120_000);

  test("whatever an entry carries, it reads as no kind or as one that is written back to the same fields", async () => {
    const random = seeded(99);
    const pick = <Item>(items: readonly Item[]): Item => at(items, Math.floor(random() * items.length));
    const m1 = await machine(1);
    const bases: Raw[] = [genesis(), await device(phone), await device(tablet, "bound", "watch", { until: String(T0 + 9) }), { ...(await device(late)), ends: owner }, await pc(desk, 1), invite(pool), invite(plain, 1, false),
      await join(1), remove(phone), removePc(1), carried(phone), carriedPc(1), cardOf(owner), opening(0)];
    const values: (string | Uint8Array)[] = ["", "0", "1", "01", "drive", "x", E(1), E(171).toUpperCase(), phone.key, phone.enc, m1.key, OPENS(1), SEALED, new Uint8Array(46), LINK(1), new Uint8Array(60), await card(phone)];
    const names = ["account", "auto", "card", "enc", "endpoint", "epoch", "epoch_link", "epoch_opens", "exp", "pc", "role", "sealed", "until", "uses", "note"];
    let read = 0;
    for (let round = 0; round < 3000; round++) {
      let raw = pick(bases);
      for (let change = Math.floor(random() * 3); change > 0; change--) {
        const way = random();
        if (way < 0.4) raw = less(raw, pick(names));
        else if (way < 0.8) raw = plus(raw, { [pick(names)]: pick(values) });
        else if (way < 0.9) raw = { ...raw, adds: [pick([phone, late]), pick(["full", "bound"] as const)] };
        else raw = { ...raw, ends: pick([owner, phone]) };
      }
      const body = bodyOf(raw, owner, { seq: 1, list: LIST, prev: LIST });
      const kind = readKind(body);
      if (kind === null) continue;
      read++;
      const { issued_at, list, prev, seq, signer } = body;
      const again = kindBody({ issued_at, list, prev, seq, signer }, kind);
      expect(again).toEqual(body);
      expect(readKind(again)).toEqual(kind);
    }
    // Most of what such changes make is of no kind; enough of it is.
    expect(read).toBeGreaterThan(300);
  });

  test("what a member holds never depends on where an honest answer was cut", async () => {
    const steps: Step[] = [[owner, device(phone)], [owner, pc(desk, 1)], [desk, invite(pool, 2)], [pool, join(2)], [phone, device(tablet, "bound", "watch")], [desk, remove(phone)], [owner, carriedPc(3)], [tablet, remove(tablet)]];
    const { links, state } = await play(steps);
    const texts = links.map((item) => item.text);
    const head = { seq: links.length - 1, hash: at(links, links.length - 1).held.hash };
    const start = { entries: [at(texts, 0)], state: firstListState(at(links, 0).held, 1) };
    for (let size = 1; size <= texts.length; size++) {
      let member: ListCopy = start;
      for (let after = 0; after < texts.length - 1; after += size) {
        const shown = await shownList(member, { after, entries: texts.slice(after + 1, after + 1 + size), head });
        expect([shown.stopped, shown.stuck]).toEqual([null, false]);
        member = shown.member;
      }
      expect({ size, state: member.state, entries: member.entries }).toEqual({ size, state, entries: texts });
    }
  });
});

describe("the vectors of kinds/, card/ and names/", () => {
  const DIR = joinPath(import.meta.dir, "account-list-vectors");
  const load = <Vector>(folder: string): Vector[] => readdirSync(joinPath(DIR, folder)).filter((file) => file.endsWith(".json")).sort()
    .map((file) => JSON.parse(readFileSync(joinPath(DIR, folder, file), "utf8")) as Vector);
  interface KindsVector {
    readonly name: string;
    readonly level: number;
    readonly keys: Readonly<Record<string, { readonly pkcs8: string; readonly spki: string }>>;
    readonly entries: readonly { readonly fields: Readonly<Record<string, string>>; readonly text: string; readonly hash: string }[];
    readonly expect: { readonly outcomes: readonly string[]; readonly state: ListState } | { readonly stops: { readonly seq: number; readonly code: string } };
  }
  const kinds = load<KindsVector>("kinds");

  test("kinds/: there is a vector for each kind, each refusal's name and each way a member stops", () => {
    const outcomes = new Set(kinds.flatMap((vector) => ("outcomes" in vector.expect ? vector.expect.outcomes : [`stops ${vector.expect.stops.code}`])));
    for (const word of ["counts", "cannot_read", "no_effect entry_invalid", "no_effect invite_unknown", "no_effect invite_void", "no_effect invite_spent", "no_effect invite_not_auto",
      "no_effect signer_not_allowed", "no_effect already_out", "no_effect ends_needed", "no_effect endpoint_reused", "no_effect key_reused", "no_effect card_invalid", "no_effect enc_set",
      "no_effect epoch_other",
      "passed_over signer_unknown", "passed_over signer_not_allowed", "passed_over key_reused", "passed_over already_out", "passed_over invite_unknown", "passed_over invite_revoked", "stops entry_invalid"]) {
      expect({ word, there: outcomes.has(word) }).toEqual({ word, there: true });
    }
    const written = new Set(kinds.flatMap((vector) => vector.entries.map((entry) => entry.fields.kind)));
    expect([...written].sort()).toEqual(expect.arrayContaining(Object.keys(LIST_LEVEL_TABLE).sort()));
    expect(kinds.length).toBeGreaterThanOrEqual(30);
    for (const vector of kinds) expect(Object.keys(vector.keys).every((name) => name.startsWith("TEST-ONLY-"))).toBe(true);
  });

  for (const vector of kinds) {
    test(`kinds/${vector.name}`, async () => {
      for (const entry of vector.entries) {
        const read = entryFromText(entry.text);
        expect(entryHash(read.body)).toBe(entry.hash);
        const shown = Object.fromEntries(readFields(read.body).map((item) => [item.name, item.name === "sealed" ? toBase64Url(item.value) : Buffer.from(item.value).toString("latin1")]));
        expect(shown).toEqual({ ...entry.fields });
      }
      const replayed = await replayList(vector.entries.map((entry) => entry.text), vector.level, { saved: null });
      if ("stops" in vector.expect) {
        expect([replayed.stopped, replayed.member]).toEqual([vector.expect.stops as typeof replayed.stopped, null]);
        return;
      }
      expect(replayed.stopped).toBeNull();
      expect(replayed.took.slice(1).map((item) => said(item.outcome))).toEqual([...vector.expect.outcomes]);
      expect(replayed.member?.state).toEqual(vector.expect.state);
      expect(readListState(JSON.parse(JSON.stringify(vector.expect.state)), vector.level)).toEqual(vector.expect.state);
    });
  }

  interface CardVector { readonly name: string; readonly card: ListCard; readonly bytes?: string; readonly signature: string; readonly expect: { readonly holds: boolean } }
  for (const vector of load<CardVector>("card")) {
    test(`card/${vector.name}`, async () => {
      if (vector.bytes !== undefined) expect(toBase64Url(cardBytes(vector.card))).toBe(vector.bytes);
      expect(await cardHolds(vector.card, vector.signature)).toBe(vector.expect.holds);
    });
  }

  interface NamesVector { readonly name: string; readonly fields: readonly { readonly name: string; readonly value: string }[]; readonly expect: { readonly names: { readonly label: string; readonly os: string | null } | null; readonly written: boolean } }
  for (const vector of load<NamesVector>("names")) {
    test(`names/${vector.name}`, () => {
      const fields = vector.fields.map(({ name, value }) => ({ name, value: fromBase64Url(value) }));
      const names = readNames(fields);
      expect(names).toEqual(vector.expect.names as typeof names);
      // `written` says that these fields are the ones a writer writes for those names.
      if (names !== null) expect(JSON.stringify(namesFields(names).map(({ name, value }) => ({ name, value: toBase64Url(value) }))) === JSON.stringify(vector.fields)).toBe(vector.expect.written);
    });
  }
});

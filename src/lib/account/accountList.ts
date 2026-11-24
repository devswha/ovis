/**
 * This device and its account's signed list (docs/account-list.md, "On a device"): it keeps its own verified copy,
 * starts the list for an account that has nobody in it yet, and catches up on what the account service stores.
 *
 * The account service's answers are entries this device checks itself, or hints that only say what to read. Which
 * list is the account's is never the service's to say: this device follows a list only when entry 0 of that id is
 * a genesis of its account under its own account key, which nobody else can sign. A device that another member
 * lets in is given the list by that member, not here.
 *
 * Nothing in the app decides by this copy yet: My PCs and what opens by itself still go by the account service.
 * What the two differ in is recorded (listShadow.ts).
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import type { ListNames, ListRole, ListState } from "../../../shared/account-list.ts";
import { entryFromText, entryHash, isListHash, ListEntryError, type SignerPower } from "../../../shared/account-list-entry.ts";
import {
  followStep, heardHead, pcOfKey, pinList, readSave, shownDevices, shownPcs, standing, startRead, takePage, writeSave,
  type FollowerCopy, type FollowerSelf, type FollowRead, type FollowVerdict, type SaveRefusal, type Standing,
} from "../../../shared/account-list-follower.ts";
import { LIST_WRAP_TEXT_LENGTH } from "../../../shared/account-list-seal.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { makeGenesis, type Genesis } from "./listGenesis.ts";
import { deviceListKeys, type DeviceListKeys } from "./listKeys.ts";
import { namesAt, openEpochs, readWraps, wrapsRecord, type OpenedEpochs } from "./listNames.ts";
import type { ListHint, ListWrap } from "./listAnswers.ts";
import { indexedListStore, listLock, type ListLock, type ListStore } from "./listStore.ts";
import { keepShadow, shadowOf, type ShadowRecord } from "./listShadow.ts";
import { AccountRefreshError, AccountServiceError, AccountServiceUnreachableError, PC_ADD_FRESH_MS, SignedOutError, type AccountService, type DirectoryPc } from "./service.ts";
import type { AccountSession, AccountStore } from "./store.ts";

/**
 * What stands between this device's copy and an honest log, the worst first. Each is a state a screen can show; none
 * of them takes anybody out of the copy.
 *
 * - `fork`: two histories of the list, each signed by a member. It stays until a person resets this device's copy.
 * - `stuck`: the account service shows another history under what this device already holds.
 * - `other_list`: the account service names another list for the account than the one this device follows.
 * - `refused`: the log holds an entry that no member would take.
 * - `unsigned`: the log holds an entry that no member signed. The account service places none, so it wrote this one.
 * - `wrong_key`: the account service handed this device a key to the names that is not the list's.
 * - `needs_newer_client`: the list holds an entry this build cannot place.
 */
export type ListTrouble = "fork" | "stuck" | "other_list" | "refused" | "unsigned" | "wrong_key" | "needs_newer_client";

/**
 * Why this device does not start a list for an account that may have one and has none.
 *
 * - `not_new`: this sign-in was made more than nine minutes ago: an account that was in use is not given a list this way.
 * - `not_first_device`: the account service numbered this sign-in's key other than first, or not yet at all.
 * - `has_pcs`: the account lists a PC, or this device holds a pairing linked to the account.
 * - `not_own_sign_in`, `frozen`, `session_not_fresh`: the account service takes no list from this sign-in.
 * - `refused`: the account service refused the entry itself.
 * - `switched_off`: this page was told to start none.
 */
export type NoGenesis = "not_new" | "not_first_device" | "has_pcs" | "not_own_sign_in" | "frozen" | "session_not_fresh" | "refused" | "switched_off";

/** What a device that holds no copy is at. */
type Without =
  /** Not signed in, the account service keeps no list for this account, or it has not been reached yet. */
  | { readonly at: "off" }
  /** The account may have a list, has none, and this device starts none. */
  | { readonly at: "none"; readonly why: NoGenesis }
  /**
   * The account service names a list that this device does not follow, and it reads no more of it than entry 0.
   * - `not_mine`: entry 0 is that list's and is not this device's own: it is in no list until a member lets it in.
   * - `unread`: the account service did not show the entry 0 of the list it names. It is asked again.
   * - `needs_newer_client`: entry 0 is in a form this build cannot read.
   */
  | { readonly at: "not_in"; readonly list: string; readonly why: "not_mine" | "unread" | "needs_newer_client" };

export type AccountListStatus =
  | Without
  /** What this device saved does not read. It is kept as it is, and nothing takes its place by itself. */
  | { readonly at: "damaged"; readonly why: Exclude<SaveRefusal, "version"> }
  /** What this device saved was written by a later build of the app, which this one cannot read: it needs a newer app. Kept as it is. */
  | { readonly at: "newer_save" }
  /** `head`: the place of the last entry of the copy. `read_at`: when it last held all the account service showed, in seconds. */
  | { readonly at: "following"; readonly list: string; readonly standing: Standing; readonly head: number; readonly read_at: number | null; readonly trouble: ListTrouble | null };

/** A device of the account, as the verified list says. `name` is null where this device cannot open it. */
export interface ListedDevice {
  readonly key: string;
  readonly self: boolean;
  readonly power: SignerPower;
  readonly role: ListRole;
  readonly until: number | null;
  readonly carried: boolean;
  readonly name: ListNames | null;
}

/** A PC of the account, as the verified list says, by its relay key; `server_id` is the id that key gives. */
export interface ListedPc {
  readonly endpoint: string;
  readonly server_id: string;
  readonly how: "added" | "joined" | "carried";
  /** A person at it can allow a device. */
  readonly allows: boolean;
  readonly name: ListNames | null;
}

/**
 * The devices and PCs that are in, in the order they came in: none unless this device follows the list and is in it.
 * `reached`: the last round got the account service's answers; without them the view is what this device saved.
 */
export interface AccountListView {
  readonly account: string | null;
  readonly status: AccountListStatus;
  readonly reached: boolean;
  readonly devices: readonly ListedDevice[];
  readonly pcs: readonly ListedPc[];
}

export type GenesisMode = "first-device" | "always" | "never";

/**
 * The developer's switch: `localStorage["ovis-account-list-genesis"]` set to `always` starts a list for an account
 * that already has PCs or other devices (they are not carried into it), and `never` starts none.
 */
export const GENESIS_SWITCH = "ovis-account-list-genesis";

export function genesisSwitch(): GenesisMode {
  try {
    const set = globalThis.localStorage?.getItem(GENESIS_SWITCH);
    return set === "always" || set === "never" ? set : "first-device";
  } catch { return "first-device"; }
}

export interface AccountListOptions {
  readonly service: AccountService;
  readonly accountStore: AccountStore;
  readonly listStore?: ListStore;
  readonly lock?: ListLock;
  /** This device's clock, in ms. */
  readonly now?: () => number;
  /** This device's name and OS, which a genesis seals; null seals none. */
  readonly names?: () => ListNames | null;
  /** How many of the PCs this device saved are linked to the account. */
  readonly linkedPcs?: (account: string) => Promise<number>;
  readonly genesis?: () => GenesisMode;
}

/** A device asks again this often, in seconds, while the account has no list or it is in none. */
export const NO_LIST_SECONDS = 300;
/**
 * How long the account service's word that it keeps no list for an account stands, in seconds: the device asks no
 * more often than this, whatever page asks and however often the app starts.
 */
export const OFF_SECONDS = 24 * 60 * 60;
/**
 * How long a device waits, in seconds, after one, two, three and more rounds in a row that did not reach the account
 * service: a service that is away or has no such routes is not asked every five minutes for good.
 */
export const UNREACHED_SECONDS: readonly number[] = [300, 900, 3600, 6 * 3600];
/** The most pages one round reads: what is left waits for the next. */
const ROUND_PAGES_MAX = 128;
/** A round's requests end after this long: it holds the lock that another tab's round waits for. */
const ROUND_MS = 30_000;

const RECORD_VERSION = 1;
const OFF: AccountListView = { account: null, status: { at: "off" }, reached: true, devices: [], pcs: [] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A genesis this device signed and has not seen in its saved copy, with the key it was signed with. */
type PendingGenesis = Genesis & { readonly key: string };

/** The hash of an entry's text, or null for a text that is no entry. */
function hashOf(text: string | undefined): string | null {
  if (text === undefined) return null;
  try {
    return entryHash(entryFromText(text).body);
  } catch (error) {
    if (error instanceof ListEntryError) return null;
    throw error;
  }
}

/** When the account service said that it keeps no list for the account, in seconds, as this device kept it; null for no such record. */
function readOff(value: unknown): number | null {
  return isRecord(value) && value.v === RECORD_VERSION && typeof value.off_at === "number" && Number.isSafeInteger(value.off_at) && value.off_at >= 0 ? value.off_at : null;
}

function readPending(value: unknown, keys: DeviceListKeys): PendingGenesis | null {
  if (!isRecord(value) || value.v !== RECORD_VERSION) return null;
  const { key, enc, list, entry, wrap } = value;
  if (key !== keys.key || enc !== keys.enc.key || typeof list !== "string" || !isListHash(list) || typeof entry !== "string" || typeof wrap !== "string" || wrap.length !== LIST_WRAP_TEXT_LENGTH) return null;
  return hashOf(entry) === list ? { key, enc, list, entry, wrap } : null;
}

/** The account service's own refusal of a request, as against no answer or a refresh that failed. */
const refusalOf = (error: unknown): AccountServiceError | null => (error instanceof AccountServiceError && !(error instanceof AccountRefreshError) ? error : null);

/** The account service gave no answer this round can use: it is away, slow, refused, or sent something out of form. */
function unreached(error: unknown): boolean {
  return error instanceof AccountServiceError || error instanceof AccountServiceUnreachableError
    || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));
}

function troubleOf(verdict: FollowVerdict): ListTrouble | null {
  switch (verdict) {
    case "fork": return "fork";
    case "stuck": return "stuck";
    case "not_my_list": return "other_list";
    case "refused": return "refused";
    case "needs_newer_client": return "needs_newer_client";
    default: return null;
  }
}

const WORST: readonly ListTrouble[] = ["fork", "stuck", "other_list", "refused", "unsigned", "wrong_key", "needs_newer_client"];
const worst = (troubles: readonly (ListTrouble | null)[]): ListTrouble | null => WORST.find((trouble) => troubles.includes(trouble)) ?? null;

/**
 * Whether two copies of one list hold the same entries, stop and alarm: they then differ in nothing but when they were
 * last read in full. Each entry names the one before it by its hash, so the same last entry at the same place is
 * the same history, and the state is what the entries give.
 */
function sameHistory(a: FollowerCopy, b: FollowerCopy): boolean {
  return a.list === b.list && a.entries.length === b.entries.length && a.entries.at(-1) === b.entries.at(-1) && a.stop === b.stop
    && (a.state === null) === (b.state === null) && JSON.stringify(a.alarm) === JSON.stringify(b.alarm);
}

/** One account's list in this page's memory. */
interface Held {
  readonly account: string;
  readonly copy: FollowerCopy | null;
  /** The text the copy was saved as, by which this page sees that another page wrote since. */
  readonly saved: string | null;
  /** What the last read said is wrong: it stands until a read ends otherwise. */
  readonly trouble: ListTrouble | null;
  /** Where the device is while it holds no copy. */
  readonly without: Without;
}

/** The members of one saved copy with their names as far as they opened: they change only with the copy or with the wraps this device holds. */
interface Named {
  readonly saved: string | null;
  /** The current epoch's key opened: there is no wrap left to ask for. */
  readonly complete: boolean;
  readonly devices: readonly ListedDevice[];
  readonly pcs: readonly ListedPc[];
}

/** A round that reached the account service: what it may still ask with. */
interface Asking { readonly bound: AccountService; readonly signal: AbortSignal }

export interface AccountList {
  /**
   * One round for the sign-in stored now: reads what is saved, asks the account service, takes what it shows, saves,
   * and resolves to the view after it. Asked while a round is under way, it waits for that one and runs one more,
   * since the sign-in may have changed under it. An account service that is away, slow or lying is a state of the
   * view; only a sign-in that ended throws (SignedOutError).
   */
  sync(): Promise<AccountListView>;
  view(): AccountListView;
  /** Hears each view that differs from the one before. */
  subscribe(listener: (view: AccountListView) => void): () => void;
  /** Whether the PC with this relay key (64 hex) is in the list as this device holds it. */
  holdsPc(endpoint: string): boolean;
  /** The relay key of the PC that signs with this key, when that PC is in the list as this device holds it; null otherwise. */
  pcOfKey(key: string): string | null;
  /** When the next round is due, in ms by this device's clock, given whether the app is in front; null for not by the clock. */
  due(inFront: boolean): number | null;
  /**
   * Holds the view against the account service's directory, read for `account`, and keeps what they differ in
   * (listShadow.ts); null where there is nothing to compare. `opens`: the ids of the PCs the app would open by itself.
   */
  shadow(account: string, directory: readonly DirectoryPc[], opens?: ReadonlySet<string>): Promise<ShadowRecord | null>;
  /**
   * The sign-in ended, and the device is still a member with the key it has: forgets what opens the account's names
   * (the wraps, and a genesis that was not seen placed). The copy stays, so that a later sign-in takes up where this
   * one stood and no older log passes for the list. The wraps are asked for again then.
   */
  dropNames(account: string): Promise<void>;
  /** A person's reset, or the device left the account: forgets everything kept for the account. */
  forget(account: string): Promise<void>;
}

export function accountList(options: AccountListOptions): AccountList {
  const { service, accountStore } = options;
  const store = options.listStore ?? indexedListStore;
  const lock = options.lock ?? listLock;
  const now = options.now ?? Date.now;
  const seconds = (): number => Math.floor(now() / 1000);
  const listeners = new Set<(view: AccountListView) => void>();
  let held: Held | null = null;
  let named: Named | null = null;
  /** The account whose wraps, at the last time they were asked for, held a key that is not the list's. */
  let wrongKey: string | null = null;
  /** The copy the wraps were last asked for, and when: they are asked for again for another copy, or after NO_LIST_SECONDS. */
  let wrapsAsked: { readonly saved: string | null; readonly at: number } | null = null;
  let shown: AccountListView = OFF;
  let askedAt: number | null = null;
  /** Rounds in a row that did not reach the account service. */
  let misses = 0;
  /** When the account service last said that it keeps no list for the account in view, in seconds; null otherwise. */
  let offAt: number | null = null;
  let running: Promise<AccountListView> | null = null;
  /** The one round that follows the round under way, for whoever asked meanwhile: the sign-in may have changed under it. */
  let queued: Promise<AccountListView> | null = null;

  const publish = (view: AccountListView): AccountListView => {
    const same = JSON.stringify(view) === JSON.stringify(shown);
    shown = view;
    if (!same) for (const listener of listeners) listener(view);
    return view;
  };

  /** The saved copy as this page holds it: read again only when another page wrote since. */
  const load = async (account: string, keys: DeviceListKeys, saved: unknown): Promise<Held | SaveRefusal> => {
    const fresh: Held = { account, copy: null, saved: null, trouble: null, without: held?.account === account ? held.without : { at: "off" } };
    if (saved === undefined) return fresh;
    if (typeof saved !== "string") return "form";
    if (held !== null && held.account === account && held.saved === saved && held.copy !== null) return held;
    const read = await readSave(saved);
    if (!read.read) return read.why;
    // saved under another account key: this device has a new one since, and is another member
    if (read.copy.me.key !== keys.key || read.copy.me.endpoint !== null) {
      await store.drop(account);
      return fresh;
    }
    if (read.copy.account !== account) return "broken";
    // the entries gave another state than the one saved with them (another build's, as after an update): the copy is
    // written again as this build writes it, once
    const text = read.rebuilt ? writeSave(read.copy) : saved;
    if (read.rebuilt) {
      await store.set("copy", account, text);
      console.info("Ovis: the account's list was read again from its entries, and saved as this build saves it");
    }
    return { ...fresh, copy: read.copy, saved: text };
  };

  /** Saves a copy that changed in more than the time of its last full read, which a device has no use for after a reload. */
  const save = async (before: Held, copy: FollowerCopy): Promise<string> => {
    if (before.copy !== null && before.saved !== null && sameHistory(before.copy, copy)) return before.saved;
    const text = writeSave(copy);
    await store.set("copy", copy.account, text);
    return text;
  };

  const mayStart = async (bound: AccountService, session: AccountSession, signal: AbortSignal): Promise<NoGenesis | null> => {
    const mode = (options.genesis ?? genesisSwitch)();
    if (mode === "never") return "switched_off";
    if (mode === "first-device") {
      const age = session.signed_in_at === undefined ? Number.NaN : now() - session.signed_in_at;
      if (!(age >= 0 && age <= PC_ADD_FRESH_MS)) return "not_new";
      const kept = await accountStore.get("signin_key");
      if (kept === undefined || kept.account !== session.account || kept.sign_in_id !== session.sign_in_id || kept.no !== 1) return "not_first_device";
      if (await (options.linkedPcs?.(session.account) ?? Promise.resolve(0)) > 0) return "has_pcs";
    }
    if (!await bound.ownSignIn(signal)) return "not_own_sign_in";
    if (mode === "first-device" && (await bound.listPcs(signal)).length + (await bound.listUnconfirmedPcs(signal)).length > 0) return "has_pcs";
    return null;
  };

  /**
   * Starts the account's list. The genesis is kept before it is sent, and sent again as it is until this device's
   * saved copy holds it or the account turns out to have another list: a lost answer or a closed page makes no
   * second one.
   */
  const start = async (bound: AccountService, session: AccountSession, keys: DeviceListKeys, signal: AbortSignal): Promise<"placed" | "exists" | NoGenesis> => {
    const refused = await mayStart(bound, session, signal);
    if (refused !== null) return refused;
    let pending = readPending(await store.get("genesis", session.account), keys);
    if (pending === null) {
      pending = { key: keys.key, ...await makeGenesis({ account: session.account, keys, names: options.names?.() ?? null, now: now() }) };
      await store.set("genesis", session.account, { v: RECORD_VERSION, ...pending });
    }
    try {
      return await bound.startList(pending.list, pending.entry, { member: pending.enc, wrap: pending.wrap }, signal);
    } catch (error) {
      const said = refusalOf(error);
      if (said === null || said.status === 429 || said.status >= 500) throw error;
      if (said.status === 403 && said.code === "own_sign_in_required") return "not_own_sign_in";
      return said.status === 403 && (said.code === "frozen" || said.code === "session_not_fresh") ? said.code : "refused";
    }
  };

  /**
   * The epoch keys this device holds for the copy: from the wraps it kept, and while the current epoch's key is not
   * among them, from the wraps the account service holds for it. A wrap is kept only when it opens to the key the list
   * commits to; one that opens to another key is the account service's doing, and is said (`wrong_key`).
   */
  const epochsOf = async (copy: FollowerCopy, state: ListState, saved: string | null, keys: DeviceListKeys, ask: Asking | null): Promise<OpenedEpochs> => {
    const kept = readWraps(await store.get("wraps", copy.account), copy.list, keys.enc.key);
    const opened = await openEpochs(state, kept, keys.enc);
    if (opened.keys.has(state.epoch)) {
      if (wrongKey === copy.account) wrongKey = null;
      return opened;
    }
    const at = seconds();
    const due = wrapsAsked === null || wrapsAsked.saved !== saved || at < wrapsAsked.at || at - wrapsAsked.at >= NO_LIST_SECONDS;
    if (ask === null || !due) return opened;
    wrapsAsked = { saved, at };
    let shown: readonly ListWrap[];
    try {
      shown = await ask.bound.listWraps(copy.list, keys.enc.key, ask.signal);
    } catch (error) {
      // names wait for another round; who is in never waited for them
      if (!unreached(error)) throw error;
      return opened;
    }
    const tried = new Map(opened.good.map((epoch) => [epoch, kept.wraps.get(epoch) ?? ""]));
    for (const wrap of shown) if (!tried.has(wrap.epoch)) tried.set(wrap.epoch, wrap.wrap);
    const again = await openEpochs(state, { ...kept, wraps: tried }, keys.enc);
    wrongKey = again.wrong.length > 0 ? copy.account : wrongKey === copy.account ? null : wrongKey;
    if (again.good.length !== kept.wraps.size || again.good.some((epoch) => kept.wraps.get(epoch) !== tried.get(epoch))) {
      await store.set("wraps", copy.account, wrapsRecord({ ...kept, wraps: new Map(again.good.map((epoch) => [epoch, tried.get(epoch) ?? ""])) }));
    }
    return again;
  };

  const viewOf = async (next: Held, keys: DeviceListKeys, ask: Asking | null): Promise<AccountListView> => {
    const { copy, account } = next;
    const reached = ask !== null;
    if (copy === null || copy.state === null) return { account, status: next.without, reached, devices: [], pcs: [] };
    const { state } = copy;
    const stands = standing(copy);
    // the account service places only what a signer signed: an entry past the last one a signer signed is its own writing
    const unsigned = copy.entries.length - 1 > state.footing.seq && state.needs_replay === undefined;
    const follows = (): AccountListStatus => ({
      at: "following", list: copy.list, standing: stands, head: copy.entries.length - 1, read_at: copy.read_at,
      trouble: worst([copy.alarm === null ? null : "fork", next.trouble, unsigned ? "unsigned" : null, wrongKey === account ? "wrong_key" : null]),
    });
    if (stands !== "in") return { account, status: follows(), reached, devices: [], pcs: [] };
    if (named === null || named.saved !== next.saved || (!named.complete && ask !== null)) {
      const opened = await epochsOf(copy, state, next.saved, keys, ask);
      const nameAt = (seq: number): Promise<ListNames | null> => namesAt(copy.list, copy.entries, seq, opened.keys);
      const devices: ListedDevice[] = [];
      for (const row of shownDevices(copy)) {
        devices.push({ key: row.key, self: row.key === keys.key, power: row.power, role: row.role, until: row.until, carried: row.carried, name: await nameAt(row.seq) });
      }
      const pcs: ListedPc[] = [];
      for (const row of shownPcs(copy)) {
        pcs.push({ endpoint: row.endpoint, server_id: deriveServerId(hexToBytes(row.endpoint)), how: row.how, allows: row.allows, name: await nameAt(row.seq) });
      }
      named = { saved: next.saved, complete: opened.keys.has(state.epoch), devices, pcs };
    }
    return { account, status: follows(), reached, devices: named.devices, pcs: named.pcs };
  };

  /** Reads the log after the copy's own head until the read is over, at most ROUND_PAGES_MAX pages. */
  const read = async (bound: AccountService, from: FollowerCopy, signal: AbortSignal): Promise<{ copy: FollowerCopy; verdict: FollowVerdict }> => {
    let copy = from;
    let verdict: FollowVerdict = "withheld";
    let next: FollowRead | null = startRead(copy, "service");
    for (let pages = 0; next !== null && pages < ROUND_PAGES_MAX; pages += 1) {
      const page = await bound.listLog(copy.list, next.after, signal);
      const took = await takePage(copy, next, { list: page.list, after: page.after, entries: page.entries, head: page.head }, seconds());
      ({ copy, verdict } = took);
      next = took.read;
    }
    return { copy, verdict };
  };

  /** What a round does with the list the account service names (`named`: null for none); `loaded` is what this device saved. */
  const follow = async (bound: AccountService, session: AccountSession, keys: DeviceListKeys, loaded: Held, told: ListHint | null, signal: AbortSignal): Promise<Held> => {
    const { account } = session;
    let hint = told;
    let copy = loaded.copy;
    const fresh = copy === null;
    if (copy === null) {
      if (hint === null) {
        const started = await start(bound, session, keys, signal);
        if (started !== "placed" && started !== "exists") return { ...loaded, without: { at: "none", why: started } };
        const after = await bound.accountList(signal);
        if (after === "off" || after === null) throw new AccountServiceError(502, "invalid_answer", "The account service took a list and names none");
        hint = after;
      }
      // a list that is not this device's own is not read again while the account service names it
      if (loaded.without.at === "not_in" && loaded.without.why === "not_mine" && loaded.without.list === hint.list) return loaded;
      const me: FollowerSelf = { key: keys.key, endpoint: null };
      const pinned = pinList(null, { account, list: hint.list, me, pin: { how: "genesis" } });
      if (!pinned.pinned) throw new RangeError("This account or this device's key cannot follow a list");
      // only entry 0 says whether this device started the list; nothing else of it is asked for before that
      const first = startRead(pinned.copy, "service");
      const page = await bound.listLog(hint.list, first.after, signal, 1);
      const began = await takePage(pinned.copy, first, { list: page.list, after: page.after, entries: page.entries, head: page.head }, seconds());
      const pending = readPending(await store.get("genesis", account), keys);
      if (began.copy.state === null) {
        // not this device's own only when what was shown is that list's entry 0: anything else is the account service not showing it
        const shown = page.list === hint.list && hashOf(page.entries[0]) === hint.list;
        const why = !shown ? "unread" : began.verdict === "needs_newer_client" ? "needs_newer_client" : began.verdict === "not_my_list" ? "not_mine" : "unread";
        // the account has a list that is not the one this device signed: its own will never be the account's
        if (why === "not_mine" && pending !== null && pending.list !== hint.list) await store.set("genesis", account, undefined);
        return { ...loaded, without: { at: "not_in", list: hint.list, why } };
      }
      ({ copy } = began);
      if (pending !== null && pending.list === copy.list) await store.set("wraps", account, wrapsRecord({ list: copy.list, member: keys.enc.key, wraps: new Map([[0, pending.wrap]]) }));
    }

    // a device that follows a list starts no other over it, whatever the account service names
    const heard = heardHead(copy, hint === null ? null : { list: hint.list, place: hint.head }, seconds());
    ({ copy } = heard);
    let verdict: FollowVerdict = heard.verdict === "same" ? "caught_up" : "older";
    // The account service names another list, which the device says, or none, which is no hint at all (the follower's
    // rule). Either way the device reads its own list at its own pace: a removal must still reach it.
    const other = heard.verdict === "not_my_list";
    if (heard.verdict === "read") ({ copy, verdict } = await read(bound, copy, signal));
    else if (other || heard.verdict === "none") {
      try {
        ({ copy, verdict } = await read(bound, copy, signal));
      } catch (error) {
        if (!unreached(error)) throw error;
      }
    }
    const saved = await save(loaded, copy);
    // the genesis is in the saved copy now, and its wrap with the others: what was kept to send it again goes
    if (fresh) await store.set("genesis", account, undefined);
    return { account, copy, saved, trouble: worst([troubleOf(verdict), other ? "other_list" : null]), without: { at: "off" } };
  };

  const round = async (): Promise<AccountListView> => {
    const session = await service.session();
    // from here on a round counts as asked, whatever becomes of it: one that fails early is not begun again at once
    askedAt = seconds();
    if (session === undefined) {
      held = null;
      offAt = null;
      misses = 0;
      return publish(OFF);
    }
    const bound = service.forSignIn(session);
    const { account } = session;
    return lock(account, async () => {
      const signal = AbortSignal.timeout(ROUND_MS);
      const saved = await store.get("copy", account);
      const off = (at: number): AccountListView => {
        held = null;
        offAt = at;
        misses = 0;
        return publish({ account, status: { at: "off" }, reached: true, devices: [], pcs: [] });
      };
      // The account service said, less than a day ago, that it keeps no list for this account: it is not asked again
      // by this page or any other, however often the app starts. A device that follows a list asks all the same.
      const told = saved === undefined ? readOff(await store.get("asked", account)) : null;
      const at = seconds();
      if (told !== null && told <= at && at - told < OFF_SECONDS) return off(told);
      offAt = null;
      let hint: ListHint | null | "off" | undefined;
      try {
        hint = await bound.accountList(signal);
      } catch (error) {
        if (!unreached(error)) throw error;
      }
      // an account the service keeps no list for, on a device that follows none: no key is made, and one record is
      // kept, the time of that answer
      if (saved === undefined && hint === "off") {
        await store.set("asked", account, { v: RECORD_VERSION, off_at: at });
        return off(at);
      }
      if (saved === undefined && hint === undefined) {
        misses += 1;
        if (held?.account !== account) held = null;
        return publish({ account, status: held?.without ?? { at: "off" }, reached: false, devices: [], pcs: [] });
      }
      const keys = await deviceListKeys(accountStore);
      const loaded = await load(account, keys, saved);
      if (typeof loaded === "string") {
        held = null;
        return publish({ account, status: loaded === "version" ? { at: "newer_save" } : { at: "damaged", why: loaded }, reached: hint !== undefined, devices: [], pcs: [] });
      }
      let next = loaded;
      // for a device that follows a list, an account off the service's switch is the service being away, never "the list is gone"
      let reached = hint !== undefined && hint !== "off";
      if (hint !== undefined && hint !== "off") {
        try {
          next = await follow(bound, session, keys, loaded, hint, signal);
        } catch (error) {
          if (!unreached(error)) throw error;
          // what this device saved stands as it is
          reached = false;
        }
      }
      misses = reached ? 0 : misses + 1;
      held = next;
      return publish(await viewOf(next, keys, reached ? { bound, signal } : null));
    });
  };

  const sync = (): Promise<AccountListView> => {
    if (running !== null) {
      queued ??= running.then(() => undefined, () => undefined).then(() => {
        queued = null;
        return sync();
      });
      return queued;
    }
    running = round().catch((error: unknown) => {
      // the sign-in ended under the round: what it showed was that sign-in's
      if (error instanceof SignedOutError) {
        held = null;
        publish(OFF);
      }
      throw error;
    }).finally(() => { running = null; });
    return running;
  };

  return {
    sync,
    view: () => shown,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    holdsPc(endpoint) {
      return shown.pcs.some((pc) => pc.endpoint === endpoint);
    },
    pcOfKey(key) {
      const endpoint = held?.copy == null || held.account !== shown.account ? null : pcOfKey(held.copy, key);
      return endpoint !== null && shown.pcs.some((pc) => pc.endpoint === endpoint) ? endpoint : null;
    },
    due(inFront) {
      const { status } = shown;
      if (!inFront || shown.account === null || status.at === "damaged" || status.at === "newer_save") return null;
      // the account service keeps no list for the account: once a day
      if (offAt !== null) return (offAt + OFF_SECONDS) * 1000;
      // it was not reached: a longer wait after each round in a row that was not
      if (misses > 0) return ((askedAt ?? seconds()) + (UNREACHED_SECONDS[Math.min(misses, UNREACHED_SECONDS.length) - 1] ?? NO_LIST_SECONDS)) * 1000;
      if (status.at !== "following" || held?.copy == null) return ((askedAt ?? seconds()) + NO_LIST_SECONDS) * 1000;
      const step = followStep(held.copy, seconds(), { event: "tick", asked_at: askedAt, busy: true });
      return step.do === "read" ? now() : step.do === "wait" && step.until !== null ? step.until * 1000 : null;
    },
    async shadow(account, directory, opens) {
      const compared = shown.account === account ? shadowOf(shown, directory, now(), opens) : null;
      return compared === null ? null : keepShadow(store, account, compared);
    },
    async dropNames(account) {
      await lock(account, async () => {
        await store.set("wraps", account, undefined);
        await store.set("genesis", account, undefined);
      });
      if (wrongKey === account) wrongKey = null;
      named = null;
      wrapsAsked = null;
    },
    async forget(account) {
      await lock(account, () => store.drop(account));
      if (held?.account === account) held = null;
      if (wrongKey === account) wrongKey = null;
      named = null;
      wrapsAsked = null;
      if (shown.account === account) { offAt = null; misses = 0; publish(OFF); }
    },
  };
}

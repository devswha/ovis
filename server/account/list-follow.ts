/**
 * This PC following its account's signed list (docs/account-list.md, "Following a list"; docs/account.md, "The
 * account's signed list on a PC"). The rules of following are the follower's (shared/account-list-follower.ts): this
 * file holds what a PC adds to them, which is the disk, the clock, the account service's routes, and what the PC does
 * with what the list says.
 *
 * The copy lives in `account-list.json` in the state folder (0600), for one relay identity and one binding of the PC
 * to its account: a copy of another identity or binding is not this PC's and is not read. It holds no secret, and it
 * is only a copy: whether the PC is pinned, and to which list, is kept with the binding itself (account-pc.json), so
 * losing this file unpins nothing.
 *
 * A PC follows a list in one of two ways.
 *
 * - **Shadow.** It reads the list the account service names for its account, checks every entry itself, and says where
 *   the list would decide otherwise than the snapshot the PC lets devices in by. It lets nobody in and puts nobody out
 *   by it. The list id is the service's word here.
 * - **Pinned.** A person at this PC named the list (`want`), and that list holds an entry that adds this PC's own key
 *   at its own relay key. From then on the PC lets its account's devices in by the list alone, and the account
 *   service's word adds nobody and takes the PC out of nothing. The pin is one-way: it ends only with the binding it
 *   belongs to (Revoke all, a reset relay identity), or with an entry of the list that removes this PC.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { entryFromText, entryHash, isListHash, readBody } from "../../shared/account-list-entry.ts";
import type { ListPlace } from "../../shared/account-list-signers.ts";
import {
  admitsSession, admittedDevices, followStep, heardHead, nextUntil, pinList, readSave, shownPcs, standing, startRead, takePage, withClock, writeSave, PC_BUSY_READ_SECONDS,
  type FollowerCopy, type FollowRead, type FollowVerdict, type ListPage, type PeerAsk, type SessionRefusal, type Standing,
} from "../../shared/account-list-follower.ts";
import { listView, signCard, type ListRole } from "../../shared/account-list.ts";
import { accountDeviceId } from "../../shared/account-records.ts";
import type { SnapshotDevice, SnapshotRemoved } from "../../shared/account-snapshot.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { SERVER_ID_PATTERN } from "../../shared/relay-offer.ts";
import { logAccess } from "../connection-diagnostics.ts";
import { writePrivateState } from "../private-state.ts";
import { verifyRelayProof } from "../relay/auth-proof.ts";
import type { RelayIdentity } from "../relay/identity.ts";
import type { ListCommit } from "./account-device-state.ts";
import { ListKeysError, listKeysPath, type ListKeyStore, type PcListKeys } from "./list-keys.ts";
import { AccountServiceRefusal, type NamedList } from "./mailbox.ts";
import type { Readmission } from "./readmission.ts";

export const ACCOUNT_LIST_FILE = "account-list.json";
/** A post the account service did not confirm is made again after this long. */
const POST_RETRY_MS = 60_000;
/** A post of the PC's keys lasts ten minutes at the account service: an end named further off than this is no end it gave. */
const POST_UNTIL_MAX_SECONDS = 24 * 60 * 60;
/** The PC's post of its keys lasts ten minutes at the account service; it is made again when it is this old. */
export const LIST_POST_RENEW_MS = 4 * 60_000;
/** How often the PC looks at its clock for a read that is due and a device whose time has passed. */
export const LIST_TICK_MS = 5_000;
/** For this long after a person named a list here, the PC reads as often as with a session open. */
export const LIST_WANT_BUSY_MS = 15 * 60_000;
/** The clock a copy last showed is saved at least this often, in seconds, also when nothing else of the copy moved. */
export const LIST_CLOCK_SAVE_SECONDS = 60;
/** The most differences one start says: past it the list and the snapshot plainly are not of one account. */
export const DIFFERENCES_MAX = 1000;
/** The name of a device the list lets in, while this PC holds no key to the list's names. */
export const LIST_DEVICE_LABEL = "Device";

const BIND_ID = /^[0-9a-f]{32}$/;
const REFUSAL_CODE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * `account-list.json`. `save` is the follower's own text (writeSave), which carries its sum; null while a list is
 * named and nothing is read. `want` is the list a person at this PC named.
 */
interface ListFile {
  readonly v: 1;
  readonly server_id: string;
  readonly bind_id: string;
  readonly want: string | null;
  readonly save: string | null;
}

/**
 * What the snapshot path holds of a device, as the shadow compares it: `admitted` for one it lets in, `none` for one it
 * holds no row for. A row that one of the PC's own guards holds back for now (its join hold, a wait for a read) is
 * not compared: the list knows no such guard.
 */
export type SnapshotVerdict = "admitted" | "none";

export interface ListStatus {
  readonly account: string | null;
  /** The list this PC reads, or null for none. */
  readonly list: string | null;
  /** Whether the PC lets its account's devices in by this list, and by nothing the account service says. */
  readonly pinned: boolean;
  /** The list a person at this PC named for it, or null. */
  readonly want: string | null;
  /** Where the PC itself stands in the list: `waiting` until an entry adds it. */
  readonly standing: Standing | null;
  /** The last entry of the copy that a member signed. */
  readonly head: ListPlace | null;
  /** How many devices and PCs the copy holds as in. */
  readonly devices: number;
  readonly pcs: number;
  readonly alarm: "fork" | null;
  /** When the copy last held everything the account service showed. */
  readonly last_read_at: string | null;
  /** What came of the last word of the account service: the follower's verdict, `same` for a head that is the copy's own, `none` when it named no list. */
  readonly last_verdict: string | null;
  /** How many decisions of the snapshot the list would have made otherwise, since this start. */
  readonly differences: number;
  /** Whether the PC has its list keys: `unreadable` for a file that will not read. */
  readonly keys: "ready" | "unreadable" | null;
  /** Until when the account service holds this PC's keys for a member to add it, or null. */
  readonly posted_until: string | null;
  /** Why the copy or the service could not be used, in words that name no key. */
  readonly error: string | null;
}

export type WantRefusal = "invalid_list" | "not_in_account" | "pinned" | "removed" | "unavailable";

/** What the device store asks of the list (DeviceStore.attachList). Every answer is read from memory, with no wait. */
export interface ListAuthority {
  /** Whether this PC lets its account's devices in by its signed list. */
  pinned(): boolean;
  /** What a pinned PC's list lets the device with `key` in as now, null for one it does not let in; undefined on a PC that is not pinned. */
  role(key: string): ListRole | null | undefined;
  /** Whether this relay identity was removed from `account` by that account's list. */
  removedFrom(account: string): boolean;
}

export interface ListFollowDeps {
  readonly stateDir: string;
  readonly keys: ListKeyStore;
  identity(): RelayIdentity | undefined;
  /** The PC's standing binding to its account, or null. `list`: the list that binding is pinned to, or null. `alarmed`: that list raised an alarm under this binding. */
  binding(): { readonly account: string; readonly id: string; readonly list: string | null; readonly alarmed?: boolean } | null;
  /** Keeps with the binding `bindId`, on disk, that its list raised an alarm (PcAccountState.alarmList). False when it could not. */
  alarm?(bindId: string): boolean;
  /** Pins the binding `bindId` to `list`, on disk, for good (PcAccountState.pinToList). False when it could not. */
  pin(bindId: string, list: string): boolean;
  /** Whether the list of `account` removed this PC while it had the relay identity `serverId` (PcAccountState.removedByList). */
  removedFrom(account: string, serverId: string): boolean;
  /** A PC route of the list at the account service, with this PC's proof (AccountMailbox.listRoute). */
  call(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The key of the account row `id` that this PC holds, or null. */
  rowKey(id: string): string | null;
  /** The PC's clock, in milliseconds. */
  now(): number;
  /**
   * A pinned PC's account rows, from the list: the store drops what the list no longer lets in and admits what it newly
   * does. `first`: the commit that follows the pin itself, whose devices come in with no join hold.
   */
  commit?(list: ListCommit, readmission: Readmission | undefined, first: boolean): void;
  /**
   * The PC has just pinned its list: the sessions of the account rows it held until now end as rows that changed, not
   * as devices that were removed, so each app signs in again by itself, with the key the list holds for it.
   */
  repinned?(): void;
  /**
   * An entry of the list this PC is pinned to put the device `key` out. The PC keeps that as it keeps a member's signed
   * removal: every row of the key goes, the ones this PC paired itself included, and nothing the list or the account
   * service says later brings the key back. `id` names the entry, `at` is when it was signed, in seconds.
   */
  removed?(key: string, removal: { readonly id: string; readonly at: number }): void;
  /** The list this PC is pinned to removed it: the PC leaves its account, and keeps that it was removed as `serverId`. False when it could not, and is asked again. */
  leave?(serverId: string): boolean;
  /** What the list lets in changed for rows the PC holds (a device's time passed, an alarm rose): their sessions are looked at again. */
  recheck?(): void;
  /** Whether a session is open on this PC: it then reads more often. */
  busy?(): boolean;
}

const PC_STATES: ReadonlySet<string> = new Set<SessionRefusal>(["waiting", "stopped", "out"]);

/** `list`: the list the binding is pinned to, or null. */
interface Scope { readonly serverId: string; readonly bindId: string | null; readonly account: string | null; readonly list: string | null; readonly endpoint: string }
type Bound = Scope & { readonly bindId: string; readonly account: string };

export class ListFollow implements ListAuthority {
  private readonly path: string;
  /** The relay identity and the binding the fields after them belong to. */
  private serverId: string | null = null;
  private bindId: string | null = null;
  private want: string | null = null;
  private copy: FollowerCopy | null = null;
  /** Why the file on disk is no copy this PC can use, or null. A PC that is not pinned reads the list again and replaces it. */
  private broken: string | null = null;
  private ready: Promise<void> = Promise.resolve();
  private fileRead = false;

  private keysState: ListStatus["keys"] = null;
  private lastVerdict: string | null = null;
  private error: string | null = null;
  private postedAt: number | null = null;
  private postedUntil: number | null = null;
  /** When the last read of the log began, in seconds; also one that failed. */
  private askedAt: number | null = null;
  private reading: Promise<void> | null = null;
  /** The next second at which a device the list lets in stops being let in, or null. */
  private untilAt: number | null = null;
  /** The rows do not hold yet what the list says: the commit is tried again. */
  private dirty = false;
  /** The clock (`seen_at`) of the copy as it was last saved. */
  private savedAt: number | null = null;
  /** The copy in memory holds what the file does not: its last save failed. It is acted on all the same, and saved again at the next tick. */
  private unsaved = false;
  /** Fires at `untilAt`, whatever else the PC is doing. */
  private untilTimer: ReturnType<typeof setTimeout> | undefined;
  /** The removals of the list that this PC has kept as its own since this start, by the entry that made each. */
  private readonly applied = new Set<string>();
  /** When a person last named a list here, in milliseconds: for a while after it the PC reads often, as someone waits beside it. */
  private wantedAt: number | null = null;
  private readonly differences = new Set<string>();
  private readonly ids = new WeakMap<FollowerCopy, Map<string, string>>();
  private turn: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly deps: ListFollowDeps) { this.path = join(deps.stateDir, ACCOUNT_LIST_FILE); }

  /** Reads the saved copy and, on a pinned PC, gives its rows to the store; then looks at the clock every LIST_TICK_MS. */
  start(): void {
    if (this.timer || this.stopped) return;
    void this.enqueue(async () => {
      const scope = this.bound();
      if (scope === null) return;
      await this.ready;
      await this.ensureCopy(scope);
      this.settle();
    });
    this.timer = setInterval(() => this.tick(), LIST_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.untilTimer) clearTimeout(this.untilTimer);
    this.untilTimer = undefined;
  }

  /** Everything asked of the list so far has been done. */
  async settled(): Promise<void> {
    for (let turn: Promise<unknown> | null = null; turn !== this.turn;) { turn = this.turn; await turn; }
  }

  // What the device store asks: from memory, with no wait.

  pinned(): boolean { return this.sync() !== null && this.isPinned; }

  /** The binding's own word on the list it is pinned to: on disk with the binding, whatever becomes of the copy. */
  private get isPinned(): boolean {
    const binding = this.deps.binding();
    return binding !== null && binding.id === this.bindId && binding.list !== null;
  }

  /**
   * Why a pinned PC cannot use its copy: the file is there and does not read. It is never replaced by what the account
   * service shows now, which may be an older part of the list: the PC lets no device of its account in until a person
   * restores the file, or removes it and starts Ovis again, which reads the list from its start.
   */
  private get problem(): string | null {
    return this.isPinned && this.broken !== null ? `${this.broken}: this PC lets no device of its account in until the file is restored or removed, and Ovis is started again` : null;
  }

  role(key: string): ListRole | null | undefined {
    if (!this.pinned()) return undefined;
    const copy = this.clocked();
    if (copy === null || this.alarmLost) return null;
    const answer = admitsSession(copy, key, this.seconds());
    // refused for its time: the hour that says so is on disk before the answer is used, so no clock set back undoes it
    if (answer.why === "expired") this.saveFloor(copy.state?.devices[key]?.until ?? null);
    return answer.role;
  }

  /**
   * The binding keeps that its list raised an alarm, and the copy the PC holds now shows none: the copy was lost and
   * read again, and one history tells nothing of whom the alarm held back. The PC then lets nobody of its list in,
   * until a person unpins it at the PC.
   */
  private get alarmLost(): boolean {
    const binding = this.deps.binding();
    return binding !== null && binding.id === this.bindId && binding.list !== null && binding.alarmed === true && this.copy?.alarm == null;
  }

  /** The copy with the hour the PC's clock shows now (withClock), which it decides on: the hour never counts for less than it once showed. */
  private clocked(): FollowerCopy | null {
    if (this.copy === null) return null;
    const now = withClock(this.copy, this.seconds());
    if (now !== this.copy) { this.ids.delete(this.copy); this.copy = now; }
    return now;
  }

  /** Saves the copy's hour when what is on disk does not yet show that `until` has passed. Never throws. */
  private saveFloor(until: number | null): void {
    const scope = this.bound();
    if (scope === null || this.copy === null || this.copy.seen_at === null || until === null) return;
    if (this.savedAt !== null && this.savedAt >= until && this.savedAt >= 0) return;
    this.persist(scope);
  }

  removedFrom(account: string): boolean {
    const scope = this.sync();
    return scope !== null && this.deps.removedFrom(account, scope.serverId);
  }

  /** Whether the PC at the relay key `endpoint` is in the list this PC is pinned to. */
  holdsPc(endpoint: string): boolean {
    if (!this.pinned() || this.copy === null || this.alarmLost) return false;
    return shownPcs(this.copy).some((row) => row.endpoint === endpoint);
  }

  status(): ListStatus {
    const scope = this.sync();
    const copy = scope?.bindId == null ? null : this.copy;
    const view = copy?.state ? listView(copy.state) : null;
    // a post is spent by the entry that adds the PC: one that is in, or out, has none
    const posted = copy !== null && standing(copy) === "waiting" ? this.postedUntil : null;
    return {
      account: scope?.account ?? null,
      list: copy?.list ?? null,
      pinned: this.pinned(),
      want: scope?.bindId == null ? null : scope.list ?? this.want,
      standing: copy === null ? null : standing(copy),
      head: copy?.state ? { seq: copy.state.footing.seq, hash: copy.state.footing.hash } : null,
      devices: view?.devices.filter((row) => row.ended === null).length ?? 0,
      pcs: view?.pcs.filter((row) => row.removed === null).length ?? 0,
      alarm: copy?.alarm || (copy !== null && this.alarmLost) ? "fork" : null,
      last_read_at: copy?.read_at == null ? null : new Date(copy.read_at * 1000).toISOString(),
      last_verdict: this.lastVerdict,
      differences: this.differences.size,
      keys: this.keysState,
      posted_until: posted === null ? null : new Date(posted * 1000).toISOString(),
      error: this.problem ?? this.error,
    };
  }

  // What reaches the list from outside.

  /** What a mailbox pull's answer named as the account's list. Starts a read in turn and returns at once. */
  heard(account: string, named: NamedList | null, asked?: string | null): void {
    if (this.stopped) return;
    // `asked`: what scopeToken answered when the pull began. A hint for another binding or relay identity than the PC
    // has when its turn comes is dropped
    void this.enqueue(async () => {
      if (asked !== undefined && asked !== this.scopeToken()) return;
      await this.follow(account, named);
    });
  }

  /** The relay identity and binding the PC has now, as one word: what a mailbox pull keeps to say which PC its answer was for. Null for none. */
  scopeToken(): string | null {
    const scope = this.bound();
    return scope === null ? null : `${scope.serverId} ${scope.bindId}`;
  }

  /**
   * A person at this PC names the list of its account (the PC's own window and CLI alone): the one act that lets this
   * PC pin. Nothing is pinned by it yet: the PC pins once that list holds an entry that adds its own key at its own
   * relay key. Naming another list before that replaces the first; after it, nothing does.
   */
  wantList(list: string): Promise<{ readonly status: ListStatus } | { readonly refused: WantRefusal }> {
    return this.enqueue(async () => {
      if (typeof list !== "string" || !isListHash(list)) return { refused: "invalid_list" as const };
      const scope = this.bound();
      if (scope === null) return { refused: "not_in_account" as const };
      await this.ready;
      if (this.problem !== null) return { refused: "unavailable" as const };
      if (this.removedFrom(scope.account)) return { refused: "removed" as const };
      if (scope.list !== null) return scope.list === list ? { status: this.status() } : { refused: "pinned" as const };
      const keys = await this.keysOf(scope);
      if (keys === null) return { refused: "unavailable" as const };
      const before = { want: this.want, copy: this.copy, wantedAt: this.wantedAt, postedAt: this.postedAt, postedUntil: this.postedUntil };
      if (this.copy === null || this.copy.list !== list) {
        const first = pinList(null, { account: scope.account, list, me: { key: keys.key, endpoint: scope.endpoint }, pin: { how: "added" } });
        if (!first.pinned) return { refused: "invalid_list" as const };
        this.copy = first.copy;
        this.postedAt = this.postedUntil = null;
      }
      this.want = list;
      this.wantedAt = this.deps.now();
      if (!this.persist(scope)) {
        // a naming that was refused names nothing: what stood before it stands, in memory as on disk
        ({ want: this.want, copy: this.copy, wantedAt: this.wantedAt, postedAt: this.postedAt, postedUntil: this.postedUntil } = before);
        return { refused: "unavailable" as const };
      }
      this.settle();
      if (!this.isPinned) {
        await this.read(scope);
        if (this.live(scope) && this.copy !== null && standing(this.copy) === "waiting") await this.post(this.copy, keys, scope);
      }
      return { status: this.status() };
    });
  }

  /** The clock: a read that is due, a device whose time has passed, rows that still wait for what the list says. */
  tick(): void {
    if (this.stopped) return;
    const scope = this.bound();
    if (scope === null) return;
    // a file that could not be read is tried again: one that reads by now is taken
    if (this.broken !== null && this.copy === null) { this.broken = null; this.takeFile(scope); void this.enqueue(async () => { await this.ready; await this.ensureCopy(scope); this.settle(); }); }
    if (this.problem !== null) return;
    const now = this.seconds();
    // a copy the disk did not take is offered to it again
    if (this.unsaved) void this.enqueue(() => { const bound = this.bound(); if (bound !== null && this.unsaved && this.copy !== null) this.unsaved = !this.persist(bound); });
    if (this.isPinned && (this.dirty || (this.untilAt !== null && now >= this.untilAt))) void this.enqueue(async () => { await this.ready; this.settle(); });
    // any PC that holds a list reads it by its own clock, one that only shadows too: a mailbox that names no list, or
    // does not answer, hides no entry. A PC whose account never had a list holds no copy and asks nothing
    const copy = this.copy;
    if (copy === null) return;
    // a PC that was just named its list has a person waiting beside it for the entry that adds it
    const waited = this.wantedAt === null ? null : this.deps.now() - this.wantedAt;
    const busy = this.isPinned ? this.deps.busy?.() === true : waited !== null && waited >= 0 && waited < LIST_WANT_BUSY_MS;
    const step = followStep(copy, now, { event: "tick", asked_at: this.askedAt, busy });
    if (step.do === "read") void this.readNow();
    // a PC that waits to be added keeps its post alive by its own clock too, whatever the mailbox says
    if (standing(copy) === "waiting") void this.enqueue(async () => {
      const held = this.copy;
      if (held === null || standing(held) !== "waiting" || !this.live(scope)) return;
      const keys = await this.keysOf(scope);
      if (keys !== null && this.live(scope) && this.copy !== null && this.copy.me.key === keys.key && standing(this.copy) === "waiting") await this.post(this.copy, keys, scope);
    });
  }

  /**
   * Before a pinned PC lets a device open a session: when its last full read is too old, it reads now and the session
   * waits for that, a few seconds at most; then the PC decides on its copy as it is. A service that did not answer a
   * moment ago is not asked again for it.
   * `budgetMs`: how much of the sign-in's few seconds is left.
   */
  async beforeSession(budgetMs?: number): Promise<void> {
    if (!this.pinned()) return;
    await this.ready;
    const copy = this.copy;
    if (copy === null) return;
    const now = this.seconds();
    const step = followStep(copy, now, { event: "session", since: null });
    if (step.do !== "read_and_wait") return;
    if (this.reading === null && this.askedRecently(now)) return;
    // one wait a sign-in: what it already waited for the account service (`budgetMs` is what is left of it) is not waited again
    const read = this.readNow();
    const wait = Math.min((step.until - now) * 1000, budgetMs ?? Number.POSITIVE_INFINITY);
    if (wait > 0) await this.within(read, wait);
  }

  /**
   * A sign-in a pinned PC could not accept: a member may have let the device in a moment ago. The PC reads its list,
   * at most once in PC_BUSY_READ_SECONDS, and the sign-in waits `waitMs` for it at most. `readmission`: the proved
   * returning device that read may let in again.
   */
  async readForSignIn(waitMs: number, readmission?: Readmission): Promise<void> {
    if (!this.pinned()) return;
    await this.ready;
    if (this.copy === null) return;
    if (this.reading === null && this.askedRecently(this.seconds())) {
      if (readmission) await this.enqueue(() => { this.settle(readmission); });
      return;
    }
    await this.within(this.readNow().then(() => this.enqueue(() => { if (readmission) this.settle(readmission); })), waitMs);
  }

  /** What this PC asks another member for, so that member can hand it the entries it lacks; null while it follows no list a person named. */
  asks(): PeerAsk | null {
    const scope = this.bound();
    if (scope === null || this.copy === null || (!this.isPinned && this.want === null)) return null;
    const { list, after } = startRead(this.copy, "peer");
    return { list, after };
  }

  /**
   * A member's answer to `asks`, handed over directly: taken as the account service's pages are, since entries prove
   * themselves. So a removal the service withholds reaches this PC from any member that has it.
   */
  takeFromPeer(page: ListPage): Promise<FollowVerdict | "not_saved" | null> {
    return this.enqueue(async () => {
      const scope = this.bound();
      if (scope === null) return null;
      await this.ready;
      await this.ensureCopy(scope);
      const copy = this.copy;
      if (copy === null || this.problem !== null || (!this.isPinned && this.want === null)) return null;
      const result = await takePage(copy, startRead(copy, "peer"), page, this.seconds());
      if (!this.live(scope)) return null;
      // acted on at once; said as taken only once it is on disk
      return this.keep(result.copy, scope, changed(copy, result.copy)) ? result.verdict : "not_saved";
    });
  }

  /**
   * Shadow: a sign-in the snapshot path has just decided. The list's own answer for that device is compared and a
   * difference is said once. It decides nothing, waits for nothing and never throws.
   */
  shadowSignIn(given: { readonly deviceId: string; readonly nonce: Uint8Array; readonly signature: string; readonly serverId: string; readonly snapshot: SnapshotVerdict }): void {
    try {
      const copy = this.shadow();
      if (copy === null) return;
      const key = this.deps.rowKey(given.deviceId) ?? this.idsOf(copy).get(given.deviceId) ?? null;
      if (key === null) return;
      const list = this.shadowAnswer(copy, key);
      if (given.snapshot === "admitted") { this.compare(key, "admitted", list.role ?? list.why); return; }
      // No row here: the list alone would let it in only for the proof of its key
      if (list.role === null) return;
      const role = list.role;
      const scope = this.bound();
      // the proof is checked later: what it shows is said only of the binding the sign-in came under
      void this.enqueue(() => verifyRelayProof(key, given).then((proved) => { if (proved && scope !== null && this.live(scope) && this.shadow() !== null) this.compare(key, "none", role); }));
    } catch { /* a shadow never stands in the way of a sign-in */ }
  }

  /**
   * Shadow: the devices a whole snapshot read lets in, against the devices the list lets in. Compared in turn, after
   * whatever read of the list the same pull began, and never awaited by the snapshot read.
   */
  shadowSnapshot(eligible: readonly string[]): void {
    void this.enqueue(() => {
      const copy = this.shadow();
      if (copy === null) return;
      const named = new Set(eligible);
      for (const key of named) { const list = this.shadowAnswer(copy, key); this.compare(key, "admitted", list.role ?? list.why); }
      for (const key of this.idsOf(copy).values()) {
        if (named.has(key)) continue;
        const list = this.shadowAnswer(copy, key);
        if (list.role !== null) this.compare(key, "none", list.role);
      }
    });
  }

  private compare(key: string, snapshot: SnapshotVerdict, list: ListRole | SessionRefusal): void {
    // the snapshot's rows all drive: a device the list lets in to watch is a difference too
    if (snapshot === "admitted" && list === "drive") return;
    // where the PC itself is not in the list, that is one difference, not one for each device
    const id = PC_STATES.has(list) ? `${snapshot} ${list}` : `${key} ${snapshot} ${list}`;
    if (this.differences.has(id) || this.differences.size >= DIFFERENCES_MAX) return;
    this.differences.add(id);
    // A key that only one of the two holds may be the same phone under its other key: the snapshot names a phone by
    // the key of its sign-in, the list by its member key, and nothing here links the two. So that is a difference of
    // credentials. A key both hold, decided otherwise, and the PC's own place in the list, are differences of devices
    const of = (snapshot === "admitted" && list === "never_added") || snapshot === "none" ? "credential" : "device";
    logAccess({ event: "account.list.differs", snapshot, list, of });
  }

  /** The copy a PC that is not pinned compares its snapshot with; null on a pinned PC, which decides by the list. */
  private shadow(): FollowerCopy | null {
    return this.bound() === null || this.isPinned ? null : this.clocked();
  }

  /** The list's answer for `key` on the copy a shadow compares with; an answer that turned on the hour saves that hour first. */
  private shadowAnswer(copy: FollowerCopy, key: string): ReturnType<typeof admitsSession> {
    const answer = admitsSession(copy, key, this.seconds());
    if (answer.why === "expired") this.saveFloor(copy.state?.devices[key]?.until ?? null);
    return answer;
  }

  /** One thing at a time, in the order asked. What it throws is said in the status and goes no further. */
  private enqueue<T>(run: () => T | Promise<T>): Promise<T> {
    const next = this.turn.then(run, run);
    this.turn = next.catch((error: unknown) => { this.error = this.words(error); });
    return next;
  }

  private within(work: Promise<unknown>, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      void work.then(() => undefined, () => undefined).then(() => { clearTimeout(timer); resolve(); });
    });
  }

  private askedRecently(now: number): boolean {
    return this.askedAt !== null && now - this.askedAt >= 0 && now - this.askedAt < PC_BUSY_READ_SECONDS;
  }

  private seconds(): number { return Math.floor(this.deps.now() / 1000); }

  private words(error: unknown): string {
    // a code is said only in the form the service's own codes have: nothing longer, and nothing that could be a key
    if (error instanceof AccountServiceRefusal) return `The account service answered ${error.status}${error.code !== null && REFUSAL_CODE.test(error.code) ? ` ${error.code}` : ""} to ${error.path}`;
    if (error instanceof ListKeysError) return error.message;
    return error instanceof Error ? error.name : "The list could not be followed";
  }

  private idsOf(copy: FollowerCopy): Map<string, string> {
    let ids = this.ids.get(copy);
    if (!ids) {
      ids = new Map((copy.state ? listView(copy.state).devices : []).map((row) => [accountDeviceId(this.serverId ?? "", row.key), row.key]));
      this.ids.set(copy, ids);
    }
    return ids;
  }

  /**
   * The relay identity and binding the PC has now, with what this class holds brought in line with them, at once: the
   * file is read the first time, and a binding or identity that changed since ends what belonged to the one before.
   * Null for a PC with no relay identity.
   */
  private sync(): Scope | null {
    let identity: RelayIdentity | undefined;
    try { identity = this.deps.identity(); } catch { return null; }
    if (!identity) return null;
    const binding = this.deps.binding();
    if (this.endpointOf?.key !== identity.public_key) this.endpointOf = { key: identity.public_key, endpoint: bytesToHex(importPublicKey(identity.public_key)) };
    const scope: Scope = { serverId: identity.server_id, bindId: binding?.id ?? null, account: binding?.account ?? null, list: binding?.list ?? null, endpoint: this.endpointOf.endpoint };
    if (!this.fileRead) {
      this.fileRead = true;
      this.serverId = scope.serverId;
      this.bindId = scope.bindId;
      this.takeFile(scope);
      return scope;
    }
    if (scope.serverId !== this.serverId) {
      // a reset relay identity is a new PC: nothing of the one before counts, and its file went with it
      this.serverId = scope.serverId;
      this.broken = null;
      this.endBinding(scope.bindId);
    } else if (scope.bindId !== this.bindId) this.endBinding(scope.bindId);
    return scope;
  }

  private bound(): Bound | null {
    const scope = this.sync();
    return scope !== null && scope.bindId !== null && scope.account !== null ? scope as Bound : null;
  }

  /** Whether `scope` is still the identity and binding the PC has: what was asked for another is dropped. */
  private live(scope: Bound): boolean {
    const now = this.sync();
    return !this.stopped && now !== null && now.serverId === scope.serverId && now.bindId === scope.bindId;
  }

  /** The binding the copy belonged to is gone (Revoke all, a reset relay identity, a removal): so is the pin. */
  private endBinding(bindId: string | null): void {
    this.bindId = bindId;
    this.want = null;
    this.copy = null;
    this.ready = Promise.resolve();
    this.differences.clear();
    this.lastVerdict = this.error = null;
    this.keysState = null;
    this.postedAt = this.postedUntil = this.askedAt = this.untilAt = this.wantedAt = this.savedAt = null;
    this.dirty = false;
  }

  private endpointOf: { readonly key: string; readonly endpoint: string } | null = null;

  /** The file as it is on disk at the start. One that does not read is kept and said: what becomes of it depends on whether the PC is pinned. */
  private takeFile(scope: Scope): void {
    let text: string;
    try { text = readFileSync(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.broken = `${ACCOUNT_LIST_FILE} cannot be read`;
      return;
    }
    const file = parseFile(text);
    if (file === null) { this.broken = `${ACCOUNT_LIST_FILE} cannot be read`; return; }
    // another relay identity's or binding's copy is not this PC's: the next save replaces it
    if (file.server_id !== scope.serverId || file.bind_id !== scope.bindId) return;
    this.want = file.want;
    const save = file.save;
    if (save === null) return;
    const mine = () => this.bindId === file.bind_id && this.serverId === file.server_id;
    this.ready = readSave(save).then((saved) => {
      if (!mine()) return;
      if (!saved.read) { this.broken = `${ACCOUNT_LIST_FILE} cannot be read (${saved.why})`; return; }
      // a copy of another list than the one the PC is pinned to is no copy of its list
      if (scope.list !== null && saved.copy.list !== scope.list) return;
      this.copy = saved.copy;
      // another build wrote it: its entries were replayed, never dropped, and the copy is written back as this build
      // writes it. An update costs a pinned PC nothing it held
      if (saved.rebuilt && scope.bindId !== null && scope.account !== null) {
        console.info(`[account] ${ACCOUNT_LIST_FILE} was written by another build: its entries were read again`);
        this.persist(scope as Bound);
      }
    }, () => { if (mine()) this.broken = `${ACCOUNT_LIST_FILE} cannot be read`; });
  }

  /**
   * A pinned PC that holds no copy (its file is gone) starts one of the list it is pinned to, to be read again from
   * entry 0. Until that read shows the PC in the list, it lets no device of its account in.
   */
  private async ensureCopy(scope: Bound): Promise<void> {
    if (scope.list === null || this.problem !== null || this.copy?.list === scope.list) return;
    const keys = await this.keysOf(scope);
    if (keys === null || !this.live(scope)) return;
    const first = pinList(null, { account: scope.account, list: scope.list, me: { key: keys.key, endpoint: scope.endpoint }, pin: { how: "added" } });
    if (first.pinned) this.copy = first.copy;
  }

  private async keysOf(scope: Scope): Promise<PcListKeys | null> {
    try {
      const keys = await this.deps.keys.keysFor(scope.serverId);
      this.keysState = "ready";
      return keys;
    } catch (error) {
      if (!(error instanceof ListKeysError)) throw error;
      this.keysState = "unreadable";
      this.error = error.message;
      return null;
    }
  }

  private async follow(account: string, named: NamedList | null): Promise<void> {
    const scope = this.bound();
    if (this.stopped || scope === null || scope.account !== account) return;
    await this.ready;
    if (this.problem !== null) return;
    await this.ensureCopy(scope);
    this.error = null;
    // an account with no list, one the service names no list for, and a service that is away all leave a copy as it
    // is: no hint is never the word that the list is gone
    if (named === null) {
      this.lastVerdict = "none";
      if (this.copy === null) return;
      this.keep(heardHead(this.copy, null, this.seconds()).copy, scope, false);
      // a PC that holds a list still reads it, at its own pace: no word is not the word that nothing was written
      if (this.copy !== null && followStep(this.copy, this.seconds(), { event: "tick", asked_at: this.askedAt, busy: false }).do === "read") await this.read(scope);
      return;
    }
    const keys = await this.keysOf(scope);
    if (keys === null || !this.live(scope)) return;
    let copy = this.copy;
    // a copy of other keys than the PC has now, on a PC that is not pinned, is nobody's
    if (copy !== null && !this.isPinned && (copy.me.key !== keys.key || copy.me.endpoint !== scope.endpoint)) copy = null;
    // a list id the service named, of which the PC has verified no entry, is its word alone: the one it names now
    // takes its place. A list a person named here is not the service's to replace
    if (copy !== null && !this.isPinned && this.want === null && copy.state === null && copy.list !== named.id) copy = null;
    if (copy === null) {
      if (this.isPinned) return;
      // the list a person named here, and only for want of one the list the service names
      const first = pinList(null, { account, list: this.want ?? named.id, me: { key: keys.key, endpoint: scope.endpoint }, pin: { how: "added" } });
      if (!first.pinned) { this.lastVerdict = "not_my_list"; return; }
      copy = first.copy;
    }
    const heard = heardHead(copy, { list: named.id, head: named.head }, this.seconds());
    this.lastVerdict = heard.verdict;
    this.keep(heard.copy, scope, false);
    // each pull, a pinned PC gives its rows another turn: one a full notice list or a hold kept out comes in then
    if (this.isPinned) this.settle();
    // a list a person named is read whatever list the service names
    if (heard.verdict === "read" || (heard.verdict === "not_my_list" && (this.isPinned || this.want !== null))) await this.read(scope);
    if (this.live(scope) && this.copy !== null && standing(this.copy) === "waiting") await this.post(this.copy, keys, scope);
  }

  /** One read at a time: whoever asks while one runs waits for that one. */
  private readNow(): Promise<void> {
    this.reading ??= this.enqueue(async () => {
      const scope = this.bound();
      if (scope === null) return;
      await this.ready;
      await this.ensureCopy(scope);
      if (this.problem === null && this.copy !== null) await this.read(scope);
    }).then(() => undefined, () => undefined).finally(() => { this.reading = null; });
    return this.reading;
  }

  /** One read of the log, page after page, until the follower asks for no more. The copy is saved once, when it changed. */
  private async read(scope: Bound): Promise<void> {
    let copy = this.copy;
    if (copy === null) return;
    const before = copy;
    this.askedAt = this.seconds();
    // the follower bounds a read by itself (FollowRead.left): what is left is asked at the next one
    let read: FollowRead | null = startRead(copy, "service");
    try {
      while (read !== null && this.live(scope)) {
        const answer = await this.deps.call("/v2/pc/list/log", { list: read.list, ...(read.after === null ? {} : { after: read.after }) });
        const result = await takePage(copy, read, answer as unknown as ListPage, this.seconds());
        copy = result.copy;
        this.lastVerdict = result.code === null ? result.verdict : `${result.verdict} ${result.code}`;
        read = result.read;
      }
    } catch (error) {
      // a service that is away, or that serves this PC no list, is no word on the list: the copy stays as it is
      this.error = this.words(error);
    } finally {
      // the copy the read began on, whatever hour its clock was moved to meanwhile
      if (this.live(scope) && this.copy !== null && !changed(before, this.copy)) this.keep(copy, scope, changed(before, copy));
    }
  }

  /** The second lock for a `pc` entry: this PC's keys and its card for this list, at the account service, for ten minutes. */
  private async post(copy: FollowerCopy, keys: PcListKeys, scope: Scope): Promise<void> {
    const now = this.deps.now();
    if (this.postedAt !== null && now - this.postedAt >= 0 && now - this.postedAt < LIST_POST_RENEW_MS) return;
    try {
      const card = await signCard({ key: keys.key, enc: keys.enc, list: copy.list, endpoint: scope.endpoint, invite: null }, keys.privateKey);
      // nothing is posted for an account the PC has left meanwhile, or once it stopped
      const still = this.sync();
      if (this.stopped || still === null || still.serverId !== scope.serverId || still.bindId !== scope.bindId) return;
      const answer = await this.deps.call("/v2/pc/list/keys", { list: copy.list, key: keys.key, enc: keys.enc, card });
      const { until } = answer;
      const ends = typeof until === "number" && Number.isSafeInteger(until) && until > this.seconds() && until - this.seconds() <= POST_UNTIL_MAX_SECONDS;
      this.postedUntil = ends ? until : null;
      // an answer that names no end ahead is no post the PC can count on: it is made again in a minute, not in four
      this.postedAt = ends ? now : now - LIST_POST_RENEW_MS + POST_RETRY_MS;
      if (!ends) this.error = "The account service did not say until when it holds this PC's keys";
    } catch (error) {
      this.postedUntil = null;
      this.error = this.words(error);
    }
  }

  /** Takes a copy as this PC's own: on disk first when it changed, then in memory, then what follows from it. */
  private keep(copy: FollowerCopy, scope: Bound, save: boolean): boolean {
    // the hour never goes back: a copy made from an older one keeps the latest hour this PC's clock showed
    const seen = this.copy?.list === copy.list ? this.copy.seen_at : null;
    this.copy = seen === null ? copy : withClock(copy, seen);
    if (save) {
      // What a member signed is acted on whether or not the disk takes it: a removal is enforced from memory, and the
      // copy is offered to the disk again at the next tick. A restart before that reads the list again before a session
      this.unsaved = !this.persist(scope);
      this.settle();
      return !this.unsaved;
    }
    // the latest hour the clock showed is kept too, so a clock set back over a restart lets no device in past its time
    if (copy.seen_at !== null && (this.savedAt === null || copy.seen_at - this.savedAt >= LIST_CLOCK_SAVE_SECONDS)) this.persist(scope);
    return true;
  }

  private persist(scope: Bound): boolean {
    const file: ListFile = { v: 1, server_id: scope.serverId, bind_id: scope.bindId, want: this.want, save: this.copy === null ? null : writeSave(this.copy) };
    try { writePrivateState(this.path, file); } catch (error) {
      this.error = `${ACCOUNT_LIST_FILE} could not be written (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
      return false;
    }
    this.broken = null;
    this.savedAt = this.copy?.seen_at ?? null;
    return true;
  }

  /**
   * What follows from the copy as it is now. A PC that a person named this list for pins it once the list holds the
   * PC. A pinned PC gives its rows to the store, and leaves its account when the list removed it. Never throws.
   */
  private settle(readmission?: Readmission): void {
    const scope = this.bound();
    const copy = this.copy;
    // a pinned PC acts on a copy of the list it is pinned to, and on no other
    if (scope === null || copy === null || this.problem !== null || (scope.list !== null && copy.list !== scope.list)) return;
    let pinning = false;
    if (!this.isPinned) {
      if (this.want !== copy.list || standing(copy) !== "in") return;
      // with the binding, on disk, before anything is done by it: from here on the PC is pinned whatever fails next
      try { if (!this.deps.pin(scope.bindId, copy.list)) return; } catch (error) {
        this.error = `The list could not be pinned (${error instanceof Error ? error.message : String(error)})`;
        return;
      }
      logAccess({ event: "account.list.pinned" });
      pinning = true;
      try { this.deps.repinned?.(); } catch { /* the commit below ends what is left of them */ }
    }
    // an alarm is kept with the pin, on disk: a copy that is lost and read again must not lift it
    if (copy.alarm !== null && this.deps.binding()?.alarmed !== true) {
      try { if (this.deps.alarm?.(scope.bindId) === false) this.dirty = true; } catch { this.dirty = true; }
    }
    const now = this.seconds();
    // a device's time has passed: the hour that says so is on disk before anything is done by it
    if (this.untilAt !== null && now >= this.untilAt) { this.clocked(); this.saveFloor(this.untilAt); }
    if (standing(copy) === "out") {
      // what the list put out before it put this PC out goes first: leaving keeps the pairings this PC made itself,
      // and a device the list removed must not stay in by one of them
      try { this.keepRemovals(copy); } catch (error) {
        this.dirty = true;
        this.error = `The list's removals could not be kept (${error instanceof Error ? error.message : String(error)})`;
        return;
      }
      this.leave(scope);
      return;
    }
    try {
      // what the list put out first, so that nothing the commit lets in stands beside a key that is out
      this.keepRemovals(copy);
      const rows = listCommit(copy, now);
      this.deps.commit?.(this.alarmLost ? { ...rows, devices: rows.devices.map((row) => ({ ...row, eligible: false })) } : rows, readmission, pinning);
      this.dirty = false;
    } catch (error) {
      this.dirty = true;
      this.error = `The list's devices could not be written (${error instanceof Error ? error.message : String(error)})`;
    }
    this.untilAt = nextUntil(copy, now);
    this.armUntil(now);
    try { this.deps.recheck?.(); } catch { /* the rows say it again at their next use */ }
  }

  /**
   * A timer for the next second at which a device the list lets in stops being let in. It runs by itself: a session
   * open at that second closes then, not at the next tick and not behind a read of the account service.
   */
  private armUntil(now: number): void {
    if (this.untilTimer) clearTimeout(this.untilTimer);
    this.untilTimer = undefined;
    if (this.untilAt === null || this.stopped) return;
    // by the PC's own clock in milliseconds, to the start of that second; a timer cannot wait longer than 2^31-1 ms
    const wait = Math.min(Math.max(0, this.untilAt * 1000 - this.deps.now()), 2 ** 31 - 1);
    this.untilTimer = setTimeout(() => {
      this.untilTimer = undefined;
      if (this.stopped || !this.pinned()) return;
      if (this.untilAt !== null && this.seconds() >= this.untilAt) this.settle();
      else this.armUntil(this.seconds());
    }, wait);
    this.untilTimer.unref?.();
  }

  /** Every device the list put out is kept as removed by this PC itself, once a start; one that could not be kept is tried again. */
  private keepRemovals(copy: FollowerCopy): void {
    if (copy.state === null || this.deps.removed === undefined) return;
    for (const row of listView(copy.state).devices) {
      const text = row.ended === null ? undefined : copy.entries[row.ended];
      if (text === undefined) continue;
      const entry = entryFromText(text);
      const id = entryHash(entry.body);
      if (this.applied.has(id + row.key)) continue;
      this.deps.removed(row.key, { id, at: readBody(entry.body).issued_at });
      this.applied.add(id + row.key);
    }
  }

  /** The list removed this PC: it leaves its account, and the PC's account state keeps that it was removed, so it joins that account again on no path. */
  private leave(scope: Bound): void {
    try {
      this.dirty = this.deps.leave?.(scope.serverId) === false;
      if (!this.dirty) logAccess({ event: "account.list.removed" });
    } catch (error) {
      this.dirty = true;
      this.error = `This PC could not leave its account (${error instanceof Error ? error.message : String(error)})`;
    }
  }
}

function changed(before: FollowerCopy, after: FollowerCopy): boolean {
  return after.entries !== before.entries || after.state !== before.state || after.alarm !== before.alarm || after.stop !== before.stop;
}

/**
 * What a pinned PC's account rows are made from: every device the list lets in now, and every device it put out. A
 * device's place is that of the entry that let it in, so an older device is one the list let in before.
 */
export function listCommit(copy: FollowerCopy, now: number): ListCommit {
  const state = copy.state;
  const devices: SnapshotDevice[] = [];
  const removed: SnapshotRemoved[] = [];
  const admitted = new Set(admittedDevices(copy, now).map((device) => device.key));
  for (const row of state === null ? [] : listView(state).devices) {
    const no = row.seq + 1;
    if (row.ended !== null) removed.push({ key: row.key, no });
    else devices.push({ key: row.key, no, eligible: admitted.has(row.key), label: LIST_DEVICE_LABEL });
  }
  return { account: copy.account, snapshot: copy.list.slice(0, 32), version: (state?.footing.seq ?? 0) + 1, devices, removed };
}

/**
 * One of this PC's two state folders takes a pin from the other (PcAccountState.takeSibling): what the pin is good for
 * comes first. The list knows this PC by the keys in the pinned folder, so those replace whatever keys this folder
 * made; the copy of the list comes too when there is one. Null when both are here, else why not: the folder then
 * takes no pin and fails closed, since a PC pinned to a list by keys it does not hold would let none of its devices in.
 */
export function bringSiblingList(stateDir: string, siblingDir: string, pin: { readonly bind_id: string; readonly list: string }): string | null {
  const from = listKeysPath(siblingDir);
  const to = listKeysPath(stateDir);
  const failed = (path: string, error: unknown) =>
    `This PC is pinned to a signed list in ${siblingDir}, and ${path} could not be brought beside it (${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : "unknown error")})`;
  let keys: unknown;
  try { keys = JSON.parse(readFileSync(from, "utf8")); } catch (error) { return failed(from, error); }
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) return failed(from, new Error("it holds no keys"));
  const copyFrom = join(siblingDir, ACCOUNT_LIST_FILE);
  let copy: ListFile | null = null;
  try {
    copy = parseFile(readFileSync(copyFrom, "utf8"));
    // a copy of another binding is not the pinned one's
    if (copy !== null && copy.bind_id !== pin.bind_id) copy = null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return failed(copyFrom, error);
  }
  try {
    writePrivateState(to, keys);
    if (copy !== null) writePrivateState(join(stateDir, ACCOUNT_LIST_FILE), copy);
  } catch (error) { return failed(to, error); }
  return null;
}

/** Removes the file: a reset relay identity is a new PC, which follows no list yet. Never throws. */
export function forgetList(stateDir: string): void {
  try { rmSync(join(stateDir, ACCOUNT_LIST_FILE), { force: true }); }
  catch (error) { console.error(`[account] ${ACCOUNT_LIST_FILE} could not be removed: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`); }
}

function parseFile(text: string): ListFile | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { v, server_id, bind_id, save, want = null, ...rest } = value as Record<string, unknown>;
  if (v !== 1 || Object.keys(rest).length > 0 || typeof server_id !== "string" || !SERVER_ID_PATTERN.test(server_id) || typeof bind_id !== "string" || !BIND_ID.test(bind_id)
    || !(save === null || typeof save === "string") || !(want === null || (typeof want === "string" && isListHash(want)))) return null;
  return { v: 1, server_id, bind_id, want, save };
}

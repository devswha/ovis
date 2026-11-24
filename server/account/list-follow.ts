/**
 * This PC following its account's signed list (docs/account-list.md, "Following a list"; docs/account.md, "The
 * account's signed list on a PC"). The rules of following are the follower's (shared/account-list-follower.ts): this
 * file holds what a PC adds to them, which is the disk, the clock and the account service's routes.
 *
 * The copy lives in `account-list.json` in the state folder (0600), for one relay identity and one binding of the PC
 * to its account: a copy of another identity or binding is not this PC's and is not read. It holds no secret.
 *
 * In this release the PC only shadows: it reads the list the account service names for its account, checks every
 * entry itself, and says where the list would decide otherwise than the snapshot the PC lets devices in by. It lets
 * nobody in and puts nobody out by it. The list id is the service's word here, which is why such a copy is only a
 * shadow: a PC lets devices in by a list only once it pins one by its own evidence.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ListPlace } from "../../shared/account-list-signers.ts";
import {
  admitsSession, heardHead, pinList, readSave, standing, startRead, takePage, writeSave,
  type FollowerCopy, type FollowRead, type ListPage, type SessionRefusal, type Standing,
} from "../../shared/account-list-follower.ts";
import { listView, signCard, type ListRole } from "../../shared/account-list.ts";
import { accountDeviceId } from "../../shared/account-records.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { SERVER_ID_PATTERN } from "../../shared/relay-offer.ts";
import { logAccess } from "../connection-diagnostics.ts";
import { writePrivateState } from "../private-state.ts";
import { verifyRelayProof } from "../relay/auth-proof.ts";
import type { RelayIdentity } from "../relay/identity.ts";
import { ListKeysError, type ListKeyStore, type PcListKeys } from "./list-keys.ts";
import { AccountServiceRefusal, type NamedList } from "./mailbox.ts";

export const ACCOUNT_LIST_FILE = "account-list.json";
/** The most pages one read asks for: a log holds at most 20480 entries, 256 a page, and a read goes back once. */
export const LIST_READ_PAGES_MAX = 200;
/** The PC's post of its keys lasts ten minutes at the account service; it is made again when it is this old. */
export const LIST_POST_RENEW_MS = 4 * 60_000;

/** The most differences one start says: past it the list and the snapshot plainly are not of one account. */
export const DIFFERENCES_MAX = 1000;

const BIND_ID = /^[0-9a-f]{32}$/;

/** `account-list.json`: `save` is the follower's own text (writeSave), which carries its sum. */
interface ListFile {
  readonly v: 1;
  readonly server_id: string;
  readonly bind_id: string;
  readonly save: string;
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
  /** Whether the PC lets devices in by this list. Never in this release. */
  readonly pinned: boolean;
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

export interface ListFollowDeps {
  readonly stateDir: string;
  readonly keys: ListKeyStore;
  identity(): RelayIdentity | undefined;
  /** The PC's standing binding to its account, or null. */
  binding(): { readonly account: string; readonly id: string } | null;
  /** A PC route of the list at the account service, with this PC's proof (AccountMailbox.listRoute). */
  call(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The key of the account row `id` that the snapshot path holds, or null. */
  rowKey(id: string): string | null;
  /** The PC's clock, in milliseconds. */
  now(): number;
}

const PC_STATES: ReadonlySet<string> = new Set<SessionRefusal>(["waiting", "stopped", "out"]);

export class ListFollow {
  private readonly path: string;
  private copy: FollowerCopy | null = null;
  private scope: { readonly serverId: string; readonly bindId: string } | null = null;
  private loaded = false;
  private problem: string | null = null;
  private keysState: ListStatus["keys"] = null;
  private lastVerdict: string | null = null;
  private error: string | null = null;
  private postedAt: number | null = null;
  private postedUntil: number | null = null;
  private readonly differences = new Set<string>();
  private readonly ids = new WeakMap<FollowerCopy, Map<string, string>>();
  private turn: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: ListFollowDeps) { this.path = join(deps.stateDir, ACCOUNT_LIST_FILE); }

  /** What a mailbox pull's answer named as the account's list. Starts a read in turn and returns at once. */
  heard(account: string, named: NamedList | null): void {
    if (this.stopped) return;
    const run = () => this.follow(account, named).catch((error: unknown) => { this.error = this.words(error); });
    this.turn = this.turn.then(run, run);
  }

  /** Everything heard so far has been followed. */
  settled(): Promise<void> { return this.turn; }

  stop(): void { this.stopped = true; }

  status(): ListStatus {
    const copy = this.current();
    const view = copy?.state ? listView(copy.state) : null;
    return {
      account: this.deps.binding()?.account ?? null,
      list: copy?.list ?? null,
      pinned: false,
      standing: copy === null ? null : standing(copy),
      head: copy?.state ? { seq: copy.state.footing.seq, hash: copy.state.footing.hash } : null,
      devices: view?.devices.filter((row) => row.ended === null).length ?? 0,
      pcs: view?.pcs.filter((row) => row.removed === null).length ?? 0,
      alarm: copy?.alarm ? "fork" : null,
      last_read_at: copy?.read_at == null ? null : new Date(copy.read_at * 1000).toISOString(),
      last_verdict: this.lastVerdict,
      differences: this.differences.size,
      keys: this.keysState,
      posted_until: this.postedUntil === null ? null : new Date(this.postedUntil * 1000).toISOString(),
      error: this.problem ?? this.error,
    };
  }

  /**
   * Shadow: a sign-in the snapshot path has just decided. The list's own answer for that device is compared and a
   * difference is said once. It decides nothing, waits for nothing and never throws.
   */
  shadowSignIn(given: { readonly deviceId: string; readonly nonce: Uint8Array; readonly signature: string; readonly serverId: string; readonly snapshot: SnapshotVerdict }): void {
    try {
      const copy = this.current();
      if (copy === null) return;
      const key = this.deps.rowKey(given.deviceId) ?? this.keyOf(copy, given.deviceId);
      if (key === null) return;
      const list = admitsSession(copy, key, this.seconds());
      if (given.snapshot === "admitted") { this.compare(key, "admitted", list.role ?? list.why); return; }
      // No row here: the list alone would let it in only for the proof of its key
      if (list.role === null) return;
      const role = list.role;
      const prove = () => verifyRelayProof(key, given).then((proved) => { if (proved) this.compare(key, "none", role); }, () => undefined);
      this.turn = this.turn.then(prove, prove);
    } catch { /* a shadow never stands in the way of a sign-in */ }
  }

  /**
   * Shadow: the devices a whole snapshot read lets in, against the devices the list lets in. Compared in turn, after
   * whatever read of the list the same pull began, and never awaited by the snapshot read.
   */
  shadowSnapshot(eligible: readonly string[]): void {
    const compare = () => {
      try {
        const copy = this.current();
        if (copy === null) return;
        const now = this.seconds();
        const named = new Set(eligible);
        for (const key of named) { const list = admitsSession(copy, key, now); this.compare(key, "admitted", list.role ?? list.why); }
        for (const key of this.idsOf(copy).values()) {
          if (named.has(key)) continue;
          const list = admitsSession(copy, key, now);
          if (list.role !== null) this.compare(key, "none", list.role);
        }
      } catch { /* as above */ }
    };
    this.turn = this.turn.then(compare, compare);
  }

  private compare(key: string, snapshot: SnapshotVerdict, list: ListRole | SessionRefusal): void {
    // the snapshot's rows all drive: a device the list lets in to watch is a difference too
    if (snapshot === "admitted" && list === "drive") return;
    // where the PC itself is not in the list, that is one difference, not one for each device
    const id = PC_STATES.has(list) ? `${snapshot} ${list}` : `${key} ${snapshot} ${list}`;
    if (this.differences.has(id) || this.differences.size >= DIFFERENCES_MAX) return;
    this.differences.add(id);
    logAccess({ event: "account.list.differs", snapshot, list });
  }

  /** The copy of the identity and binding the PC has now; null for none, or for one of another identity or binding. */
  private current(): FollowerCopy | null {
    const scope = this.scopeNow();
    return scope !== null && this.scope !== null && scope.serverId === this.scope.serverId && scope.bindId === this.scope.bindId ? this.copy : null;
  }

  private scopeNow(): { serverId: string; bindId: string; account: string; endpoint: string } | null {
    let identity: RelayIdentity | undefined;
    try { identity = this.deps.identity(); } catch { return null; }
    const binding = this.deps.binding();
    if (!identity || binding === null) return null;
    return { serverId: identity.server_id, bindId: binding.id, account: binding.account, endpoint: bytesToHex(importPublicKey(identity.public_key)) };
  }

  private seconds(): number { return Math.floor(this.deps.now() / 1000); }

  private words(error: unknown): string {
    if (error instanceof AccountServiceRefusal) return `The account service answered ${error.status}${error.code === null ? "" : ` ${error.code}`} to ${error.path}`;
    if (error instanceof ListKeysError) return error.message;
    return error instanceof Error ? error.name : "The list could not be followed";
  }

  private idsOf(copy: FollowerCopy): Map<string, string> {
    let ids = this.ids.get(copy);
    if (!ids) {
      ids = new Map((copy.state ? listView(copy.state).devices : []).map((row) => [accountDeviceId(this.scope?.serverId ?? "", row.key), row.key]));
      this.ids.set(copy, ids);
    }
    return ids;
  }

  private keyOf(copy: FollowerCopy, deviceId: string): string | null { return this.idsOf(copy).get(deviceId) ?? null; }

  private async follow(account: string, named: NamedList | null): Promise<void> {
    const scope = this.scopeNow();
    if (this.stopped || scope === null || scope.account !== account) return;
    await this.load(scope);
    if (this.problem !== null) return;
    this.error = null;
    // an account with no list, one the service names no list for, and a service that is away all leave a copy as it is
    if (named === null) { this.lastVerdict = "none"; return; }
    let keys: PcListKeys;
    try { keys = await this.deps.keys.keysFor(scope.serverId); this.keysState = "ready"; } catch (error) {
      if (!(error instanceof ListKeysError)) throw error;
      this.keysState = "unreadable";
      this.error = error.message;
      return;
    }
    let copy = this.copy;
    // a shadow of other keys than the PC has now is nobody's copy
    if (copy !== null && (copy.me.key !== keys.key || copy.me.endpoint !== scope.endpoint)) copy = null;
    if (copy === null) {
      const first = pinList(null, { account, list: named.id, me: { key: keys.key, endpoint: scope.endpoint }, pin: { how: "added" } });
      if (!first.pinned) { this.lastVerdict = "not_my_list"; return; }
      copy = first.copy;
    }
    const heard = heardHead(copy, { list: named.id, place: named.head }, this.seconds());
    this.lastVerdict = heard.verdict;
    this.keep(heard.copy, scope, false);
    if (heard.verdict === "read") await this.read(scope);
    if (this.copy !== null && standing(this.copy) === "waiting") await this.post(this.copy, keys, scope);
  }

  /** One read of the log, page after page, until the follower asks for no more. The copy is saved once, when it changed. */
  private async read(scope: { serverId: string; bindId: string }): Promise<void> {
    let copy = this.copy!;
    const before = copy;
    let read: FollowRead | null = startRead(copy, "service");
    try {
      for (let pages = 0; read !== null && pages < LIST_READ_PAGES_MAX && !this.stopped; pages++) {
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
      this.keep(copy, scope, copy.entries !== before.entries || copy.state !== before.state || copy.alarm !== before.alarm || copy.stop !== before.stop);
    }
  }

  /** The second lock for a `pc` entry: this PC's keys and its card for this list, at the account service, for ten minutes. */
  private async post(copy: FollowerCopy, keys: PcListKeys, scope: { endpoint: string }): Promise<void> {
    const now = this.deps.now();
    if (this.postedAt !== null && now - this.postedAt >= 0 && now - this.postedAt < LIST_POST_RENEW_MS) return;
    try {
      const card = await signCard({ key: keys.key, enc: keys.enc, list: copy.list, endpoint: scope.endpoint, invite: null }, keys.privateKey);
      const answer = await this.deps.call("/v2/pc/list/keys", { list: copy.list, key: keys.key, enc: keys.enc, card });
      this.postedAt = now;
      this.postedUntil = typeof answer.until === "number" && Number.isSafeInteger(answer.until) ? answer.until : null;
    } catch (error) {
      this.postedUntil = null;
      this.error = this.words(error);
    }
  }

  private keep(copy: FollowerCopy, scope: { serverId: string; bindId: string }, save: boolean): void {
    if (save) {
      const file: ListFile = { v: 1, server_id: scope.serverId, bind_id: scope.bindId, save: writeSave(copy) };
      try { writePrivateState(this.path, file); } catch (error) {
        // what is not on disk is not held: the next read takes it again
        this.error = `${ACCOUNT_LIST_FILE} could not be written (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
        return;
      }
    }
    this.copy = copy;
    this.scope = { serverId: scope.serverId, bindId: scope.bindId };
  }

  /** Reads the file once for the identity and binding the PC has. One that is not this PC's copy, or does not read as one, is read again from the service. */
  private async load(scope: { serverId: string; bindId: string }): Promise<void> {
    if (this.loaded && this.scope?.serverId === scope.serverId && this.scope.bindId === scope.bindId) return;
    this.loaded = true;
    this.copy = null;
    this.problem = null;
    this.scope = { serverId: scope.serverId, bindId: scope.bindId };
    this.differences.clear();
    this.postedAt = this.postedUntil = null;
    let text: string;
    try { text = readFileSync(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.problem = `${ACCOUNT_LIST_FILE} cannot be read`;
      return;
    }
    const file = parseFile(text);
    // another identity's or binding's copy is not this PC's, and neither is a file that is no copy: the next save replaces it
    if (file === null || file.server_id !== scope.serverId || file.bind_id !== scope.bindId) return;
    const saved = await readSave(file.save);
    // a copy that does not read is read again from the service: it decides nothing
    if (!saved.read) return;
    this.copy = saved.copy;
    // another build wrote it: its entries were replayed, and the copy is written back as this build writes it
    if (saved.rebuilt) {
      console.info(`[account] ${ACCOUNT_LIST_FILE} was written by another build: its entries were read again`);
      this.keep(saved.copy, scope, true);
    }
  }
}

function parseFile(text: string): ListFile | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { v, server_id, bind_id, save, ...rest } = value as Record<string, unknown>;
  if (v !== 1 || Object.keys(rest).length > 0 || typeof server_id !== "string" || !SERVER_ID_PATTERN.test(server_id) || typeof bind_id !== "string" || !BIND_ID.test(bind_id)
    || typeof save !== "string") return null;
  return { v: 1, server_id, bind_id, save };
}

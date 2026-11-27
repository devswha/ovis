import { join } from "node:path";
import { JoinLineError, readJoinLine, type JoinLine } from "../../shared/account-list-join.ts";
import type { DeviceStore } from "../devices.ts";
import type { RelayIdentity } from "../relay/identity.ts";
import type { RelayService } from "../relay/service.ts";
import type { AccountHolds } from "./holds.ts";
import { ITS_ME_MIN_AGE_MS } from "./join-hold.ts";
import { AccountServiceRefusal, MAILBOX_PULL_MS, type AccountMailbox } from "./mailbox.ts";
import type { SafetyLog } from "./safety-log.ts";
import { ACCOUNT_MOVE_FILE, MoveJournalFile, moveCaller, moveId, moveInvite, removeMoveJournal, type MoveJournal } from "./account-move-journal.ts";
import { switchMovedAccount } from "./account-move-switch.ts";

export const MOVE_ANSWER_MS = 20_000;
export const MOVE_MIN_ROW_AGE_MS = ITS_ME_MIN_AGE_MS;
const RETRIES = [5_000, 15_000, 60_000] as const;

export type MoveOutcome =
  | { readonly state: "moved"; readonly account: string }
  | { readonly state: "pending" }
  | { readonly refused: { readonly code: string; readonly message: string; readonly status: number; readonly retryAfter?: number } };
type MoveStatus = { readonly state: "idle" } | { readonly state: "pending"; readonly merge: string } | { readonly state: "refuses"; readonly code: string };
type MoveOrder = { readonly merge_id: unknown; readonly from: unknown; readonly into: unknown; readonly invite: unknown; readonly by: string; readonly callerKey?: string };
type MoveClock = { now(): number; setTimeout(callback: () => void, ms: number): () => void };
type Ports = {
  readonly stateDir: string; readonly sibling: string | null; readonly devices: DeviceStore; readonly relay: RelayService;
  readonly mailbox: AccountMailbox; readonly holds: AccountHolds; readonly safety: SafetyLog | null; readonly clock?: MoveClock;
};

const refused = (code: string, message: string, status = 409, retryAfter?: number): Extract<MoveOutcome, { refused: unknown }> =>
  ({ refused: { code, message, status, ...(retryAfter === undefined ? {} : { retryAfter }) } });
const pending = { state: "pending" } as const;
const moved = (account: string): MoveOutcome => ({ state: "moved", account });
const invalid = () => refused("invalid_move", "Send the merge id, both accounts and a join line for the destination", 400);
const busy = () => refused("move_in_progress", "This PC already has a different account move in progress");
const listAccount = () => refused("list_account", "This release cannot move a PC into or out of an account with a signed list");
const unavailable = () => refused("account_unavailable", "This PC's relay identity, account service or move journal is unavailable", 503);
const closed = () => refused("merge_closed", "That merge is no longer open");
const moveMessages: Readonly<Record<string, string>> = {
  merge_closed: "That merge is no longer open", not_listed: "The old account does not list this PC",
  invite_invalid: "Make a new invite and ask again", relay_limit: "The destination account cannot take another PC",
  try_again: "Try moving this PC again", directory_full: "The destination account's PC directory is full",
  list_account: "This release cannot move a PC into or out of an account with a signed list",
};
const wallClock: MoveClock = { now: Date.now, setTimeout(callback, ms) {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return () => clearTimeout(timer);
} };

export class AccountMove {
  static open(ports: Ports): AccountMove { return new AccountMove(ports); }
  private readonly journal: MoveJournalFile;
  private readonly clock: MoveClock;
  private attempt: Promise<MoveOutcome> | null = null;
  private cancelRetry: (() => void) | undefined;
  private retries = 0;
  private stopped = false;
  private constructor(private readonly ports: Ports) {
    this.journal = new MoveJournalFile(join(ports.stateDir, ACCOUNT_MOVE_FILE), ports.devices);
    this.clock = ports.clock ?? wallClock;
  }

  pending(bindId: string): boolean {
    const journal = this.journal.read();
    return journal === "unavailable" || journal?.from.bind_id === bindId;
  }

  status(): MoveStatus {
    const journal = this.journal.read();
    if (journal === "unavailable" || this.journal.takeUnreadable()) return { state: "refuses", code: "journal_unreadable" };
    if (journal !== null) return { state: "pending", merge: journal.merge_id };
    const blocked = this.constraints();
    return blocked ? { state: "refuses", code: blocked.refused.code } : { state: "idle" };
  }

  private constraints() {
    const { devices, holds, safety } = this.ports;
    if (safety?.state().locked) return refused("locked", "Unlock this PC on its own screen first");
    const binding = devices.standingAccountBinding();
    if (binding?.list || devices.listFollowed()) return listAccount();
    if (holds.enrolling()) return refused("enrolling", "The PC still waits for its first account member to enroll");
    if (binding?.pending || devices.revokeAllError) return refused("busy", "This PC is finishing another account change");
    if (!this.ports.relay.currentIdentity() || this.ports.mailbox.moveService() === null) return unavailable();
    return null;
  }

  private caller(id: string, key: string): MoveOutcome | null {
    const { devices, safety } = this.ports;
    if (safety?.state().locked) return refused("locked", "Unlock this PC on its own screen first");
    if (devices.sessionRow(id)?.role !== "drive" || !devices.accountSession(id, key)) {
      return refused("not_member", "Only a device of this PC's account or its own window can move it", 403);
    }
    if (!devices.canOrderAccountMove(id)) return refused("join_hold", "Wait for this device's join hold to end", 403);
    const age = Date.now() - Date.parse(devices.originOf(id)?.at ?? devices.addedAt(id) ?? "");
    const remaining = Number.isFinite(age) ? Math.max(0, MOVE_MIN_ROW_AGE_MS - Math.max(0, age)) : MOVE_MIN_ROW_AGE_MS;
    return remaining > 0 ? refused("too_new", "This device must have been admitted to this PC at least an hour ago", 409, Math.ceil(remaining / 1000)) : null;
  }

  async order(req: MoveOrder, waitMs = MOVE_ANSWER_MS): Promise<MoveOutcome> {
    const { devices, relay, mailbox, holds, safety } = this.ports;
    if (safety?.state().locked) return refused("locked", "Unlock this PC on its own screen first");
    const { merge_id, from, into, invite, by } = req;
    if (!moveId(merge_id) || !moveId(from) || !moveId(into) || from === into || !moveInvite(invite) || !moveCaller(by)) return invalid();
    const service = mailbox.moveService();
    const identity = relay.currentIdentity();
    if (service === null || !identity || this.stopped) return unavailable();
    let parsed: JoinLine;
    try { parsed = await readJoinLine(invite, { service, followsLists: false }); }
    catch (error) {
      if (error instanceof JoinLineError) {
        if (error.reason === "other_service") return refused("invite_invalid", "This invite belongs to a different account service");
        if (error.reason === "needs_lists") return listAccount();
        return invalid();
      }
      return unavailable();
    }
    if (parsed.account !== into) return invalid();
    const relayedKey = by === "pc" ? undefined : req.callerKey ?? "";
    const check = () => {
      const binding = devices.standingAccountBinding();
      if (safety?.state().locked) return refused("locked", "Unlock this PC on its own screen first");
      const receipt = binding?.account === into && devices.accountClears().find(clear =>
        clear.merged?.merge === merge_id && clear.merged.into === into && clear.merged.from === from)?.merged;
      const orderer = receipt && receipt.by === by ? devices.sessionRow(by) : null;
      if (receipt && (relayedKey === undefined || (orderer?.role === "drive" && orderer.key === relayedKey))) return moved(into);
      if (relayedKey !== undefined) {
        const rejected = this.caller(by, relayedKey);
        if (rejected) return rejected;
      }
      if (receipt) return moved(into);
      if (!binding) return refused("not_in_account", "This PC is not in an account");
      if (binding.account !== from) return refused("other_account", "This PC is in another account");
      if (binding.list || devices.listFollowed() || devices.listRemovedFrom(into)) return listAccount();
      if (holds.enrolling()) return refused("enrolling", "The PC still waits for its first account member to enroll");
      if (binding.pending || devices.revokeAllError) return refused("busy", "This PC is finishing another account change");
      return binding;
    };
    const before = check();
    if (!("bind_id" in before)) return before;
    const held = this.journal.read();
    if (held === "unavailable") return unavailable();
    if (held && held.merge_id !== merge_id) return busy();
    const read = held !== null || await mailbox.readBeforeMove(before.bind_id);
    const standing = check();
    if (!("bind_id" in standing)) return standing;
    if (!read) return unavailable();
    if (standing.bind_id !== before.bind_id || relay.currentIdentity()?.server_id !== identity.server_id || this.stopped) {
      return refused("revoked", "This PC's account or identity changed during the move");
    }
    let intent: ReturnType<MoveJournalFile["begin"]>;
    try {
      intent = this.journal.begin({ v: 1, merge_id, server_id: identity.server_id, from: { account: from, bind_id: standing.bind_id },
        into, invite, by, started_at: new Date().toISOString() });
    } catch { return unavailable(); }
    const { journal, fresh } = intent;
    if (typeof journal === "string") return unavailable();
    if (fresh) this.retries = 0;
    if (!journal || journal.merge_id !== merge_id || journal.from.account !== from || journal.into !== into) return busy();
    const run = this.run(journal, fresh, fresh ? parsed : undefined);
    let cancel: (() => void) | undefined;
    try { return await Promise.race([run, new Promise<MoveOutcome>(resolve => { cancel = this.clock.setTimeout(() => resolve(pending), waitMs); })]); }
    finally { cancel?.(); }
  }

  resume(): void {
    if (this.stopped || this.attempt) return;
    const journal = this.journal.read();
    if (journal === "unavailable") this.retry();
    else if (journal !== null) void this.run(journal, false);
  }

  async idle(): Promise<void> { await this.attempt; }
  stop(): void { this.stopped = true; this.cancelRetry?.(); }

  private retry(): void {
    this.cancelRetry?.();
    this.cancelRetry = this.clock.setTimeout(() => this.resume(), RETRIES[this.retries++] ?? MAILBOX_PULL_MS);
  }

  private run(journal: MoveJournal, fresh: boolean, invite?: JoinLine): Promise<MoveOutcome> {
    if (this.attempt) return this.attempt;
    this.cancelRetry?.();
    const turn = this.settle(journal, fresh, invite).catch((error: unknown) => {
      if (!(error instanceof Error)) console.warn("[account] an account move attempt failed");
      return pending;
    }).then(outcome => {
      if ("state" in outcome && outcome.state === "pending" && !this.stopped) this.retry();
      return outcome;
    }).finally(() => { this.attempt = null; });
    this.attempt = turn;
    return turn;
  }

  private async settle(journal: MoveJournal, fresh: boolean, parsed?: JoinLine): Promise<MoveOutcome> {
    const { devices, relay, mailbox } = this.ports;
    const identity = relay.currentIdentity();
    const initial = this.local(journal, identity);
    if (initial !== "standing") return initial;
    if (!identity || devices.failsClosed || this.ports.safety?.state().locked) return pending;
    if (!fresh) {
      const where = await mailbox.whereami(identity, journal.merge_id);
      if (devices.accountClears().some(clear => clear.bind_id === journal.from.bind_id && clear.reason === "revoke_all")) {
        this.remove(journal);
        return refused("revoked", "This PC's connections were revoked during the move");
      }
      if (where?.account === journal.into) return where.listing_id === null ? pending : this.finish(journal, identity, where.listing_id);
      if (where?.account !== journal.from.account || where.merge !== "open") {
        this.remove(journal);
        return closed();
      }
    }
    const service = mailbox.moveService();
    if (service === null) return pending;
    if (await mailbox.listNamed(journal.into) !== null) {
      this.remove(journal);
      return listAccount();
    }
    const invite = parsed ?? await readJoinLine(journal.invite, { service, followsLists: false });
    const live = this.local(journal, relay.currentIdentity());
    if (live !== "standing") return live;
    if (this.stopped || invite.account !== journal.into || devices.failsClosed || this.ports.safety?.state().locked) return pending;
    try {
      const answer = await mailbox.transfer(identity, journal.merge_id, invite);
      return answer.account === journal.into ? this.finish(journal, identity, answer.listing_id) : pending;
    } catch (error) {
      if (!(error instanceof AccountServiceRefusal) || error.path !== "/v1/pc/transfer" || error.status >= 500
        || error.status < 400 || error.status === 401 || error.status === 408 || error.status === 429) return pending;
      const where = await mailbox.whereami(identity, journal.merge_id);
      if (where?.account === journal.into) return where.listing_id === null ? pending : this.finish(journal, identity, where.listing_id);
      this.remove(journal);
      const code = error.code ?? "merge_closed";
      return Object.hasOwn(moveMessages, code) ? refused(code, moveMessages[code] ?? "The account service refused the move") : closed();
    }
  }

  private local(journal: MoveJournal, identity: RelayIdentity | undefined): "standing" | MoveOutcome {
    const { devices } = this.ports;
    const binding = devices.standingAccountBinding();
    if (this.stopped || identity === undefined) return pending;
    if (devices.failsClosed && binding === null) return pending;
    if (binding?.account === journal.into && binding.listing_id && identity.server_id === journal.server_id
      && devices.accountClears().some(clear => clear.bind_id === journal.from.bind_id && clear.merged?.merge === journal.merge_id)) {
      return this.finishCommitted(journal, binding.listing_id);
    }
    if (identity.server_id === journal.server_id && binding?.bind_id === journal.from.bind_id) return "standing";
    // A same-identity PC explicitly revoked here may reconcile with the service, but cannot switch.
    return identity.server_id === journal.server_id && devices.accountClears().some(clear =>
      clear.bind_id === journal.from.bind_id && clear.reason === "revoke_all") ? "standing" : pending;
  }

  private finish(journal: MoveJournal, identity: RelayIdentity, listing_id: string): MoveOutcome {
    const { devices, relay, safety } = this.ports;
    const current = relay.currentIdentity();
    const state = this.local(journal, current);
    if (state !== "standing") return state;
    if (current?.server_id !== identity.server_id || devices.failsClosed || safety?.state().locked) return pending;
    switchMovedAccount(devices, journal.from, { account: journal.into, listing_id, merge: journal.merge_id, at: new Date().toISOString(), by: journal.by });
    return this.finishCommitted(journal, listing_id);
  }

  private finishCommitted(journal: MoveJournal, listing: string): MoveOutcome {
    const { relay, mailbox } = this.ports;
    if (!relay.setRelayAccount(journal.into, null)) return pending;
    this.remove(journal);
    void mailbox.complete(journal.into, listing);
    void mailbox.readSnapshot();
    return moved(journal.into);
  }

  private remove(journal: MoveJournal): void {
    removeMoveJournal(this.journal.path, this.ports.sibling, journal);
  }
}

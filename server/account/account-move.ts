import { randomBytes } from "node:crypto";
import type { AccountMoveAborted, AccountMoveAnswer, AccountMoveRequest, AccountMoveStatus } from "../../shared/protocol.ts";
import { logAccess } from "../connection-diagnostics.ts";
import type { DeviceStore } from "../devices.ts";
import type { RelayIdentity } from "../relay/identity.ts";
import type { RelayService } from "../relay/service.ts";
import type { AccountHolds } from "./holds.ts";
import { AccountServiceRefusal, MAILBOX_PULL_MS, type AccountMailbox } from "./mailbox.ts";
import { MoveJournalFile, type MoveJournal } from "./account-move-journal.ts";
import type { SafetyLog } from "./safety-log.ts";

const pending = { state: "pending" } as const;
type MoveOutcome = AccountMoveAnswer | { readonly error: { readonly code: string; readonly message: string }; readonly status: number };
const refuse = (code: string, message: string, status = 409): MoveOutcome => ({ error: { code, message }, status });
const unavailable = () => refuse("account_unavailable", "This PC cannot read its account, relay identity or move journal", 503);
const listAccount = () => refuse("list_account", "This PC cannot move into or out of an account with a signed list");
const moved = (account: string): AccountMoveAnswer => ({ state: "moved", account });
/** The first retry of a move that could not advance; each next one waits twice as long, up to a mailbox pull's period. */
const RETRY_MS = 1_000;

type Ports = {
  readonly stateDir: string;
  readonly sibling: string | null;
  readonly devices: DeviceStore;
  readonly relay: RelayService;
  readonly mailbox: AccountMailbox;
  readonly holds: AccountHolds;
  readonly safety: SafetyLog | null;
};

/**
 * A move of this PC from its account to another (docs/account.md, "Moving a PC"), on the account service's existing
 * routes. The journal is on disk before the destination lists the PC; from then on the server finishes the move by
 * itself, forward only: it takes the destination's admission whenever one waits, switches the binding in one write,
 * and leaves the old account until that answers 204. It gives up only before the switch, and never removes the
 * destination's listing.
 */
export class AccountMove {
  private readonly journal: MoveJournalFile;
  /** One step at a time: an attempt, and a cancel that must see what the attempt took. */
  private turn: Promise<unknown> = Promise.resolve();
  private attempt: { readonly id: string; readonly result: Promise<MoveOutcome> } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private stopped = false;

  static open(ports: Ports): AccountMove { return new AccountMove(ports); }
  private constructor(private readonly ports: Ports) { this.journal = new MoveJournalFile(ports.stateDir, ports.sibling); }

  status(): AccountMoveStatus {
    const intent = this.journal.read();
    if (typeof intent === "object" && intent !== null) return { into: intent.into };
    const aborted = this.journal.aborted();
    return { into: null, ...(aborted?.from === this.ports.devices.account() ? { aborted: aborted.answer } : {}) };
  }

  async order(request: AccountMoveRequest): Promise<MoveOutcome> {
    const { devices, relay, holds, mailbox } = this.ports;
    if (this.stopped) return unavailable();
    const { into, stage } = request;
    const held = this.journal.read();
    if (typeof held === "string") return unavailable();
    if (held !== null && held.into !== into) return refuse("move_in_progress", "This PC is already moving to a different account");
    if (stage === "cancel") return held === null ? { state: "aborted", account: into, reason: "cancelled" } : this.cancel(held);
    const binding = devices.standingAccountBinding();
    const pc = relay.publicFields();
    // a move under way is finished, or given up, by the journal it wrote: what stands now is the journal's to judge
    if (held !== null) {
      if (stage === "prepare" && !this.committed(held) && pc && binding?.bind_id === held.from.bind_id && pc.server_id === held.server_id) {
        void this.run(held);
        return { state: "prepare", pc };
      }
      // the window's own ask after its admit: an attempt that looked before the admission was there looks again
      return this.run(held, stage === undefined);
    }
    if (binding?.account === into) return moved(into);
    if (!binding) return refuse("not_in_account", "This PC is not in an account");
    if (binding.list || devices.listFollowed() || devices.listRemovedFrom(into)) return listAccount();
    if (this.ports.safety?.state().locked) return refuse("locked", "Unlock this PC on its own screen first");
    if (devices.failsClosed || binding.pending || holds.enrolling() || devices.revokeAllError || mailbox.serviceOff() || !pc) return unavailable();
    // the window's ask after a move given up meanwhile (by a retry of the server's own) answers how it ended
    const ended = this.journal.aborted();
    if (stage === undefined && ended !== null && ended.answer.account === into && ended.from === binding.account) return ended.answer;
    if (stage !== "prepare") return refuse("move_not_started", "Start moving this PC from its own window first");
    try {
      const started = this.journal.begin({ v: 1, id: randomBytes(16).toString("hex"), server_id: pc.server_id, from: { account: binding.account, bind_id: binding.bind_id },
        into, started_at: new Date().toISOString(), ...(request.provider === undefined ? {} : { provider: request.provider }) });
      if (typeof started === "string" || started === null) return unavailable();
      if (started.into !== into) return refuse("move_in_progress", "This PC is already moving to a different account");
      if (started.from.bind_id !== binding.bind_id || started.server_id !== pc.server_id) return this.run(started);
      // from the journal on the move advances by itself: it takes the admission as soon as the window's admit makes it,
      // whether or not the window asks again (until then each attempt answers sign_in, and is asked again)
      this.retries = 0;
      void this.run(started);
      return { state: "prepare", pc };
    } catch (error) { return this.failed(error, unavailable()); }
  }

  /** At start, and at each retry: a journal on disk is finished by the server, with or without a window. */
  resume(): void {
    if (this.stopped || this.attempt) return;
    const intent = this.journal.read();
    if (intent === "unavailable") this.retry();
    else if (typeof intent === "object" && intent !== null) void this.run(intent);
  }

  stop(): void { this.stopped = true; clearTimeout(this.timer); }

  private exclusively<T>(work: () => Promise<T>): Promise<T> {
    const next = this.turn.then(work, work);
    this.turn = next.catch(() => undefined);
    return next;
  }

  private retry(seconds = 0): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.resume(); }, Math.max(seconds * 1000, Math.min(MAILBOX_PULL_MS, RETRY_MS * 2 ** this.retries++)));
    this.timer.unref();
  }

  private failed<T>(error: unknown, result: T): T {
    if (!this.stopped) console.warn("[account] PC move could not advance:", error instanceof Error ? error.message : error);
    return result;
  }

  /** `again`: an attempt already out that ends at sign_in (it looked before an admission was made) is followed by another. */
  private run(intent: MoveJournal, again = false): Promise<MoveOutcome> {
    const running = this.attempt;
    if (running?.id === intent.id) {
      return again ? running.result.then(outcome => "state" in outcome && outcome.state === "sign_in" && !this.stopped ? this.run(intent) : outcome) : running.result;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    let wait = 0;
    const result: Promise<MoveOutcome> = this.exclusively(() => this.settle(intent)).catch((error: unknown) => {
      wait = error instanceof AccountServiceRefusal ? error.retryAfter ?? 0 : 0;
      return this.failed(error, pending);
    }).then((outcome) => {
      // a move that waits (on the service, on the destination's admission, on a file) is asked again by the server
      if ("state" in outcome && (outcome.state === "pending" || outcome.state === "sign_in")) {
        if (this.journal.read() !== null) this.retry(wait);
      } else this.retries = 0;
      return outcome;
    }).finally(() => { if (this.attempt?.result === result) this.attempt = null; });
    this.attempt = { id: intent.id, result };
    return result;
  }

  /**
   * A cancel gives up only a move that has not taken its admission: once the PC holds the destination's admission,
   * or switched, it finishes forward. A mailbox that does not answer cancels nothing.
   */
  private cancel(intent: MoveJournal): Promise<MoveOutcome> {
    return this.exclusively(async (): Promise<MoveOutcome | "forward"> => {
      if (this.committed(intent)) return "forward";
      const identity = this.ports.relay.currentIdentity();
      if (identity?.server_id !== intent.server_id) return "forward";
      try {
        if ((await this.ports.mailbox.moveListing(identity, intent.into)).admitted) return "forward";
      } catch (error) { return this.failed(error, pending); }
      return this.abort(intent, "cancelled");
    }).then(outcome => outcome === "forward" ? this.run(intent) : outcome);
  }

  /** The switch happened: this binding's clear says it moved to the destination, whatever stands since. */
  private committed(intent: MoveJournal): boolean {
    return this.ports.devices.accountClears().some(clear => clear.bind_id === intent.from.bind_id && clear.moved?.into === intent.into);
  }

  private abort(intent: MoveJournal, reason: AccountMoveAborted["reason"]): MoveOutcome {
    try {
      if (!this.journal.remove(intent, () => !this.committed(intent), reason)) return pending;
      return { state: "aborted", account: intent.into, reason };
    } catch (error) { return this.failed(error, pending); }
  }

  private async settle(intent: MoveJournal): Promise<MoveOutcome> {
    const { devices, relay, mailbox } = this.ports;
    const current = this.journal.read();
    if (typeof current === "string") return pending;
    // the journal went while this step waited its turn: the move ended, by its switch or by giving up
    if (current === null || current.id !== intent.id) return this.committed(intent) ? moved(intent.into)
      : { state: "aborted", account: intent.into, reason: this.journal.aborted(intent.id)?.answer.reason ?? "cancelled" };
    const ended = this.journal.aborted(intent.id);
    if (ended !== null && !this.committed(intent)) return this.abort(intent, ended.answer.reason);
    const identity = relay.currentIdentity();
    if (!identity || this.stopped || devices.failsClosed) return pending;
    if (identity.server_id !== intent.server_id) {
      // A new identity cannot prove the old PC's leave. Never leave either account as the new PC.
      this.journal.remove(intent, () => true);
      return refuse("identity_changed", "This PC's relay identity changed");
    }
    if (this.committed(intent)) return this.finish(intent, identity);
    if (devices.standingAccountBinding()?.bind_id !== intent.from.bind_id) return this.abort(intent, "binding_changed");
    if (this.ports.safety?.state().locked) return pending;

    let listing: string | undefined;
    let pass: Record<string, unknown>;
    try {
      if (await mailbox.listNamed(intent.into) !== null) return this.abort(intent, "list_account");
      // the destination's admission, taken as soon as it waits: once taken the move only goes forward
      const receipt = await mailbox.admission(intent.into, identity);
      if (receipt?.account === intent.into) listing = receipt.listing_id;
      // A taken admission is written on the service's listing, not on this disk: it outlives a lost answer and the
      // admission's ten minutes
      if (listing === undefined) {
        const read = await mailbox.moveListing(identity, intent.into);
        if (read.admitted) listing = read.listing ?? undefined;
      }
      if (listing === undefined) return { state: "sign_in", account: intent.into };
      pass = await mailbox.moveRelayPass(identity, intent.into);
      const current = await mailbox.moveListing(identity, intent.into);
      if (!current.admitted || current.listing !== listing) return this.abort(intent, "listing_changed");
    } catch (error) {
      if (error instanceof AccountServiceRefusal) {
        if (error.code === "relay_limit") return this.abort(intent, "relay_limit");
        if (error.code === "list_add") return this.abort(intent, "list_account");
        if (error.code === "not_listed") return this.abort(intent, "listing_changed");
      }
      throw error;
    }

    if (this.stopped || devices.failsClosed || this.ports.safety?.state().locked) return pending;
    const listingId = listing;
    const changed = await mailbox.commitMove(intent.from.bind_id, () => this.journal.commit(intent, () => {
      const before = devices.standingAccountBinding();
      if (before?.bind_id !== intent.from.bind_id || relay.currentIdentity()?.server_id !== identity.server_id) return "binding_changed";
      if (before.list || devices.listFollowed() || devices.listRemovedFrom(intent.into)) return "list_account";
      if (this.stopped || devices.failsClosed || this.ports.safety?.state().locked || this.ports.holds.enrolling() || devices.revokeAllError) return "pending";
      // the pass the destination just issued is the one kept: the switch asks for no second one
      relay.adoptPass(pass, intent.into);
      devices.rebindAccount(intent.from.bind_id, { account: intent.into, listing_id: listingId, at: intent.started_at });
      devices.settleMovedRows({ from: intent.from.account, at: intent.started_at });
      logAccess({ event: "account.binding.moved" });
      return "switched";
    }));
    if (changed === undefined) {
      if (this.journal.read() === null) return { state: "aborted", account: intent.into, reason: this.journal.aborted(intent.id)?.answer.reason ?? "cancelled" };
      if (this.committed(intent)) return this.finish(intent, identity);
      if (this.journal.aborted(intent.id) !== null) return this.abort(intent, this.journal.aborted(intent.id)!.answer.reason);
      if (devices.standingAccountBinding()?.bind_id !== intent.from.bind_id) return this.abort(intent, "binding_changed");
      return pending;
    }
    if (changed === "pending") return pending;
    if (changed !== "switched") return this.abort(intent, changed);
    return this.finish(intent, identity);
  }

  /**
   * After the switch: the destination's add is completed (its receipt is kept and sent again by the mailbox, whatever
   * it answers), then the old account is left, asked again until it answers 204. Only then does the journal go.
   */
  private async finish(intent: MoveJournal, identity: RelayIdentity): Promise<MoveOutcome> {
    const { relay, mailbox, devices } = this.ports;
    devices.settleMovedRows({ from: intent.from.account, at: intent.started_at });
    const binding = devices.standingAccountBinding();
    if (binding?.account === intent.into) {
      if (relay.savedRelayAccount() !== intent.into) relay.setRelayAccount(intent.into, intent.provider ?? null);
      if (binding.listing_id !== undefined) await mailbox.complete(intent.into, binding.listing_id);
    }
    if (this.stopped || relay.currentIdentity()?.server_id !== identity.server_id) return pending;
    await mailbox.leaveMovedAccount(identity, intent.from.account);
    this.journal.remove(intent, () => true);
    return moved(intent.into);
  }
}

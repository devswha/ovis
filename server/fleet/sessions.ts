/**
 * The controller's fleet in one process (docs/fleet-link.md): the store, the live machine sessions and the local
 * forwards that turn connections into pipes. A RelaySession (server/relay/session.ts) on a relay link or a direct
 * carrier signs a machine in against `machines()` and is counted here through `admit`, apart from the 8 device
 * sessions of server/relay/admissions.ts: at most `max` machines (OVIS_FLEET_MAX, 100 by default, up to 1000) with a
 * session at once, one session per machine and a second one only for a switch (SWITCH_WINDOW_MS). Two sessions on one
 * key past that window are each asked a PING: one that does not answer is a dead carrier and is ended; two that both
 * answer (a cloned machine image) quarantine the machine and end both: the newer one never simply wins.
 * The newest session that advertised an endpoint takes every new pipe, and only while the machine is `active` (a
 * `pending` one waits for its batch to be confirmed); a machine's advert, with its bridge token and runtime bearer,
 * lives only in memory and goes with its session. New machines enrol through the invites (server/fleet/invites.ts).
 *
 * Every active machine has a forward (server/fleet/forward.ts), whether or not it is connected; one that is not
 * active, removed, or a store that was refused has none.
 */
import { FLEET_CAUSE_KIND } from "../../shared/fleet-cause.ts";
import type { FleetCause } from "../../shared/fleet-cause.ts";
import { MuxStreamError } from "../../shared/relay-mux-engine.ts";
import type { MuxClock } from "../../shared/relay-mux-engine.ts";
import { relayClock } from "../relay/session.ts";
import type { MachineAdmission, MachineSessions, RelaySession } from "../relay/session.ts";
import { MachineForward } from "./forward.ts";
import type { OpenedPipe } from "./forward.ts";
import { createHash, randomBytes } from "node:crypto";
import { FleetInvites, FleetRouteError } from "./invites.ts";
import type { EnrollResult, FleetAlert } from "./invites.ts";
import { MAX_PIPE_STREAMS } from "./mux-ext.ts";
import type { Enroll, FleetDirectory, FleetState, MachineCause, PipeAdvert, PipeStream, RelayPace } from "./mux-ext.ts";
import { defaultPaceSlot, PACE_REFRESH_MS, paceSpan, relayPace } from "./relay-pace.ts";
import type { RelayPaceProfile } from "./relay-pace.ts";
import { SignInQueue } from "./sign-in-queue.ts";
import { FleetStore, FleetStoreError } from "./store.ts";
import type { FleetDocument, FleetMachine } from "./store.ts";
import { FleetWitness, WitnessError, witnessDir } from "./witness.ts";

/** How long a machine may hold two sessions while it moves to a new carrier (docs/fleet-link.md section 5). */
export const SWITCH_WINDOW_MS = 10_000;
/**
 * How long each of a machine's two sessions has to answer a PING at the end of the switch window: only two sessions that
 * both answer are a cloned key; one that does not is a dead carrier (a half-open link) and is ended instead.
 */
export const SWITCH_PROBE_MS = 5_000;
/** How long a local connection waits for one of the machine's 16 pipes to be free before it is closed. */
export const PIPE_WAIT_MS = 30_000;
/**
 * The pace of what this controller sends a machine, under the receive limits of the machine's engine
 * (shared/relay-mux-engine.ts: 32 opens a second in a bucket of 64, 4096 frames a second in a bucket of 8192): opens at
 * 24 a second after a burst of 32, pipe DATA frames at 3072 a second after a burst of 2048 (the link agent's own pace,
 * crates/fleet-link/src/session.rs), so a burst of local connections or carrier delays bunching frames up cannot end
 * the session `resource_exhausted`. CREDIT, PING and the other control frames fit in what is left.
 */
export const OPEN_PACE = { rate: 24, burst: 32 } as const;
export const FRAME_PACE = { rate: 3072, burst: 2048 } as const;
/**
 * How long a machine this controller expects back counts as `reconnecting`: one whose pending session was let go when its
 * batch was confirmed (it signs in again at once), and, for the first RECONNECT_MS after this controller started, one
 * that was seen within SWEEP_MS + RECONNECT_MS before it (it was connected to the controller that stopped: a connected
 * machine's seen_at is refreshed every SWEEP_MS, and RECONNECT_MS is the slack for that timer's own lag). Its row says so, and a
 * launch waits for it (RECONNECT_WAIT_MS) instead of opening on a session that is going.
 */
export const RECONNECT_MS = 30_000;
/** How long a launch (a pipe, the native route) waits for a reconnecting machine before it is answered `reconnecting`. */
export const RECONNECT_WAIT_MS = 10_000;
/** First pause before trying again after a machine refused an open its count had not freed yet. */
const RETRY_MS = 25;
/** How often the vanish sweep looks for machines unseen past their batch's retention (todo 31). */
export const SWEEP_MS = 10 * 60_000;
/**
 * Silent-session events (the switch window's PING ended one session of a key while another answered) that quarantine
 * the key when they come this many times within SILENT_WINDOW_MS (todo 31, from the second check of todo 30).
 */
export const SILENT_QUARANTINE = 6;
export const SILENT_WINDOW_MS = 24 * 60 * 60_000;
/** What the Fleet screen and `ovis fleet list` say while the fleet is held as rolled back (todo 31). */
export const RESTORE_NOTICE = "This controller's fleet records are older than its witness";

/** What the operator is shown while the fleet is held as rolled back, and confirms by its digest. */
export interface RestoreView {
  readonly notice: string;
  /** why the fleet is held: `witness_newer`, `witness_missing`, `witness_unreadable`, `seen_state` or `restored_flag` */
  readonly reason: string;
  readonly store_generation: number | null;
  readonly witness_generation: number | null;
  /** SHA-256 over the sorted lines `<machine_id> removed|kept`, as 64 hex digits: what `POST /api/fleet/restore/confirm` sends */
  readonly digest: string;
  readonly machines: readonly { readonly machine_id: string; readonly name: string; readonly removed_after_backup: boolean; readonly quarantined_after_backup: boolean }[];
}

/** A token bucket whose takers wait their turn, first come first served. */
export class Pacer {
  private tokens: number;
  private updated: number;
  private readonly queue: { n: number; resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal }[] = [];
  private cancelTimer: (() => void) | undefined;

  constructor(private readonly rate: number, private readonly burst: number, private readonly clock: MuxClock) {
    this.tokens = burst;
    this.updated = clock.now();
  }

  /** Resolves once `n` tokens (at most the burst) were taken; rejects when `signal` aborts first. */
  take(n: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new MuxStreamError("cancelled"));
    const wanted = Math.min(Math.max(1, n), this.burst);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter = { n: wanted, resolve, reject, ...(signal ? { signal } : {}) };
    this.queue.push(waiter);
    signal?.addEventListener("abort", () => {
      const at = this.queue.indexOf(waiter);
      if (at < 0) return;
      this.queue.splice(at, 1);
      reject(new MuxStreamError("cancelled"));
      this.pump();
    }, { once: true });
    this.pump();
    return promise;
  }

  /** Ends every wait (the session ended). */
  stop(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    for (const waiter of this.queue.splice(0)) waiter.reject(new MuxStreamError("upstream_lost"));
  }

  private pump(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    const now = this.clock.now();
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, now - this.updated) * this.rate / 1000);
    this.updated = now;
    while (this.queue.length && this.queue[0]!.n <= this.tokens) {
      const waiter = this.queue.shift()!;
      this.tokens -= waiter.n;
      waiter.resolve();
    }
    const next = this.queue[0];
    if (next) this.cancelTimer = this.clock.setTimeout(() => this.pump(), Math.ceil((next.n - this.tokens) * 1000 / this.rate));
  }
}

/** One machine session the fleet counts: from its admission (AUTH verified) until it ends. */
interface Live {
  readonly machineId: string;
  readonly session: RelaySession;
  readonly order: number;
  committed: boolean;
  /** told to go (GOAWAY after its batch was confirmed): still draining, but no longer the machine's session */
  superseded: boolean;
  advert: PipeAdvert | undefined;
  /** The advert's `now` less this controller's wall clock when that advert arrived, in ms. */
  skewMs?: number;
  readonly pipes: Set<PipeStream>;
  readonly opens: Pacer;
  readonly frames: Pacer;
  cancelWindow?: () => void;
  /** the next PACE (every PACE_REFRESH_MS), and the slot the last one named */
  cancelPace?: () => void;
  paceSlot?: number;
}

/** Why a local connection gets no pipe: no session, or the newest one does not offer the endpoint. */
export class MachineUnavailable extends Error {
  constructor(readonly machineId: string, readonly reason: "offline" | "not_advertised" | "timeout" | "not_active" | "reconnecting") {
    super(`fleet machine ${machineId} is ${reason}`);
    this.name = "MachineUnavailable";
  }
}

export interface FleetOptions {
  readonly stateDir: string;
  /** The store; one of `stateDir` (server/fleet/store.ts) unless given. */
  readonly store?: FleetStore;
  /** Machines with a session at once; the store's (OVIS_FLEET_MAX) unless given. */
  readonly max?: number;
  readonly clock?: MuxClock;
  /** Whether forwards also open a Unix socket for `native` pipes; not on Windows (no Unix socket forward there). */
  readonly native?: boolean;
  /** Wall-clock ms since the epoch, for the times a machine's row shows (`clock` is monotonic); Date.now unless given. */
  readonly wall?: () => number;
  /**
   * This controller's relay identity (its server_id): the witness file is named by it (server/fleet/witness.ts). Without
   * it the fleet uses the server_id of the last machine session it admitted.
   */
  readonly serverId?: () => string | undefined;
  /** The witness folder; witnessDir() (OVIS_FLEET_WITNESS_DIR, else the user's state home) unless given. */
  readonly witnessDir?: string;
  /** Hold the fleet as rolled back at start (OVIS_FLEET_RESTORED=1 after restoring a whole-disk or VM snapshot). */
  readonly restored?: boolean;
  /**
   * Whether the server has a token (server/fleet/gate.ts). Without one the fleet is held: no sign-in, no enrolment, no
   * forward. False unless given; RelayService.resume sets it from the server's own token.
   */
  readonly tokenConfigured?: boolean;
}

/** What the fleet has seen of one machine, for its row (server/fleet/causes.ts): nothing here is a secret. */
export interface FleetObservation {
  readonly online: boolean;
  /** Whether this controller expects the machine back (RECONNECT_MS) and no session of it has advertised yet. */
  readonly reconnecting?: boolean;
  /**
   * The latest advert's health, and how far its `now` was from this controller's clock when it arrived (ms, positive
   * when the machine's is ahead), while a session of the machine is signed in.
   */
  readonly health: PipeAdvert["health"] | undefined;
  readonly clockSkewMs: number | undefined;
  /** A cause set by `report` or by a refusal, with when it was set. */
  readonly reported: { readonly cause: FleetCause; readonly since: number } | undefined;
  /** When a session of the machine last signed in or ended, or when this fleet started. */
  readonly changedAt: number;
  /** When the health its adverts report last changed (the first advert of a session counts), while it is signed in. */
  readonly healthSince: number | undefined;
  /** How the newest signed-in session reached this controller: a direct carrier or the relay; null while none is. */
  readonly route: "direct" | "relay" | null;
  /**
   * When a session of the machine was last signed in: now while one is, else when its last signed-in session ended;
   * null when none has been since this controller started (kept in memory only, as every session is).
   */
  readonly lastSeen: number | null;
}

export class Fleet implements FleetDirectory, MachineSessions {
  readonly store: FleetStore;
  /** The invites machines enrol through, on the same store and wall clock. */
  readonly invites: FleetInvites;
  readonly max: number;
  private readonly alertWatchers = new Set<(alert: FleetAlert) => void>();
  private readonly clock: MuxClock;
  private readonly native: boolean;
  private readonly live = new Map<string, Live[]>();
  private readonly forwards = new Map<string, Promise<MachineForward | undefined>>();
  private readonly opened = new Map<string, MachineForward>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly sessionWatchers = new Set<(machineId: string) => void>();
  /** forwards opening or closing after a store change */
  private readonly settling = new Set<Promise<unknown>>();
  /** Causes set by `report` or by a refusal, in memory only: a restart forgets them, as it forgets every session. */
  private readonly reported = new Map<string, { cause: FleetCause; since: number }>();
  /** When each machine's last session signed in or ended. */
  private readonly changed = new Map<string, number>();
  /** When each signed-in machine's advertised health last changed. */
  private readonly healthChanged = new Map<string, number>();
  /** When each machine's last signed-in session ended. */
  private readonly seen = new Map<string, number>();
  /** Machines this controller expects back, until when (its clock): see RECONNECT_MS. */
  private readonly expected = new Map<string, number>();
  private readonly wall: () => number;
  private readonly startedAt: number;
  private order = 0;
  private forwardIndex = 0;
  /** Every machine AUTH is verified through this (todo 37): 16 at a time, in order. */
  readonly signIns = new SignInQueue();
  /** The relay pace: the profile of the budget the relay named (30 when none), and its generation. */
  private profile: RelayPaceProfile = relayPace();
  private paceGeneration = 1;
  private started = false;
  private closed = false;
  private unwatch: (() => void) | undefined;
  private witnessCache: FleetWitness | undefined;
  private lastServerId: string | undefined;
  /** the identity whose start checks ran (the first sign-in, route or start that knew it) */
  private checked: string | undefined;
  private restoredFlag: boolean;
  private heldReason = "";
  /** the witness generation every connected machine was last told in FLEET_STATE */
  private toldGeneration = -1;
  private readonly silent = new Map<string, number[]>();
  private cancelSweep: (() => void) | undefined;
  private tokenConfigured: boolean;
  readonly stateDir: string;

  constructor(private readonly options: FleetOptions) {
    this.stateDir = options.stateDir;
    this.tokenConfigured = options.tokenConfigured ?? false;
    this.store = options.store ?? new FleetStore({ stateDir: options.stateDir });
    this.max = options.max ?? this.store.max;
    this.clock = options.clock ?? relayClock;
    this.native = options.native ?? process.platform !== "win32";
    this.wall = options.wall ?? Date.now;
    this.startedAt = this.wall();
    this.restoredFlag = options.restored ?? process.env["OVIS_FLEET_RESTORED"] === "1";
    this.invites = new FleetInvites(this.store, {
      now: () => this.wall(), onAlert: (alert) => this.raise(alert),
      witness: (document, removed, quarantined) => this.witnessed(document, removed, quarantined), listed: (machineId) => this.listed(machineId),
    });
    // the store is closed while the fleet is held: every writer, HTTP or not, meets the gate there (server/fleet/gate.ts)
    this.store.holdWhile(() => this.held());
  }

  // ---- the witness and the rolled-back hold (todo 31) ----

  private serverIdNow(): string | undefined { return this.options.serverId?.() ?? this.lastServerId; }

  /**
   * The id of the witness that speaks for `document`: the one it records, else this controller's server_id, else (no
   * relay identity was ever made) a new random one, recorded with the first witness written.
   */
  private witnessId(document: FleetDocument | undefined): string {
    return document?.witness_id ?? this.serverIdNow() ?? (this.unnamed ??= randomBytes(16).toString("hex"));
  }
  private unnamed: string | undefined;

  /** This fleet's witness; WitnessError when its file cannot be read. */
  witness(document?: FleetDocument): FleetWitness {
    let current = document;
    if (!current) try { current = this.store.document(); } catch { current = undefined; }
    const id = this.witnessId(current);
    if (this.witnessCache?.serverId !== id) this.witnessCache = new FleetWitness(id, this.options.witnessDir ?? witnessDir());
    return this.witnessCache;
  }

  private witnessOrUndefined(): FleetWitness | undefined {
    try { return this.witness(); } catch { return undefined; }
  }

  /**
   * Inside a store change: the witness is written first, its generation risen by one past both its own and the store's
   * and `removed` added, then the store records that generation. A witness that cannot be written throws (as a
   * FleetRouteError), so the change is refused whole.
   */
  private witnessed(document: FleetDocument, removed: readonly string[], quarantined: readonly string[] = []): FleetDocument {
    try {
      const witness = this.witness(document);
      const next = witness.write({ generation: Math.max(witness.generation, document.generation ?? 0) + 1, add: removed, quarantine: quarantined, at: this.wall() });
      return { ...document, generation: next.generation, witness_id: witness.serverId };
    } catch (error) {
      if (error instanceof WitnessError) throw new FleetRouteError(error.code === "witness_full" ? "witness_full" : "witness_write_failed", error.message);
      throw error;
    }
  }

  /**
   * The checks at start, once per identity: the fleet is held as rolled back when OVIS_FLEET_RESTORED=1 was set, when
   * the witness's generation is above the store's, when the witness is missing (or unreadable) while the store, written
   * under a witness, holds machines. A store no witness spoke for yet (written before todo 31) takes the witness's
   * generation, or a new witness at 0.
   */
  private check(migrate = true): void {
    // a fleet without a token is held and writes nothing (todo 60): the checks wait for a start with one
    if (this.held()) return;
    let document: FleetDocument;
    try { document = this.store.document(); } catch { return; }
    // a store no witness spoke for waits for this controller's identity to name its first witness
    if (document.witness_id === null && !this.serverIdNow() && !document.machines.length) return;
    const id = this.witnessId(document);
    if (this.checked === id) { if (migrate) this.migrate(document); return; }
    this.checked = id;
    let witness: FleetWitness | undefined;
    let reason: string | undefined;
    try { witness = this.witness(document); }
    catch { reason = "witness_unreadable"; }
    if (this.restoredFlag) reason = "restored_flag";
    else if (witness && document.generation !== null) {
      if (witness.exists && witness.generation > document.generation) reason = "witness_newer";
      else if (!witness.exists && document.machines.length) reason = "witness_missing";
    }
    this.restoredFlag = false;
    if (reason) { this.hold(reason); return; }
    if (migrate) this.migrate(document);
  }

  /** A store no witness spoke for yet (written before todo 31) takes the witness's generation, or a new witness at 0. */
  private migrate(document: FleetDocument): void {
    if (document.generation !== null || !document.machines.length || document.hold || this.heldInMemory) return;
    let witness: FleetWitness;
    try { witness = this.witness(document); } catch { return; }
    try {
      this.store.update((current) => {
        if (current.generation !== null) return { document: current, result: undefined };
        const made = witness.exists ? witness.generation : witness.write({ generation: 0, at: this.wall() }).generation;
        return { document: { ...current, generation: made, witness_id: witness.serverId }, result: undefined };
      });
    } catch (error) { console.error(`Fleet witness: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Holds the fleet as rolled back: kept in the store across restarts, every machine session ends `restored`, no forward. */
  private hold(reason: string): void {
    this.heldReason = reason;
    try { this.store.update((current) => current.hold ? { document: current, result: undefined } : { document: { ...current, hold: true }, result: undefined }); }
    catch (error) { console.error(`Fleet: the rolled-back hold could not be saved (${error instanceof Error ? error.message : String(error)}); it holds until this server stops.`); this.heldInMemory = true; }
    console.error(JSON.stringify({ event: "fleet.rolled_back", reason }));
    for (const [machineId, lives] of [...this.live]) {
      this.report(machineId, "restored");
      for (const entry of [...lives]) entry.session.closeMachine("auth_failed", "restored");
    }
    this.reconcile();
  }
  private heldInMemory = false;

  /** Whether the fleet is held as rolled back (todo 31): no machine signs in and no forward opens until the operator confirms. */
  rolledBack(): boolean {
    this.check(false);
    if (this.heldInMemory) return true;
    try { return this.store.document().hold; } catch { return false; }
  }

  /** Whether `machineId` is a key this controller removed (its witness lists it). */
  removed(machineId: string): boolean {
    return this.listed(machineId) === "revoked";
  }

  /**
   * What the witness says of a key, whatever the store says: `revoked` (removed, revoked or replaced) or `quarantined`.
   * A sign-in and an ENROLL of such a key are refused with it, also after a restore and a confirmation (todo 31).
   */
  listed(machineId: string): "revoked" | "quarantined" | undefined {
    this.check(false);
    const witness = this.witnessOrUndefined();
    return witness?.isRemoved(machineId) ? "revoked" : witness?.isQuarantined(machineId) ? "quarantined" : undefined;
  }

  /** What the operator confirms while the fleet is held, or undefined when it is not. */
  restoreView(): RestoreView | undefined {
    if (!this.rolledBack()) return undefined;
    const witness = this.witnessOrUndefined();
    const document = this.store.document();
    const machines = document.machines.filter((machine) => machine.state !== "revoked")
      .map((machine) => ({
        machine_id: machine.machine_id, name: machine.name, removed_after_backup: witness?.isRemoved(machine.machine_id) ?? false,
        quarantined_after_backup: machine.state !== "quarantined" && (witness?.isQuarantined(machine.machine_id) ?? false),
      }))
      .sort((a, b) => a.machine_id.localeCompare(b.machine_id));
    const mark = (machine: RestoreView["machines"][number]) => machine.removed_after_backup ? "removed" : machine.quarantined_after_backup ? "quarantined" : "kept";
    const digest = createHash("sha256").update(machines.map((machine) => `${machine.machine_id} ${mark(machine)}\n`).join("")).digest("hex");
    return {
      notice: RESTORE_NOTICE, reason: this.heldReason || "held", store_generation: document.generation,
      witness_generation: witness?.exists ? witness.generation : null, digest, machines,
    };
  }

  /**
   * `POST /api/fleet/restore/confirm {digest}`: confirms the list the operator was shown (its digest), raises the store
   * to the witness's generation (making the witness when it is missing) and lets the machines in, except every key the
   * witness lists as removed: each of those stays refused `auth_revoked` until it is re-admitted on its own.
   */
  confirmRestore(digest: string): { readonly generation: number; readonly machines: number } {
    const view = this.restoreView();
    if (!view) throw new FleetRouteError("not_restored", "The fleet is not held as rolled back: there is nothing to confirm.");
    if (view.digest !== digest) throw new FleetRouteError("restore_changed", "The list changed since it was read: read it again and check its machines.");
    let witness: FleetWitness;
    try { witness = this.witness(); }
    catch (error) { throw new FleetRouteError("witness_write_failed", error instanceof Error ? error.message : String(error)); }
    const generation = this.store.update((current) => {
      let made: number;
      try { made = witness.write({ generation: Math.max(witness.generation, current.generation ?? 0), at: this.wall() }).generation; }
      catch (error) { throw new FleetRouteError("witness_write_failed", error instanceof Error ? error.message : String(error)); }
      return { document: { ...current, generation: made, hold: false, witness_id: witness.serverId }, result: made };
    });
    this.heldInMemory = false;
    this.heldReason = "";
    for (const [machineId, held] of [...this.reported]) if (held.cause === "restored") this.report(machineId, null);
    console.error(JSON.stringify({ event: "fleet.restore_confirmed", generation }));
    this.reconcile();
    return { generation, machines: view.machines.length };
  }

  /**
   * `POST /api/fleet/machines/<id>/readmit`: takes one key off the witness's removed list, so it may sign in again (after
   * a restore, once the operator also confirmed); a revoked record of it becomes `active` again.
   */
  readmit(machineId: string): { readonly machine_id: string; readonly state: string } {
    let witness: FleetWitness;
    try { witness = this.witness(); }
    catch (error) { throw new FleetRouteError("witness_write_failed", error instanceof Error ? error.message : String(error)); }
    const record = this.store.get(machineId);
    if (!witness.isRemoved(machineId) && record?.state !== "revoked") throw new FleetRouteError("not_removed", "That key was not removed.");
    return this.store.update((current) => {
      try { if (witness.isRemoved(machineId)) witness.write({ drop: [machineId], at: this.wall() }); }
      catch (error) { throw new FleetRouteError("witness_write_failed", error instanceof Error ? error.message : String(error)); }
      const found = current.machines.find((machine) => machine.machine_id === machineId);
      console.error(JSON.stringify({ event: "fleet.readmitted", machine_id: machineId }));
      if (!found) return { document: current, result: { machine_id: machineId, state: "forgotten" } };
      if (found.state !== "revoked") return { document: current, result: { machine_id: machineId, state: found.state } };
      const moved = { ...found, state: "active" as const, updated_at: this.wall() };
      return { document: { ...current, machines: current.machines.map((machine) => machine === found ? moved : machine) }, result: { machine_id: machineId, state: "active" } };
    });
  }

  /**
   * `DELETE /api/fleet/machines/<id>`: revokes the machine (its key into the witness's removed list, the generation
   * risen, the store's record `revoked`): its live sessions end `auth_revoked`, its forward closes, its roster row goes,
   * and its programs keep running on the machine. Removing a revoked machine again forgets its record (the tombstone):
   * the witness keeps its key refused. FleetRouteError `unknown_machine` for an id the store does not hold.
   */
  removeMachine(machineId: string, reason: "removed" | "vanished" = "removed"): { readonly machine_id: string; readonly name: string; readonly state: "revoked" | "forgotten" } {
    this.check();
    type Removed = { readonly machine_id: string; readonly name: string; readonly state: "revoked" | "forgotten" };
    const result = this.storeChange<Removed>((current) => {
      const found = current.machines.find((machine) => machine.machine_id === machineId);
      if (!found) throw new FleetRouteError("unknown_machine", "No machine has that id.");
      const listed = this.witnessOrUndefined()?.isRemoved(machineId) ?? false;
      if (found.state === "revoked") {
        // a slot the tombstone still holds is retired, as store.remove does for a machine removed offline: it may still
        // dial on it, so the slot goes out last (todo 37)
        const retired = found.pace_slot === undefined ? current.retired_pace_slots : [...current.retired_pace_slots ?? [], found.pace_slot];
        const left = { ...current, machines: current.machines.filter((machine) => machine !== found), ...(retired?.length ? { retired_pace_slots: retired } : {}) };
        return { document: listed ? left : this.witnessed(left, [machineId]), result: { machine_id: machineId, name: found.name, state: "forgotten" as const } };
      }
      const moved = { ...found, state: "revoked" as const, updated_at: this.wall() };
      const next = { ...current, machines: current.machines.map((machine) => machine === found ? moved : machine) };
      return { document: this.witnessed(next, [machineId]), result: { machine_id: machineId, name: found.name, state: "revoked" as const } };
    });
    console.error(JSON.stringify({ event: result.state === "forgotten" ? "fleet.forgotten" : `fleet.${reason}`, machine_id: machineId, name: result.name }));
    return result;
  }

  /**
   * `POST /api/fleet/slots/<slot>/release`: the operator's explicit release of a quarantined slot. Its quarantined key
   * is revoked (into the witness), so the slot may be enrolled again with a new invite (`ovis fleet invite
   * --slots-from`); nothing else ever lifts a quarantine. FleetRouteError `unknown_slot` or `slot_not_quarantined`.
   */
  release(slot: number): { readonly slot: number; readonly revoked: readonly string[] } {
    this.check();
    const result = this.storeChange((current) => {
      const holders = current.machines.filter((machine) => machine.slot === slot);
      if (!holders.length && !current.invites.some((entry) => entry.slot === slot)) throw new FleetRouteError("unknown_slot", "No machine or invite has that slot.");
      // also a key the witness holds in quarantine where a restored store no longer does
      const witness = this.witnessOrUndefined();
      const quarantined = holders.filter((machine) => machine.state === "quarantined" || (machine.state !== "revoked" && (witness?.isQuarantined(machine.machine_id) ?? false)));
      if (!quarantined.length) throw new FleetRouteError("slot_not_quarantined", "That slot is not in quarantine.");
      const ids = quarantined.map((machine) => machine.machine_id);
      const next = { ...current, machines: current.machines.map((machine) => ids.includes(machine.machine_id) ? { ...machine, state: "revoked" as const, updated_at: this.wall() } : machine) };
      return { document: this.witnessed(next, ids), result: { slot, revoked: ids } };
    });
    console.error(JSON.stringify({ event: "fleet.slot_released", ...result }));
    return result;
  }

  /**
   * The vanish sweep (every SWEEP_MS, and on demand): every machine that is pending or active, not connected, and unseen
   * for longer than its batch's retention (`retention_s`, 0 keeps it; a machine of no batch is kept) is removed as
   * DELETE removes it, and logged `fleet.vanished`. A quarantined machine is left for the operator. Answers the ids removed.
   */
  sweep(): readonly string[] {
    this.check();
    // nothing without a token (todo 60) and nothing while rolled back
    if (this.held() || this.rolledBack()) return [];
    const now = this.wall();
    let ids: string[] = [];
    try {
      ids = this.storeChange((current) => {
        const retention = new Map(current.batches.map((entry) => [entry.id, entry.retention_s]));
        const batchOf = new Map(current.invites.map((entry) => [entry.id, entry.batch_id]));
        const gone = current.machines.filter((machine) => {
          if ((machine.state !== "active" && machine.state !== "pending") || this.online(machine.machine_id) || machine.invite_id === null) return false;
          const batchId = batchOf.get(machine.invite_id);
          const keep = batchId === undefined ? 0 : retention.get(batchId) ?? 0;
          return keep > 0 && now - (machine.seen_at ?? machine.created_at) > keep * 1000;
        }).map((machine) => machine.machine_id);
        if (!gone.length) return { document: current, result: gone };
        const next = { ...current, machines: current.machines.map((machine) => gone.includes(machine.machine_id) ? { ...machine, state: "revoked" as const, updated_at: now } : machine) };
        return { document: this.witnessed(next, gone), result: gone };
      });
    } catch (error) {
      console.error(`Fleet sweep: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    for (const machineId of ids) console.error(JSON.stringify({ event: "fleet.vanished", machine_id: machineId }));
    return ids;
  }

  /** A store change whose refusals reach the routes as FleetRouteError. */
  private storeChange<T>(apply: (document: FleetDocument) => { document: FleetDocument; result: T }): T {
    try { return this.store.update(apply); }
    catch (error) {
      if (error instanceof FleetStoreError) {
        if (error.code === "fleet_token_required") throw new FleetRouteError("fleet_token_required", "The fleet needs OVIS_TOKEN on this server: set it and restart Ovis. Nothing was changed.");
        throw new FleetRouteError(error.code === "busy" ? "fleet_store_busy" : "fleet_store_unreadable", error.code === "busy" ? "The fleet's store is busy; try again." : "The fleet's store cannot be read; mend or move it away.");
      }
      throw error;
    }
  }

  /** FLEET_STATE to one signed-in session: the witness's generation and its tag for the session's server_id. */
  private tell(entry: Live): void {
    const witness = this.witnessOrUndefined();
    if (!witness?.exists) return;
    const tag = witness.tag(entry.session.serverId, witness.generation);
    if (tag) entry.session.sendFleetState({ generation: witness.generation, tag: tag.toString("base64url") });
  }

  /** After a store change: each rise of the generation goes to every connected machine. */
  private tellAll(): void {
    let generation: number | null;
    try { generation = this.store.document().generation; } catch { return; }
    if (generation === null || generation <= this.toldGeneration) return;
    this.toldGeneration = generation;
    for (const lives of this.live.values()) for (const entry of lives) if (entry.committed) this.tell(entry);
  }

  /**
   * Records when a session of the machine signed in or ended: the vanish sweep's clock. At a sign-in only when the record
   * is older than SWEEP_MS (a wave of sign-ins costs no store write each; a connected machine is never swept anyway).
   */
  private recordSeen(machineId: string, signIn = false): void {
    const at = this.wall();
    try {
      const held = this.store.get(machineId)?.seen_at;
      if (signIn && held !== null && held !== undefined && at - held < SWEEP_MS) return;
    } catch { return; }
    // a wave of sign-ins and ends is one store write
    this.seenDue.set(machineId, at);
    if (this.seenDue.size === 1) setImmediate(() => this.writeSeen());
  }
  private readonly seenDue = new Map<string, number>();

  private writeSeen(): void {
    const due = new Map(this.seenDue);
    this.seenDue.clear();
    if (!due.size || this.closed) return;
    try {
      this.store.update((current) => {
        if (!current.machines.some((machine) => due.has(machine.machine_id) && machine.seen_at !== due.get(machine.machine_id))) return { document: current, result: undefined };
        return { document: { ...current, machines: current.machines.map((machine) => due.has(machine.machine_id) ? { ...machine, seen_at: due.get(machine.machine_id)! } : machine) }, result: undefined };
      });
    } catch { /* the sweep then counts from the last time it could be written: it removes later, never sooner */ }
  }

  /** An ENROLL on a machine session (server/relay/session.ts MachineEnrolment). */
  enroll(request: Enroll, context: { readonly binding: Uint8Array; readonly source?: string }): Promise<EnrollResult> {
    return this.invites.enroll(request, context);
  }

  /** Invites unused and not expired: the fleet is in use while there is one (server/fleet/direct.ts fleetInUse). */
  openInvites(): number { return this.invites.openInvites(); }

  /** Hears of each alert: a slot or a machine quarantined. */
  onAlert(watcher: (alert: FleetAlert) => void): () => void {
    this.alertWatchers.add(watcher);
    return () => { this.alertWatchers.delete(watcher); };
  }

  private raise(alert: FleetAlert): void {
    if (alert.machine_id) {
      const held = this.alerted.get(alert.machine_id);
      this.alerted.set(alert.machine_id, { count: (held?.count ?? 0) + 1, last: this.wall() });
      this.told(alert.machine_id);
    }
    for (const watcher of [...this.alertWatchers]) watcher(alert);
  }
  /** Alerts raised per machine since this controller started, with when the last came: what its row shows (todo 31). */
  private readonly alerted = new Map<string, { count: number; last: number }>();
  alerts(machineId: string): { readonly count: number; readonly last: number } | undefined { return this.alerted.get(machineId); }

  /**
   * One key held two live sessions past the switch window (a cloned image): the machine is quarantined, which ends both
   * (each session follows the store, server/relay/session.ts), and an alert is raised. A store that cannot be written
   * still ends both, with the same cause.
   */
  /**
   * A machine still holds two sessions at the end of the switch window. This controller has no keepalive of its own on a
   * machine session, so a carrier that died without closing (a half-open link: NAT rebinding, an address change) still
   * counts until the relay or the socket gives up, while the machine has already dialed again. So each session is asked
   * a PING first: one that does not answer within SWITCH_PROBE_MS is ended `timeout` and the machine keeps the other;
   * only two that both answer (two live holders of one key: a cloned image) quarantine it. A relay or anyone on the path
   * cannot answer for a session: a PONG travels inside the channel.
   */
  private async proveLive(machineId: string, lives: readonly Live[]): Promise<void> {
    const probed = [...lives];
    const answered = await Promise.all(probed.map((entry) => this.answers(entry)));
    probed.forEach((entry, index) => { if (!answered[index] && lives.includes(entry)) entry.session.close("timeout"); });
    const alive = probed.filter((entry, index) => answered[index] && lives.includes(entry));
    if (alive.length > 1) this.quarantine(machineId, alive);
    else if (alive.length === 1 && answered.some((answer) => !answer)) this.silentSession(machineId, alive);
  }

  /**
   * One session of the key answered and another did not (todo 31): a copy of the key whose holder stays silent, or a
   * real machine whose answer someone on its path held back. Either is told to the operator as an alert; the
   * SILENT_QUARANTINE-th such event within SILENT_WINDOW_MS quarantines the key, so neither case can repeat for ever.
   */
  private silentSession(machineId: string, alive: readonly Live[]): void {
    const now = this.wall();
    const events = (this.silent.get(machineId) ?? []).filter((at) => now - at < SILENT_WINDOW_MS);
    events.push(now);
    this.silent.set(machineId, events);
    const record = this.store.get(machineId);
    const alert: FleetAlert = { kind: "alert", reason: "silent_session", machine_id: machineId, slot: record?.slot ?? null, invite_id: record?.invite_id ?? null, count: events.length };
    console.error(JSON.stringify({ event: "fleet.alert", ...alert }));
    this.raise(alert);
    if (events.length >= SILENT_QUARANTINE) {
      this.silent.delete(machineId);
      this.quarantine(machineId, alive, "silent_sessions");
    }
  }

  /** Whether the session answers a PING within SWITCH_PROBE_MS. */
  private answers(entry: Live): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const cancel = this.clock.setTimeout(() => resolve(false), SWITCH_PROBE_MS);
    void entry.session.mux.measure().then((rtt) => { cancel(); resolve(rtt !== undefined); });
    return promise;
  }

  private quarantine(machineId: string, lives: readonly Live[], reason: "two_sessions" | "silent_sessions" = "two_sessions"): void {
    const record = this.store.get(machineId);
    const alert: FleetAlert = { kind: "quarantined", reason, machine_id: machineId, slot: record?.slot ?? null, invite_id: record?.invite_id ?? null };
    console.error(JSON.stringify({ event: "fleet.quarantined", ...alert }));
    try {
      // the generation rises with a quarantine (todo 31); a witness that cannot be written still leaves it quarantined
      try { this.storeChange((current) => this.quarantined(current, machineId, true)); }
      catch (error) { if (!(error instanceof FleetRouteError) || !error.code.startsWith("witness")) throw error; this.storeChange((current) => this.quarantined(current, machineId, false)); }
    } catch (error) { console.error(`Fleet machine ${machineId}: its quarantine could not be saved (${error instanceof Error ? error.message : String(error)}).`); }
    for (const entry of [...lives]) entry.session.closeMachine("auth_revoked", "quarantined");
    this.raise(alert);
  }

  private quarantined(current: FleetDocument, machineId: string, witness: boolean): { document: FleetDocument; result: undefined } {
    const found = current.machines.find((machine) => machine.machine_id === machineId);
    if (!found || found.state === "quarantined" || found.state === "revoked") return { document: current, result: undefined };
    const next = { ...current, machines: current.machines.map((machine) => machine === found ? { ...found, state: "quarantined" as const, updated_at: this.wall() } : machine) };
    return { document: witness ? this.witnessed(next, [], [machineId]) : next, result: undefined };
  }

  /** Opens the forwards of the active machines and follows the store from here on; the vanish sweep runs every SWEEP_MS. */
  /** Whether the fleet is held for want of a token (server/fleet/gate.ts). */
  held(): boolean { return !this.tokenConfigured; }

  /** Sets whether the server has a token (once, before `start`: a server's token does not change while it runs). */
  setTokenConfigured(configured: boolean): void {
    this.tokenConfigured = configured;
    if (this.started) this.reconcile();
  }

  /** Opens the forwards of the active machines and follows the store from here on. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    // machines made active before pace slots existed get theirs now, before any of them signs in (todo 37)
    try { this.store.backfillPaceSlots(); } catch (error) { console.error(`Fleet store: pace slots not given (${error instanceof Error ? error.message : String(error)}).`); }
    // a launch waiting for a machine looks again at once: one revoked or removed meanwhile is refused now, not at its bound
    this.unwatch = this.store.onChange(() => { this.reconcile(); this.tellAll(); for (const machineId of [...this.waiters.keys()]) this.wake(machineId); });
    this.check();
    this.expectReturning();
    this.reconcile();
    // a connected machine's seen_at is kept within SWEEP_MS, so the next start knows it was connected (RECONNECT_MS)
    const sweep = () => { this.cancelSweep = this.clock.setTimeout(() => { this.refreshSeen(); this.sweep(); sweep(); }, SWEEP_MS); };
    sweep();
  }

  machines(): readonly FleetMachine[] { return this.store.machines(); }
  onChange(change: () => void): () => void { return this.store.onChange(change); }

  /** Tells `change` of each machine whose sessions changed: one signed in, advertised again or ended (the roster follows them). */
  onSession(change: (machineId: string) => void): () => void {
    this.sessionWatchers.add(change);
    return () => { this.sessionWatchers.delete(change); };
  }

  /** The relay pace now: what AUTH_OK and PACE name. */
  get pace(): RelayPaceProfile & { readonly generation: number; readonly span: number } {
    return { ...this.profile, generation: this.paceGeneration, span: paceSpan(this.max, this.profile.machine_per_minute) };
  }

  /**
   * The budget the relay named in `sync` (`per_address_per_minute`; undefined when it names none, which counts as 30).
   * A pace that changes raises the generation and goes to every connected machine at once.
   */
  setRelayBudget(budget: number | undefined): void {
    const next = relayPace(budget);
    if (next.machine_per_minute === this.profile.machine_per_minute && next.burst === this.profile.burst) return;
    this.profile = next;
    this.paceGeneration++;
    for (const lives of this.live.values()) for (const entry of lives) if (entry.committed) this.sendPace(entry.machineId, entry);
  }

  /** The relay pace for `machineId` (docs/fleet-link.md section 1, todo 37), stamped with this controller's clock now. */
  paceFor(machineId: string, rttMs: number): RelayPace {
    const { generation, machine_per_minute: per_minute, burst, span } = this.pace;
    let slot: number | undefined;
    try { slot = this.store.get(machineId)?.pace_slot; } catch { slot = undefined; }
    return {
      generation, per_minute, burst, slot: (slot ?? defaultPaceSlot(machineId)) % span, span,
      controller_ms: Math.round(this.wall()), rtt_ms: Math.min(60_000, Math.max(0, Math.round(rttMs))),
    };
  }

  /** A PACE to one signed-in session: its keepalive measures the round trip first; then again every PACE_REFRESH_MS. */
  private sendPace(machineId: string, entry: Live): void {
    // an agent that did not announce `pace` refuses a PACE frame: it has AUTH_OK's relay_pace and nothing more
    if (!entry.session.readsPace) return;
    entry.cancelPace?.();
    entry.cancelPace = this.clock.setTimeout(() => this.sendPace(machineId, entry), PACE_REFRESH_MS);
    const mux = entry.session.mux;
    void mux.measure().then((rtt) => {
      if (!entry.committed || !mux.active) return;
      const pace = this.paceFor(machineId, rtt ?? mux.rttMs ?? 60_000);
      entry.paceSlot = pace.slot;
      entry.session.sendPace(pace);
    });
  }

  admit(machineId: string, session: RelaySession, seen?: FleetState): MachineAdmission | { readonly code: "resource_exhausted" | "auth_revoked" | "auth_failed"; readonly cause: MachineCause } {
    const serverId = (session as Partial<RelaySession>).serverId;
    if (serverId) this.lastServerId = serverId;
    this.check();
    const witness = this.witnessOrUndefined();
    // a key the witness lists as removed or quarantined is refused at all times, also after a restore was confirmed (todo 31)
    const listed = this.listed(machineId);
    if (listed) return { code: "auth_revoked", cause: listed };
    // a machine that saw a newer generation than this store's: the store was put back from an older copy. The proven
    // generation goes into the witness first (outside the folder), so the confirmation rises to it and the same machine
    // never holds the fleet again with what it proved once
    let generation: number | null = null;
    try { generation = this.store.document().generation; } catch { /* a refused store signs nobody in anyway */ }
    if (seen && serverId && witness && witness.verifies(serverId, seen.generation, seen.tag)) {
      if (seen.generation > witness.generation) {
        // inside a store change, as every witness write, so no other writer of the store runs between
        try { this.store.update((current) => { if (seen.generation > witness.generation) witness.write({ generation: seen.generation, at: this.wall() }); return { document: current, result: undefined }; }); }
        catch (error) { console.error(`Fleet witness: the generation a machine proved could not be recorded (${error instanceof Error ? error.message : String(error)}).`); }
      }
      if (seen.generation > (generation ?? 0) && !this.rolledBack()) this.hold("seen_state");
    }
    if (this.rolledBack()) { this.report(machineId, "restored"); return { code: "auth_failed", cause: "restored" }; }
    const lives = this.live.get(machineId) ?? [];
    // a second session only for a switch; past `max` machines a new one is refused, a connected one may still switch
    if (lives.length >= 2 || (lives.length === 0 && this.live.size >= this.max)) {
      this.refused(machineId, "controller_limit");
      return { code: "resource_exhausted", cause: "controller_limit" };
    }
    const entry: Live = {
      machineId, session, order: ++this.order, committed: false, superseded: false, advert: undefined, pipes: new Set(),
      opens: new Pacer(OPEN_PACE.rate, OPEN_PACE.burst, this.clock), frames: new Pacer(FRAME_PACE.rate, FRAME_PACE.burst, this.clock),
    };
    lives.push(entry);
    this.live.set(machineId, lives);
    let ended = false;
    let refusedWith: MachineCause | undefined;
    return {
      committed: () => {
        if (ended) return;
        entry.committed = true;
        this.changed.set(machineId, this.wall());
        // a connection ends whatever stopped this machine from making one; a warning stays until it is cleared
        if (!lives.some((other) => other !== entry && other.committed)) this.clearStopping(machineId);
        this.told(machineId);
        // the machine keeps the newest FLEET_STATE and presents it at its next sign-in (todo 31)
        this.tell(entry);
        this.recordSeen(machineId, true);
        // its PACE with a measured round trip (before any liveness check can end the session), and every PACE_REFRESH_MS
        this.sendPace(machineId, entry);
        this.wake(machineId);
        // two at once past the window: each must prove it is alive; two that do are a cloned key
        if (lives.some((other) => other !== entry)) {
          entry.cancelWindow = this.clock.setTimeout(() => {
            if (!ended && lives.length > 1) void this.proveLive(machineId, lives);
          }, SWITCH_WINDOW_MS);
        }
      },
      advert: (advert) => {
        if (ended) return;
        const before = entry.advert?.health;
        if (before === undefined || before.runtime !== advert.health.runtime || before.bridge !== advert.health.bridge) this.healthChanged.set(machineId, this.wall());
        entry.advert = advert;
        entry.skewMs = advert.now * 1000 - this.wall();
        // the machine is back: a launch that waited for it goes on now
        if (!entry.superseded) this.expected.delete(machineId);
        this.wake(machineId);
        this.told(machineId);
      },
      ended: () => {
        if (ended) return;
        ended = true;
        entry.cancelWindow?.();
        entry.cancelPace?.();
        entry.advert = undefined;
        entry.opens.stop();
        entry.frames.stop();
        if (entry.committed) this.seen.set(machineId, this.wall());
        lives.splice(lives.indexOf(entry), 1);
        for (const other of lives) { other.cancelWindow?.(); other.cancelWindow = undefined; }
        if (!lives.length && this.live.get(machineId) === lives) this.live.delete(machineId);
        // a machine sent away for want of a place has no session left to say so: the refusal is its cause
        if (!lives.some((other) => other.committed)) {
          this.changed.set(machineId, this.wall());
          this.healthChanged.delete(machineId);
          if (refusedWith === "controller_limit") this.refused(machineId, refusedWith);
          if (entry.committed) this.recordSeen(machineId);
        }
        this.wake(machineId);
        this.told(machineId);
      },
      refused: (cause) => { refusedWith = cause; },
      superseded: () => {
        if (ended || entry.superseded) return;
        entry.superseded = true;
        // it drains for a moment, but takes no new pipe and is no longer shown online: the machine signs in again at once
        this.expected.set(machineId, this.clock.now() + RECONNECT_MS);
        this.changed.set(machineId, this.wall());
        this.wake(machineId);
        this.told(machineId);
      },
    };
  }

  /**
   * At start: each active machine seen within SWEEP_MS + RECONNECT_MS before this controller started was connected to the
   * one that stopped, and dials again; it counts as reconnecting for RECONNECT_MS.
   */
  private expectReturning(): void {
    if (this.held()) return;
    let machines: readonly FleetMachine[];
    try { machines = this.store.machines(); } catch { return; }
    const by = this.clock.now() + RECONNECT_MS;
    for (const machine of machines) {
      if (machine.state !== "active" || machine.seen_at === null || this.startedAt - machine.seen_at > SWEEP_MS + RECONNECT_MS) continue;
      if (!this.live.has(machine.machine_id)) this.expected.set(machine.machine_id, by);
    }
  }

  /** Every connected machine's seen_at to now (one store write): what the next start reads (expectReturning). */
  private refreshSeen(): void {
    for (const machineId of this.live.keys()) if (this.online(machineId)) this.seenDue.set(machineId, this.wall());
    if (this.seenDue.size) this.writeSeen();
  }

  /**
   * Whether this controller expects the machine back (RECONNECT_MS) and no session of it that is not going has advertised
   * yet: its row says `reconnecting` while it is not signed in, and a launch waits (`reconnected`).
   */
  reconnecting(machineId: string): boolean {
    const by = this.expected.get(machineId);
    if (by === undefined) return false;
    if (this.clock.now() >= by) { this.expected.delete(machineId); return false; }
    try { if (this.store.get(machineId)?.state !== "active") return false; } catch { return false; }
    return this.newest(machineId)?.advert === undefined;
  }

  /**
   * Waits while the machine is reconnecting, at most RECONNECT_WAIT_MS: true once it is not (back, or no longer
   * expected), false when it still is. Rejects `cancelled` when `signal` aborts.
   */
  async reconnected(machineId: string, signal?: AbortSignal): Promise<boolean> {
    const by = this.clock.now() + RECONNECT_WAIT_MS;
    while (this.reconnecting(machineId)) {
      const until = Math.min(by, this.expected.get(machineId)!);
      if (this.clock.now() >= until) return !this.reconnecting(machineId);
      await this.wait(machineId, until, undefined, signal);
    }
    return true;
  }

  /** A machine the controller refused with `cause` after its key was verified: its row says so until it signs in. */
  refused(machineId: string, cause: MachineCause): void {
    // a machine that is connected on another session keeps that: the refused one was a switch past its window
    if (cause === "controller_limit" && !this.online(machineId)) this.report(machineId, cause);
  }

  /**
   * Sets (or, with null, clears) the cause a machine's row shows beyond what the store and its advert say. The causes no
   * code of this controller observes yet are set here by the todo that does: `restored` (todo 31), `update_failed` and
   * `version_mismatch` (todo 59). Setting the cause a machine already has keeps its `since`.
   */
  report(machineId: string, cause: FleetCause | null): void {
    if (cause === null) { if (this.reported.delete(machineId)) this.told(machineId); return; }
    if (this.reported.get(machineId)?.cause === cause) return;
    this.reported.set(machineId, { cause, since: this.wall() });
    // the roster's row shows the cause too
    this.told(machineId);
  }

  /** What the fleet has seen of a machine (no secret): the row of server/fleet/causes.ts is made from it and the store. */
  observe(machineId: string): FleetObservation {
    const advert = this.advert(machineId);
    const online = this.online(machineId);
    const newest = online ? this.newest(machineId) : undefined;
    return {
      online, reconnecting: !online && this.reconnecting(machineId), health: online ? advert?.health : undefined, clockSkewMs: online ? this.newest(machineId)?.skewMs : undefined,
      reported: this.reported.get(machineId), changedAt: this.changed.get(machineId) ?? this.startedAt,
      healthSince: online ? this.healthChanged.get(machineId) : undefined,
      route: newest === undefined ? null : newest.session.direct ? "direct" : "relay",
      lastSeen: online ? this.wall() : this.seen.get(machineId) ?? null,
    };
  }

  /** This controller's wall clock in ms since the epoch: what a machine's own clock is compared with. */
  wallNow(): number { return this.wall(); }

  /** Forgets what was said of machines the store no longer holds. */
  forget(known: ReadonlySet<string>): void {
    for (const map of [this.reported, this.changed, this.healthChanged, this.seen, this.expected]) for (const id of [...map.keys()]) if (!known.has(id)) map.delete(id);
  }

  private clearStopping(machineId: string): void {
    const held = this.reported.get(machineId);
    if (held && FLEET_CAUSE_KIND[held.cause] === "stops") this.reported.delete(machineId);
  }

  /**
   * Removes a machine from the store; offline (no session signed in) its pace slot is given out last, since it never
   * heard `auth_revoked` and may still dial on it (todo 37).
   */
  remove(machineId: string): boolean { return this.store.remove(machineId, { offline: !this.online(machineId) }); }

  /** Whether a session of the machine is signed in now (one told to go is not). */
  online(machineId: string): boolean { return (this.live.get(machineId) ?? []).some((entry) => entry.committed && !entry.superseded); }

  /** Machines with a session, signed in or still being admitted. */
  get sessions(): number { return this.live.size; }

  /** The newest signed-in session's advert, or undefined. */
  advert(machineId: string): PipeAdvert | undefined { return this.newest(machineId)?.advert; }

  /** Where the machine's forward listens, once it does. */
  forward(machineId: string): { readonly port: number; readonly socketPath: string | null } | undefined {
    const forward = this.opened.get(machineId);
    return forward ? { port: forward.port, socketPath: forward.socketPath } : undefined;
  }

  /** Resolves once every forward the last store change opened or closed has done so. */
  async idle(): Promise<void> {
    while (this.settling.size) await Promise.all([...this.settling]);
  }

  /** Waits for the forward of an active machine to listen (tests and later todos ask where it is). */
  async forwardReady(machineId: string): Promise<{ readonly port: number; readonly socketPath: string | null } | undefined> {
    await this.forwards.get(machineId);
    return this.forward(machineId);
  }

  /**
   * A pipe to the machine's `endpoint`, answered PIPE_ACCEPT, on its newest signed-in session that advertised it. With
   * all MAX_PIPE_STREAMS pipes open it waits for one to retire, and tries again when the machine still counts one the
   * controller has retired (RESET `refused`), until PIPE_WAIT_MS; opens are paced (OPEN_PACE). Rejects with
   * MachineUnavailable when no session offers the endpoint, or the reset the open got.
   */
  async openPipe(machineId: string, endpoint: "bridge" | "native", signal?: AbortSignal): Promise<OpenedPipe> {
    const deadline = this.clock.now() + PIPE_WAIT_MS;
    let pause = RETRY_MS;
    // a machine this controller expects back: its new session, not the one that is going, takes the pipe
    if (!(await this.reconnected(machineId, signal))) throw new MachineUnavailable(machineId, "reconnecting");
    for (;;) {
      if (signal?.aborted) throw new MuxStreamError("cancelled");
      // a machine its operator has not confirmed (or one quarantined, revoked or gone) gets no pipe, whatever it signed in as
      let active = false;
      try { active = this.store.get(machineId)?.state === "active"; } catch { active = false; }
      if (!active) throw new MachineUnavailable(machineId, "not_active");
      const entry = this.newest(machineId);
      if (!entry) throw new MachineUnavailable(machineId, "offline");
      // two signed-in sessions of one key: no new pipe until one is proven the only one (todo 31), so a copy of the key
      // that signed in last receives nothing opened during its switch window
      if ((this.live.get(machineId) ?? []).filter((other) => other.committed && !other.superseded).length > 1) { await this.wait(machineId, deadline, undefined, signal); continue; }
      if (!entry.advert?.endpoints.includes(endpoint)) throw new MachineUnavailable(machineId, "not_advertised");
      if (entry.pipes.size >= MAX_PIPE_STREAMS) { await this.wait(machineId, deadline, undefined, signal); continue; }
      await entry.opens.take(1, signal);
      // the session may have ended or changed its advert while the open waited for its turn
      if (this.newest(machineId) !== entry || !entry.advert?.endpoints.includes(endpoint)) continue;
      let pipe: PipeStream;
      try { pipe = entry.session.openPipe(endpoint); }
      catch (error) {
        if (!(error instanceof MuxStreamError) || error.code !== "refused") throw error;
        await this.wait(machineId, deadline, undefined, signal);
        continue;
      }
      const disposed = Promise.withResolvers<MuxStreamError | undefined>();
      const answered = Promise.withResolvers<void>();
      entry.pipes.add(pipe);
      pipe.onAccept = () => answered.resolve();
      pipe.onDispose = (error) => {
        entry.pipes.delete(pipe);
        this.wake(machineId);
        answered.reject(error ?? new MuxStreamError("cancelled"));
        disposed.resolve(error);
      };
      const cancel = () => pipe.reset("cancelled");
      signal?.addEventListener("abort", cancel, { once: true });
      try { await answered.promise; }
      catch (error) {
        signal?.removeEventListener("abort", cancel);
        // the machine still counted a pipe this end had retired: another try once it has caught up
        if (error instanceof MuxStreamError && error.code === "refused" && this.clock.now() < deadline) {
          await this.wait(machineId, deadline, pause, signal);
          pause = Math.min(pause * 2, 1_000);
          continue;
        }
        throw error;
      }
      signal?.removeEventListener("abort", cancel);
      return { pipe, disposed: disposed.promise, pace: (frames, abort) => entry.frames.take(frames, abort) };
    }
  }

  /** Stops following the store and closes every forward; the sessions belong to their carriers. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unwatch?.();
    this.cancelSweep?.();
    const forwards = [...this.forwards.values()];
    this.forwards.clear();
    await Promise.all(forwards.map(async (opening) => (await opening)?.close()));
    this.opened.clear();
  }

  private newest(machineId: string): Live | undefined {
    const lives = (this.live.get(machineId) ?? []).filter((entry) => entry.committed && !entry.superseded);
    return lives.sort((a, b) => b.order - a.order)[0];
  }

  private wake(machineId: string): void {
    for (const resolve of [...this.waiters.get(machineId) ?? []]) resolve();
  }

  private told(machineId: string): void {
    for (const watcher of [...this.sessionWatchers]) watcher(machineId);
  }

  /** Until a pipe of the machine retires or its sessions change, `ms` passes, or the deadline; rejects past the deadline. */
  private async wait(machineId: string, deadline: number, ms: number | undefined, signal?: AbortSignal): Promise<void> {
    const left = deadline - this.clock.now();
    if (left <= 0) throw new MachineUnavailable(machineId, "timeout");
    const { promise, resolve } = Promise.withResolvers<void>();
    const waiters = this.waiters.get(machineId) ?? new Set();
    this.waiters.set(machineId, waiters);
    const done = () => resolve();
    if (ms === undefined) waiters.add(done);
    const cancel = this.clock.setTimeout(done, Math.min(left, ms ?? left));
    signal?.addEventListener("abort", done, { once: true });
    await promise;
    cancel();
    waiters.delete(done);
    if (!waiters.size) this.waiters.delete(machineId);
    signal?.removeEventListener("abort", done);
    if (signal?.aborted) throw new MuxStreamError("cancelled");
  }

  /** A forward for each active machine, none for any other (or for any machine of a refused store). */
  private reconcile(): void {
    if (this.closed) return;
    // a machine whose pace slot the store changed (made active) hears its new PACE now
    for (const lives of this.live.values()) for (const entry of lives) {
      if (!entry.committed || entry.paceSlot === undefined) continue;
      if (this.paceFor(entry.machineId, 0).slot !== entry.paceSlot) this.sendPace(entry.machineId, entry);
    }
    let active: readonly FleetMachine[];
    // a fleet held (no token, todo 60) or rolled back (todo 31) opens no forward
    try { active = this.held() || this.heldInMemory || this.store.document().hold ? [] : this.store.machines().filter((machine) => machine.state === "active"); }
    catch { active = []; }
    const wanted = new Set(active.map((machine) => machine.machine_id));
    for (const [machineId, opening] of [...this.forwards]) {
      if (wanted.has(machineId)) continue;
      this.forwards.delete(machineId);
      this.opened.delete(machineId);
      this.settle(opening.then((forward) => forward?.close()));
    }
    for (const machineId of wanted) {
      if (this.forwards.has(machineId)) continue;
      const opening = MachineForward.open({
        index: ++this.forwardIndex, native: this.native,
        open: (endpoint, signal) => this.openPipe(machineId, endpoint, signal),
        ready: (signal) => this.reconnecting(machineId) ? this.reconnected(machineId, signal) : true,
        bearer: () => this.advert(machineId)?.bridge_token, clock: this.clock,
      }).then((forward) => {
        if (this.forwards.get(machineId) !== opening) { void forward.close(); return undefined; }
        this.opened.set(machineId, forward);
        return forward;
      }, (error: unknown) => {
        console.error(`Fleet machine ${machineId}: its local forward could not open (${error instanceof Error ? error.message : String(error)}).`);
        return undefined;
      });
      this.forwards.set(machineId, opening);
      this.settle(opening);
    }
  }

  private settle(work: Promise<unknown>): void {
    this.settling.add(work);
    void work.finally(() => this.settling.delete(work));
  }
}

/**
 * The fleet store: `<stateDir>/fleet/machines.json`, the machines this controller knows and the invites and batches
 * they enrol through (docs/fleet-link.md section 4, server/fleet/invites.ts). It holds public keys and states only,
 * never a token, a bearer or an invite secret (those live in memory, server/fleet/sessions.ts, or only in the invite
 * files a mint hands out), and it is written only through server/private-state.ts (0600, flushed, renamed into place).
 * An invite and the machine it admits change in one write, so a crash never leaves one without the other.
 *
 * A file that is not exactly what this code writes (not JSON, another version, a record with a key it does not know,
 * a machine id that is not its key's fingerprint, a state that is not one of the four) is refused whole and loudly:
 * an empty store would un-enrol every machine, so nothing is read from it and nothing replaces it until a person
 * mends or moves it. Every change reads the file again under a lock file beside it, so two writers (two processes on
 * one state folder) never lose each other's change. The lock names its holder's process: one whose process is gone
 * (a crash) is taken over at once, not after LOCK_STALE_MS.
 *
 * Pace slots (todo 37, docs/fleet-link.md "The relay pace"): every write gives each record that is not revoked and has
 * no `pace_slot` one, whatever made it (an ENROLL, a batch confirmed, setState, the backfill at start): the slot of the
 * revoked record it was re-enrolled in place of (the same invite slot), else the lowest number below `max` that no
 * record holds and none retired, else the lowest retired one. A record keeps its slot until it is removed. A retired
 * slot is one a machine may still dial on, so it is given out last: one freed by removing a machine that was offline at
 * the time (it never heard `auth_revoked`; kept in `retired_pace_slots`), and one a revoked record still holds (kept
 * on the record, so a re-enrolment into its invite slot inherits it; taken from it when given to another machine).
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { writePrivateState } from "../private-state.ts";
import { machineFingerprint } from "./mux-ext.ts";
import type { FleetDirectory, MachineRecord, MachineState } from "./mux-ext.ts";

export const FLEET_STORE_VERSION = 1;
/** Machines a controller holds by default, and at most whatever OVIS_FLEET_MAX says (GA-10 of the plan's draft). */
export const DEFAULT_FLEET_MAX = 100;
export const FLEET_MAX_LIMIT = 1000;
/** How long a writer waits for another's lock, and how old a lock is before it counts as left by a crash. */
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

/** One machine as the store keeps it. */
export interface FleetMachine extends MachineRecord {
  /** The invite slot it enrolled into (todo 30), or null. */
  readonly slot: number | null;
  readonly invite_id: string | null;
  /** The runtime's machine id from its advert (todo 26 names rows by it), or null before the first. */
  readonly runtime_id: string | null;
  readonly name: string;
  /** ms since the epoch */
  readonly created_at: number;
  readonly updated_at: number;
  /** When a session of it last signed in or ended (ms since the epoch), or null before its first: the vanish sweep's clock (todo 31). */
  readonly seen_at: number | null;
  /** Its place on the relay pace's timeline (todo 37), given at the first write after the record is made; absent before. */
  readonly pace_slot?: number;
}

/** What a new machine is made from; it starts `pending` (todo 30 confirms it `active`). */
export type NewFleetMachine = Pick<FleetMachine, "machine_id" | "public_key"> & Partial<Pick<FleetMachine, "slot" | "invite_id" | "runtime_id" | "name">>;

/** An invite as the store keeps it: never its secret, only the Ed25519 public key derived from it (section 4). */
export interface StoredInvite {
  /** 16 lowercase hex digits */
  readonly id: string;
  readonly slot: number;
  /** the name the machine it admits takes */
  readonly name: string;
  readonly batch_id: string;
  /** `invite_public_key`: 64 lowercase hex digits */
  readonly public_key: string;
  /** seconds since the epoch, judged by this controller's clock only */
  readonly exp: number;
  /** the machine key (SPKI DER, base64url) of the first ENROLL it admitted, or null while unused */
  readonly used_by: string | null;
  /** ms since the epoch */
  readonly created_at: number;
}

/** A batch of invites minted together: its machines become usable once the operator confirms them. */
export interface StoredBatch {
  readonly id: string;
  readonly created_at: number;
  /** Seconds a machine of the batch may go unseen before the sweep removes it (todo 31); 0 keeps it forever. */
  readonly retention_s: number;
}

/** A batch's retention when its mint names none, and for a batch written before retention existed. */
export const DEFAULT_RETENTION_S = 24 * 60 * 60;

/** The whole file. */
export interface FleetDocument {
  readonly machines: readonly FleetMachine[];
  readonly invites: readonly StoredInvite[];
  readonly batches: readonly StoredBatch[];
  /**
   * The witness generation this store was written at (server/fleet/witness.ts, todo 31), or null for a store no witness
   * has spoken for yet (written before todo 31): such a store takes the witness's generation at its first start.
   */
  readonly generation: number | null;
  /** The fleet is held as rolled back (todo 31) until the operator confirms: no machine signs in meanwhile. */
  readonly hold: boolean;
  /**
   * The name of the witness file that speaks for this store (`fleet-witness/<witness_id>.json`): the controller's
   * server_id when its first witness was made, kept across a rotation of its relay identity; null before the first.
   */
  readonly witness_id: string | null;
  /** Pace slots freed by removing a machine that was offline then (todo 37); absent when none. */
  readonly retired_pace_slots?: readonly number[];
}

/**
 * The only moves between states: forward along pending -> active -> quarantined -> revoked, never back (a revoked
 * key stays refused; re-admitting is todo 31's, by the operator).
 */
const NEXT: Record<MachineState, readonly MachineState[]> = {
  pending: ["active", "quarantined", "revoked"],
  active: ["quarantined", "revoked"],
  quarantined: ["revoked"],
  revoked: [],
};

export class FleetStoreError extends Error {
  constructor(message: string, readonly code: "unreadable" | "invalid" | "busy" | "controller_limit" | "exists" | "unknown" | "transition" | "fleet_token_required") {
    super(message);
    this.name = "FleetStoreError";
  }
}

/** OVIS_FLEET_MAX as a number of machines: 1..1000, DEFAULT_FLEET_MAX when unset; anything else is refused loudly. */
export function fleetMax(env: NodeJS.ProcessEnv = process.env): number {
  const text = env["OVIS_FLEET_MAX"];
  if (text === undefined || text === "") return DEFAULT_FLEET_MAX;
  const value = /^\d{1,4}$/.test(text) ? Number(text) : NaN;
  if (!(value >= 1 && value <= FLEET_MAX_LIMIT)) {
    console.error(`OVIS_FLEET_MAX must be a whole number from 1 to ${FLEET_MAX_LIMIT}; using ${DEFAULT_FLEET_MAX}.`);
    return DEFAULT_FLEET_MAX;
  }
  return value;
}

const RECORD_KEYS = ["machine_id", "public_key", "state", "slot", "invite_id", "runtime_id", "name", "created_at", "updated_at", "seen_at"] as const;
/** Keys a file written before todo 31 lacks: read as their default. */
const LATER_KEYS: readonly string[] = ["seen_at", "retention_s"];
/** Keys a record may lack: a file written before todo 37 has no `pace_slot`. */
const OPTIONAL_KEYS = ["pace_slot"] as const;
const paceSlot = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value < FLEET_MAX_LIMIT;
const INVITE_KEYS = ["id", "slot", "name", "batch_id", "public_key", "exp", "used_by", "created_at"] as const;
const BATCH_KEYS = ["id", "created_at", "retention_s"] as const;
const STATES: readonly string[] = ["pending", "active", "quarantined", "revoked"];

function invalid(message: string): never { throw new FleetStoreError(message, "invalid"); }
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A record exactly as this code writes it, or the reason it is not. */
function record(value: unknown, at: string): FleetMachine {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${at} is not an object`);
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!(RECORD_KEYS as readonly string[]).includes(key) && !(OPTIONAL_KEYS as readonly string[]).includes(key)) invalid(`${at} has an unknown key ${JSON.stringify(key)}`);
  for (const key of RECORD_KEYS) if (!(key in v) && !LATER_KEYS.includes(key)) invalid(`${at} has no ${key}`);
  const { machine_id: id, public_key: key, state, slot, invite_id: invite, runtime_id: runtime, name, created_at: created, updated_at: updated } = v;
  const seen = v["seen_at"] ?? null;
  if (seen !== null && !timestamp(seen)) invalid(`${at}.seen_at is not ms since the epoch or null`);
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) invalid(`${at}.machine_id is not 32 lowercase hex digits`);
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{122}$/.test(key) || Buffer.from(key, "base64url").toString("base64url") !== key) invalid(`${at}.public_key is not a 91-byte key in base64url`);
  // the id is the key's fingerprint (docs/fleet-link.md section 1.5): a record under another key's id would sign that key in as this machine
  if (machineFingerprint(Buffer.from(key, "base64url")) !== id) invalid(`${at}.machine_id is not the fingerprint of its public_key`);
  if (typeof state !== "string" || !STATES.includes(state)) invalid(`${at}.state is not one of ${STATES.join(", ")}`);
  if (slot !== null && !(typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot <= 65535)) invalid(`${at}.slot is not 0..65535 or null`);
  if (invite !== null && !(typeof invite === "string" && /^[0-9a-f]{16}$/.test(invite))) invalid(`${at}.invite_id is not 16 hex digits or null`);
  if (runtime !== null && !(typeof runtime === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(runtime))) invalid(`${at}.runtime_id is not a runtime id or null`);
  if (typeof name !== "string" || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) invalid(`${at}.name is not a name of at most 128 printable characters`);
  if (!timestamp(created) || !timestamp(updated)) invalid(`${at} has a timestamp that is not ms since the epoch`);
  if ("pace_slot" in v && !paceSlot(v["pace_slot"])) invalid(`${at}.pace_slot is not 0..${FLEET_MAX_LIMIT - 1}`);
  return { machine_id: id, public_key: key, state: state as MachineState, slot: slot as number | null, invite_id: invite as string | null,
    runtime_id: runtime as string | null, name, created_at: created as number, updated_at: updated as number, seen_at: seen as number | null,
    ...("pace_slot" in v ? { pace_slot: v["pace_slot"] as number } : {}) };
}

function exactly(value: unknown, at: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${at} is not an object`);
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!keys.includes(key)) invalid(`${at} has an unknown key ${JSON.stringify(key)}`);
  for (const key of keys) if (!(key in v) && !LATER_KEYS.includes(key)) invalid(`${at} has no ${key}`);
  return v;
}

function invite(value: unknown, at: string): StoredInvite {
  const v = exactly(value, at, INVITE_KEYS);
  const { id, slot, name, batch_id: batch, public_key: key, exp, used_by: usedBy, created_at: created } = v;
  if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) invalid(`${at}.id is not 16 lowercase hex digits`);
  if (!(typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot <= 65535)) invalid(`${at}.slot is not 0..65535`);
  if (typeof name !== "string" || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) invalid(`${at}.name is not a name of at most 128 printable characters`);
  if (typeof batch !== "string" || !/^[0-9a-f]{16}$/.test(batch)) invalid(`${at}.batch_id is not 16 lowercase hex digits`);
  if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) invalid(`${at}.public_key is not 64 lowercase hex digits`);
  if (!timestamp(exp)) invalid(`${at}.exp is not seconds since the epoch`);
  if (usedBy !== null && !(typeof usedBy === "string" && /^[A-Za-z0-9_-]{122}$/.test(usedBy) && Buffer.from(usedBy, "base64url").toString("base64url") === usedBy)) invalid(`${at}.used_by is not a 91-byte key in base64url or null`);
  if (!timestamp(created)) invalid(`${at}.created_at is not ms since the epoch`);
  return { id, slot, name, batch_id: batch, public_key: key, exp: exp as number, used_by: usedBy as string | null, created_at: created as number };
}

function batch(value: unknown, at: string): StoredBatch {
  const v = exactly(value, at, BATCH_KEYS);
  if (typeof v["id"] !== "string" || !/^[0-9a-f]{16}$/.test(v["id"])) invalid(`${at}.id is not 16 lowercase hex digits`);
  if (!timestamp(v["created_at"])) invalid(`${at}.created_at is not ms since the epoch`);
  const retention = v["retention_s"] ?? DEFAULT_RETENTION_S;
  if (!(typeof retention === "number" && Number.isSafeInteger(retention) && retention >= 0)) invalid(`${at}.retention_s is not whole seconds`);
  return { id: v["id"], created_at: v["created_at"], retention_s: retention };
}

/**
 * The whole document of a store file's bytes, or a FleetStoreError naming what is wrong (nothing of a refused file is
 * used). A file written before invites existed (todos 20-29: `v` and `machines` only) reads as one with none.
 */
export function parseFleetDocument(text: string): FleetDocument {
  let value: unknown;
  try { value = JSON.parse(text); } catch { invalid("machines.json is not JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("machines.json is not an object");
  const document = value as Record<string, unknown>;
  for (const key of Object.keys(document)) if (!["v", "machines", "invites", "batches", "generation", "hold", "witness_id", "retired_pace_slots"].includes(key)) invalid(`machines.json has an unknown key ${JSON.stringify(key)}`);
  const generation = document["generation"] ?? null;
  if (generation !== null && !timestamp(generation)) invalid("machines.json generation is not a whole number or null");
  const hold = document["hold"] ?? false;
  if (typeof hold !== "boolean") invalid("machines.json hold is not true or false");
  const witnessId = document["witness_id"] ?? null;
  if (witnessId !== null && !(typeof witnessId === "string" && /^[0-9a-f]{32}$/.test(witnessId))) invalid("machines.json witness_id is not 32 hex digits or null");
  if (document["v"] !== FLEET_STORE_VERSION) invalid(`machines.json is version ${JSON.stringify(document["v"])}, not ${FLEET_STORE_VERSION}`);
  if (!Array.isArray(document["machines"])) invalid("machines.json has no machines list");
  const machines = document["machines"].map((entry, index) => record(entry, `machines[${index}]`));
  const ids = new Set(machines.map((machine) => machine.machine_id));
  if (ids.size !== machines.length) invalid("machines.json names one machine twice");
  const listed = (key: "invites" | "batches") => {
    const list = document[key] ?? [];
    if (!Array.isArray(list)) invalid(`machines.json ${key} is not a list`);
    return list;
  };
  const invites = listed("invites").map((entry, index) => invite(entry, `invites[${index}]`));
  const batches = listed("batches").map((entry, index) => batch(entry, `batches[${index}]`));
  if (new Set(invites.map((entry) => entry.id)).size !== invites.length) invalid("machines.json names one invite twice");
  if (new Set(batches.map((entry) => entry.id)).size !== batches.length) invalid("machines.json names one batch twice");
  const batchIds = new Set(batches.map((entry) => entry.id));
  if (invites.some((entry) => !batchIds.has(entry.batch_id))) invalid("machines.json has an invite of a batch it does not hold");
  const held = machines.flatMap((machine) => machine.pace_slot === undefined ? [] : [machine.pace_slot]);
  if (new Set(held).size !== held.length) invalid("machines.json gives one pace_slot to two machines");
  const retired = document["retired_pace_slots"] ?? [];
  if (!Array.isArray(retired) || !retired.every(paceSlot) || new Set(retired).size !== retired.length || retired.some((slot) => held.includes(slot))) {
    invalid("machines.json retired_pace_slots is not a list of free pace slots");
  }
  return { machines, invites, batches, generation: generation as number | null, hold, witness_id: witnessId as string | null, ...(retired.length ? { retired_pace_slots: retired as number[] } : {}) };
}

/**
 * The document with a pace slot for every record that is not revoked and has none (see the file's comment), in the
 * records' order; the same document when each has one.
 */
function withPaceSlots(document: FleetDocument, max: number): FleetDocument {
  if (!document.machines.some((machine) => machine.state !== "revoked" && machine.pace_slot === undefined)) return document;
  let machines = [...document.machines];
  let retired = [...document.retired_pace_slots ?? []];
  for (const [index, machine] of machines.entries()) {
    if (machine.state === "revoked" || machine.pace_slot !== undefined) continue;
    const previous = machine.slot === null ? -1
      : machines.findIndex((other) => other !== machine && other.slot === machine.slot && other.state === "revoked" && other.pace_slot !== undefined);
    let slot: number | undefined;
    if (previous >= 0) {
      slot = machines[previous]!.pace_slot;
      const { pace_slot: _given, ...rest } = machines[previous]!;
      machines[previous] = rest;
    } else {
      const held = new Set(machines.flatMap((other) => other.state === "revoked" || other.pace_slot === undefined ? [] : [other.pace_slot]));
      const revokedHeld = new Set(machines.flatMap((other) => other.state === "revoked" && other.pace_slot !== undefined ? [other.pace_slot] : []));
      for (let candidate = 0; candidate < max && slot === undefined; candidate++) {
        if (!held.has(candidate) && !retired.includes(candidate) && !revokedHeld.has(candidate)) slot = candidate;
      }
      slot ??= [...retired, ...revokedHeld].sort((a, b) => a - b).find((candidate) => !held.has(candidate));
      if (slot !== undefined) {
        retired = retired.filter((candidate) => candidate !== slot);
        const holder = machines.findIndex((other) => other.state === "revoked" && other.pace_slot === slot);
        if (holder >= 0) { const { pace_slot: _taken, ...rest } = machines[holder]!; machines[holder] = rest; }
      }
    }
    if (slot !== undefined) machines[index] = { ...machine, pace_slot: slot };
  }
  machines = machines.slice();
  const { retired_pace_slots: _old, ...rest } = document;
  return { ...rest, machines, ...(retired.length ? { retired_pace_slots: retired } : {}) };
}

/** The machines of a store file's bytes, or a FleetStoreError naming what is wrong (nothing of a refused file is used). */
export function parseFleetStore(text: string): FleetMachine[] {
  return [...parseFleetDocument(text).machines];
}

/** A machine record as this code writes it, for a change that makes one (server/fleet/invites.ts). */
export const fleetMachine = (value: Record<string, unknown>): FleetMachine => record(value, "new machine");

const EMPTY: FleetDocument = { machines: [], invites: [], batches: [], generation: null, hold: false, witness_id: null };

/** Waits `ms` without a timer: the lock is taken inside a synchronous change, as the write itself is. */
function pause(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** Whether process `pid` of this host is gone: its lock was left by a crash. */
function gone(pid: number): boolean {
  // a change runs synchronously from lock to unlock: a lock naming this process is one it left when it failed
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Whether the lock at `path` was left by a writer that is gone: its process ended, or it is older than LOCK_STALE_MS. */
function stale(path: string): boolean {
  if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) return true;
  const holder = /^(\d{1,10})$/.exec(readFileSync(path, "utf8").trim());
  // a lock just made has no pid written yet: its writer is alive and about to write it
  return holder !== null && gone(Number(holder[1]));
}

export interface FleetStoreOptions {
  readonly stateDir: string;
  /** OVIS_FLEET_MAX (fleetMax) unless given. */
  readonly max?: number;
  readonly now?: () => number;
}

/**
 * The store of one state folder. `machines()` is what the file held when it was last read or written here; a file that
 * was refused makes `machines()` and every change throw its FleetStoreError, so no machine signs in on a guess.
 */
export class FleetStore implements FleetDirectory {
  readonly path: string;
  readonly max: number;
  private current: FleetDocument = EMPTY;
  private failure: FleetStoreError | undefined;
  private readonly watchers = new Set<() => void>();
  private readonly now: () => number;
  private holding: () => boolean = () => false;

  constructor(options: FleetStoreOptions) {
    this.path = join(options.stateDir, "fleet", "machines.json");
    this.max = options.max ?? fleetMax();
    this.now = options.now ?? Date.now;
    try { this.current = this.read(); }
    catch (error) {
      this.failure = error instanceof FleetStoreError ? error : new FleetStoreError(`machines.json cannot be read: ${String(error)}`, "unreadable");
      console.error(`Fleet store ${this.path} refused: ${this.failure.message}. No fleet machine can sign in until it is mended or moved away; it is left as it is.`);
    }
  }

  /** Why the file was refused at start, or undefined. */
  get error(): FleetStoreError | undefined { return this.failure; }

  machines(): readonly FleetMachine[] {
    if (this.failure) throw this.failure;
    return this.current.machines;
  }

  /** The invites and batches as last read or written here (server/fleet/invites.ts reads them). */
  document(): FleetDocument {
    if (this.failure) throw this.failure;
    return this.current;
  }

  get(machineId: string): FleetMachine | undefined { return this.machines().find((machine) => machine.machine_id === machineId); }

  /**
   * The fleet that owns this store holds it while the server has no token (server/fleet/gate.ts, server/fleet/sessions.ts):
   * from then on every change is refused `fleet_token_required` before the lock or the folder is touched, whoever asks
   * (a route, a sign-in, a sweep or a backfill). A store no fleet owns (a test, a migration tool) is not held.
   */
  holdWhile(held: () => boolean): void { this.holding = held; }

  /** Pace slots freed by removing a machine that was offline at the time, given out again last. */
  retiredPaceSlots(): readonly number[] { return this.document().retired_pace_slots ?? []; }

  /**
   * Gives a pace slot to every record that is not revoked and has none: one made before pace slots existed (todo 37),
   * so it does not fall back to its id's default slot and share an instant with another. Writes nothing when each has one.
   */
  backfillPaceSlots(): void {
    // a held fleet (no token, todo 60) writes nothing: the slots come at the first start with the token, without a log line
    if (this.holding() || this.failure || !this.current.machines.some((machine) => machine.state !== "revoked" && machine.pace_slot === undefined)) return;
    this.update((document) => ({ document, result: undefined }));
  }

  onChange(change: () => void): () => void {
    this.watchers.add(change);
    return () => { this.watchers.delete(change); };
  }

  /** A new machine, `pending`. Past `max` machines that are not revoked it is refused `controller_limit`. */
  add(machine: NewFleetMachine): FleetMachine {
    return this.written(this.machinesChange((machines) => {
      const at = this.now();
      const made = record({ slot: null, invite_id: null, runtime_id: null, name: "", ...machine, state: "pending", created_at: at, updated_at: at, seen_at: null }, "new machine");
      if (machines.some((other) => other.machine_id === made.machine_id)) throw new FleetStoreError(`machine ${made.machine_id} is already in the store`, "exists");
      if (machines.filter((other) => other.state !== "revoked").length >= this.max) throw new FleetStoreError(`the controller holds ${this.max} machines (OVIS_FLEET_MAX)`, "controller_limit");
      return { machines: [...machines, made], result: made };
    }));
  }

  /** `made` as the write left it: with the pace slot the write gave it. */
  private written(made: FleetMachine): FleetMachine { return this.current.machines.find((machine) => machine.machine_id === made.machine_id) ?? made; }

  /** Moves a machine to `state` along NEXT; the same state again changes nothing. */
  setState(machineId: string, state: MachineState): FleetMachine {
    return this.written(this.machinesChange((machines) => {
      const found = machines.find((machine) => machine.machine_id === machineId);
      if (!found) throw new FleetStoreError(`no machine ${machineId}`, "unknown");
      if (found.state === state) return { machines, result: found };
      if (!NEXT[found.state].includes(state)) throw new FleetStoreError(`machine ${machineId} cannot go from ${found.state} to ${state}`, "transition");
      const moved = { ...found, state, updated_at: this.now() };
      return { machines: machines.map((machine) => machine === found ? moved : machine), result: moved };
    }));
  }

  /** Records the runtime id a machine's advert named (the roster names its row by it); the same one again changes nothing. */
  setRuntime(machineId: string, runtimeId: string): FleetMachine {
    return this.machinesChange((machines) => {
      const found = machines.find((machine) => machine.machine_id === machineId);
      if (!found) throw new FleetStoreError(`no machine ${machineId}`, "unknown");
      if (found.runtime_id === runtimeId) return { machines, result: found };
      const moved = record({ ...found, runtime_id: runtimeId, updated_at: this.now() }, "machine");
      return { machines: machines.map((machine) => machine === found ? moved : machine), result: moved };
    });
  }

  /**
   * Removes a machine's record; its sessions and forwards go with it (server/fleet/sessions.ts). `offline`: it had no
   * session then, so it never heard `auth_revoked` and may still dial on its pace slot: that slot is given out last.
   */
  remove(machineId: string, { offline = false }: { readonly offline?: boolean } = {}): boolean {
    return this.update((document) => {
      const gone = document.machines.find((machine) => machine.machine_id === machineId);
      if (!gone) return { document, result: false };
      const machines = document.machines.filter((machine) => machine !== gone);
      const retired = offline && gone.pace_slot !== undefined ? [...document.retired_pace_slots ?? [], gone.pace_slot] : document.retired_pace_slots;
      return { document: { ...document, machines, ...(retired?.length ? { retired_pace_slots: retired } : {}) }, result: true };
    });
  }

  private read(): FleetDocument {
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
      throw new FleetStoreError(`machines.json cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})`, "unreadable");
    }
    return parseFleetDocument(text);
  }

  private machinesChange<T>(apply: (machines: readonly FleetMachine[]) => { machines: readonly FleetMachine[]; result: T }): T {
    return this.update((document) => {
      const after = apply(document.machines);
      return { document: after.machines === document.machines ? document : { ...document, machines: after.machines }, result: after.result };
    });
  }

  /**
   * Under the lock: the file read again, changed by `apply`, written back when anything changed (`document` is not the
   * one `apply` was given), and every watcher told. `apply` runs synchronously and may throw to change nothing.
   */
  update<T>(apply: (document: FleetDocument) => { document: FleetDocument; result: T }): T {
    if (this.failure) throw this.failure;
    if (this.holding()) throw new FleetStoreError("the fleet is held: this server has no OVIS_TOKEN, so nothing is written", "fleet_token_required");
    const lock = `${this.path}.lock`;
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const held = openSync(lock, "wx", 0o600);
        try { writeSync(held, String(process.pid)); } finally { closeSync(held); }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      // a lock left by a writer that crashed holding it: its process is gone, or it is older than LOCK_STALE_MS
      try { if (stale(lock)) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new FleetStoreError(`machines.json is locked by another writer (${lock})`, "busy");
      pause(5);
    }
    let changed = false;
    let result: T;
    try {
      const before = this.read();
      const after = apply(before);
      result = after.result;
      // whatever the change, a record that may sign in holds a pace slot from this write on (todo 37)
      const document = withPaceSlots(after.document, this.max);
      if (document !== before) {
        const { machines, invites, batches, retired_pace_slots: retired, generation, hold, witness_id } = document;
        writePrivateState(this.path, { v: FLEET_STORE_VERSION, machines, invites, batches, ...(retired?.length ? { retired_pace_slots: retired } : {}), generation, hold, witness_id });
        changed = true;
      }
      this.current = document;
    } finally {
      try { unlinkSync(lock); } catch { /* the next writer finds it stale */ }
    }
    if (changed) for (const watcher of [...this.watchers]) watcher();
    return result;
  }
}

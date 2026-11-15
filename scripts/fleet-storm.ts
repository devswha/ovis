/**
 * A hundred machines come back at once (todo 37, docs/fleet-link.md "The relay pace"): a discrete-event storm on an
 * injected clock and a seeded jitter source, so the same flags and seed print the same report. It runs the code that
 * decides what happens: the relay pace and the controller's one bucket of relay sockets (server/fleet/relay-pace.ts),
 * the sign-in queue (server/fleet/sign-in-queue.ts), the fleet store's pace slots (server/fleet/store.ts, in a
 * temporary folder) and the Bun relay's per-address token buckets (relay/bun-limits.ts memoryLimiters). The network,
 * the relay's waiting room and the link agent's dial rule (crates/fleet-link/src/supervisor.rs, whose own tests run on
 * a test clock) are modelled here; nothing sleeps and nothing listens.
 *
 *   bun scripts/fleet-storm.ts --machines 100 --path direct
 *   bun scripts/fleet-storm.ts --path relay --limits fleet-flags --loss-spread 10000 --enrol-after 10 --remove 5 \
 *     --stale 22 --clock-error-ms 1000 --devices 8 --late-devices 2
 *
 * Flags: --machines <n> --path direct|relay --limits fleet-flags|hosted --loss-spread <ms> --enrol-after <n>
 * --remove <n> --stale <n> --clock-error-ms <ms> --devices <n> --late-devices <n> --no-lanes --own-loss-clock
 * --no-spacing --pace <n> --seed <n>; and for the waves of todo 37's reference measurements (CORRECTIONS row 30/37/54/55):
 * --wave <n> (n machines join or wake together on top of a connected fleet, no restart), --refusals <n> (the relay
 * refuses the first n machine dials 429, as another program behind the address would), --sleeper (one connected
 * machine frozen for 15 minutes, then resumed), --halve-on-refusal (the measured tool's mistake: a second refusal halves
 * that machine's dial rate, so it skips its next instant too), --answer-ms <ms> (how long a machine's relay dial waits for
 * the controller, 5000 by default). --bound <ms>: exit 1 when ALL_BACK_MS is past it (or never), the report unchanged:
 * the acceptance runs pass 60000 direct, 180000 with the fleet flags and 300000 hosted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import { memoryLimiters, relayLimits } from "../relay/bun-limits.ts";
import type { MuxClock } from "../shared/relay-mux-engine.ts";
import { deviceWindowMs, MACHINE_ANSWER_MS, nextPaceInstant, paceSpan, relayPace, RelaySocketBudget } from "../server/fleet/relay-pace.ts";
import type { RelayLane, RelayPaceProfile } from "../server/fleet/relay-pace.ts";
import { SignInQueue } from "../server/fleet/sign-in-queue.ts";
import { FleetStore } from "../server/fleet/store.ts";
import { machineFingerprint } from "../server/fleet/mux-ext.ts";

// ---------- flags ----------
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string, fallback: number): number => {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const parsed = Number(argv[at + 1]);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} needs a number`);
  return parsed;
};
const text = (name: string, fallback: string): string => { const at = argv.indexOf(`--${name}`); return at < 0 ? fallback : argv[at + 1] ?? fallback; };
const options = {
  machines: value("machines", 100), path: text("path", "relay"), limits: text("limits", "fleet-flags"),
  lossSpread: value("loss-spread", 0), enrolAfter: value("enrol-after", 0), remove: value("remove", 0), stale: value("stale", 0),
  clockError: value("clock-error-ms", 0), devices: value("devices", 0), lateDevices: value("late-devices", 0),
  noLanes: flag("no-lanes"), ownLossClock: flag("own-loss-clock"), noSpacing: flag("no-spacing"), pace: value("pace", 0),
  seed: value("seed", 37), wave: value("wave", 0), refusals: value("refusals", 0), sleeper: flag("sleeper"),
  halveOnRefusal: flag("halve-on-refusal"), answerMs: value("answer-ms", MACHINE_ANSWER_MS), bound: value("bound", 0),
};
if (options.path !== "direct" && options.path !== "relay") throw new Error("--path is direct or relay");
if (options.limits !== "fleet-flags" && options.limits !== "hosted") throw new Error("--limits is fleet-flags or hosted");

// ---------- clock and jitter ----------
/** mulberry32: the storm's only source of chance */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = seeded(options.seed);
const uniform = (low: number, high: number) => low + (high - low) * random();

/** Discrete events: the earliest first, ties in the order they were set. */
class StormClock implements MuxClock {
  private time = 0;
  private sequence = 0;
  private readonly heap: { at: number; id: number; run: () => void }[] = [];
  private readonly cancelled = new Set<number>();
  now(): number { return this.time; }
  setTimeout(run: () => void, ms: number): () => void {
    const id = ++this.sequence;
    this.push({ at: this.time + Math.max(0, ms), id, run });
    return () => { this.cancelled.add(id); };
  }
  at(when: number, run: () => void): () => void { return this.setTimeout(run, when - this.time); }
  private push(entry: { at: number; id: number; run: () => void }): void {
    const heap = this.heap;
    heap.push(entry);
    for (let index = heap.length - 1; index > 0;) {
      const parent = (index - 1) >> 1;
      if (this.less(heap[parent]!, heap[index]!)) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
      index = parent;
    }
  }
  private less(a: { at: number; id: number }, b: { at: number; id: number }): boolean { return a.at < b.at || (a.at === b.at && a.id < b.id); }
  private pop(): { at: number; id: number; run: () => void } | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      heap[0] = last;
      for (let index = 0; ;) {
        const left = index * 2 + 1, right = left + 1;
        let least = index;
        if (left < heap.length && this.less(heap[left]!, heap[least]!)) least = left;
        if (right < heap.length && this.less(heap[right]!, heap[least]!)) least = right;
        if (least === index) break;
        [heap[least], heap[index]] = [heap[index]!, heap[least]!];
        index = least;
      }
    }
    return top;
  }
  /** Runs events until `done` or `until` ms; a turn of the event loop after each drains the promises they started. */
  async run(done: () => boolean, until: number): Promise<void> {
    while (!done()) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (done()) return;
      const next = this.pop();
      if (!next || next.at > until) return;
      if (this.cancelled.delete(next.id)) continue;
      this.time = next.at;
      next.run();
    }
  }
}
const clock = new StormClock();

// ---------- the profile ----------
const BUDGET = options.limits === "hosted" ? 30 : 120;
/** the controller's pace, from the budget the relay names */
const controllerProfile: RelayPaceProfile = relayPace(BUDGET);
/** the machines' pace: the one PACE carries for this budget (22 a minute hosted), or --pace's */
const machineProfile: RelayPaceProfile = options.pace > 0 ? { ...relayPace(Math.ceil(options.pace * 5 / 4)), per_minute: options.pace, spacing_ms: 60_000 / options.pace }
  : { ...controllerProfile, per_minute: controllerProfile.machine_per_minute, spacing_ms: controllerProfile.machine_spacing_ms };
const FLEET_MAX = Math.max(100, options.machines);
const SPAN = paceSpan(FLEET_MAX, machineProfile.per_minute);
const CYCLE = SPAN * machineProfile.spacing_ms;
const RTT = 40;
const VERIFY_MS = 3;
const DEVICE_WAIT_MS = 25_000;
const DEVICE_PAUSE_MS = 1_000;
const OFFLINE_WAIT_MS = 30_000;
const STARTUP_MS = 500;
/** relay/core.ts roomLimits(100): 4 + ceil(100 / 8) waiting places */
const WAITING_PLACES = 4 + Math.ceil(100 / 8);

// ---------- the relay's per-address budgets: the Bun relay's own token buckets on this clock ----------
const limiters = memoryLimiters(relayLimits({ perAddressPerMinute: BUDGET, maxSocketsPerAddress: 256, maxClientsPerServer: 108 }), () => clock.now());
const dialsAt: Record<"machines" | "controller" | "devices", number[]> = { machines: [], controller: [], devices: [] };
let rateLimited = 0;
let injectedRefusals = options.refusals;
async function admitted(address: "machines" | "controller" | "devices"): Promise<boolean> {
  dialsAt[address].push(clock.now());
  if (address === "machines" && injectedRefusals > 0) { injectedRefusals--; rateLimited++; return false; }
  const ok = (await limiters.perAddress.limit({ key: address })).success && (await limiters.global.limit({ key: "all" })).success;
  if (!ok) rateLimited++;
  return ok;
}
const mostIn60s = (times: readonly number[]) => {
  const sorted = [...times].sort((a, b) => a - b);
  let most = 0;
  for (let start = 0, end = 0; start < sorted.length; start++) {
    while (end < sorted.length && sorted[end]! < sorted[start]! + 60_000) end++;
    most = Math.max(most, end - start);
  }
  return most;
};

// ---------- the store: real pace slots ----------
const stateDir = mkdtempSync(join(tmpdir(), "fleet-storm-"));
const store = new FleetStore({ stateDir, max: FLEET_MAX, now: () => 1_767_225_600_000 });
/** a P-256 key's SPKI, as the store keeps it; deterministic test keys would need a P-256 generator, so these are WebCrypto's */
async function newKey(): Promise<{ id: string; spki: string }> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  return { id: machineFingerprint(der), spki: Buffer.from(der).toString("base64url") };
}

// ---------- the actors ----------
interface Machine {
  readonly index: number;
  readonly id: string;
  slot: number;
  /** stale: an older generation, an error bound above 1 s, a restarted clock, or removed while offline */
  stale: boolean;
  removed: boolean;
  /** how late this machine reads the controller's clock (ms) */
  error: number;
  /** a stale machine's whole guess of the timeline */
  phase: number;
  /** --own-loss-clock: the slot and span it held from its own enrolment */
  ownSlot: number;
  ownSpan: number;
  lossAt: number;
  back: number | undefined;
  retried: boolean;
  backoff: number;
  dials: number[];
  /** the dial under way: give it up / its relay entry */
  cancelGiveUp?: () => void;
  waiting?: Client;
  frozenUntil?: number;
}
interface Client { readonly id: string; readonly lane: RelayLane; readonly owner: Machine | Device; announced: boolean; cancelTake?: () => void; answered: boolean; gone: boolean; readonly arrived: number }
interface Device { readonly index: number; readonly late: boolean; back: number | undefined; waiting?: Client; cancel?: () => void }

const machines: Machine[] = [];
const devices: Device[] = [];
const relayWaiting: Client[] = [];
let controllerUp = false;
let controlProven: number | undefined;
let restartAt = 0;
let budget: RelaySocketBudget | undefined;
const signIns = new SignInQueue();
let refused = 0;
let retries = 0;
let clientIds = 0;
let finished = false;

// ---------- machines on the relay ----------
function nominalAfter(machine: Machine, after: number): number {
  const s = machineProfile.spacing_ms;
  if (options.ownLossClock) {
    // the rejected design: instants counted from the machine's own loss, over the slots it held at its enrolment
    const cycle = machine.ownSpan * s;
    const first = machine.lossAt + machine.ownSlot * s;
    return after < first ? first : first + Math.ceil((after - first + 1) / cycle) * cycle;
  }
  if (machine.stale) {
    // its own guess of the timeline: one dial a cycle, at a phase of its own
    return nextPaceInstant({ slot: machine.slot, span: SPAN, spacing_ms: s }, after + machine.phase) - machine.phase;
  }
  return nextPaceInstant({ slot: machine.slot, span: SPAN, spacing_ms: s }, after);
}

/** The next relay dial of a machine after `after`, its clock error added; --no-spacing: todo 24's backoff alone. */
function scheduleMachine(machine: Machine, after: number): void {
  if (finished || machine.back !== undefined && !machine.removed) return;
  if (options.noSpacing) {
    const ceiling = Math.min(60_000, 1_000 * 2 ** machine.backoff);
    machine.backoff++;
    clock.at(after + uniform(0, ceiling), () => void dialRelay(machine));
    return;
  }
  const nominal = nominalAfter(machine, after);
  clock.at(Math.max(clock.now(), nominal + machine.error), () => void dialRelay(machine));
}

async function dialRelay(machine: Machine): Promise<void> {
  if (finished || (machine.back !== undefined && !machine.removed) || machine.waiting) return;
  if (machine.frozenUntil !== undefined && clock.now() < machine.frozenUntil) return;
  const at = clock.now();
  machine.dials.push(at);
  if (!(await admitted("machines"))) {
    // (e): one retry after 1 to 5 s, a second refusal waits for the next instant
    if (!options.noSpacing && !machine.retried) {
      machine.retried = true;
      retries++;
      clock.setTimeout(() => void dialRelay(machine), uniform(1_000, 5_000));
    } else {
      machine.retried = false;
      scheduleMachine(machine, options.halveOnRefusal ? at + CYCLE : at);
    }
    return;
  }
  machine.retried = false;
  const client = arrive(machine, options.noLanes ? "default" : "paced");
  if (!client) { scheduleMachine(machine, at); return; }
  machine.waiting = client;
  machine.cancelGiveUp = clock.setTimeout(() => {
    // no answer within 5 s: it closes and dials at its next instant
    leave(client);
    machine.waiting = undefined;
    scheduleMachine(machine, at);
  }, options.answerMs);
}

/** A client reaches the relay's waiting room; a full room gives way paced-first, and a paced newcomer never displaces a default one. */
function arrive(owner: Machine | Device, lane: RelayLane): Client | undefined {
  if (relayWaiting.length >= WAITING_PLACES) {
    const pacedVictim = relayWaiting.find((client) => client.lane === "paced" && !client.announced);
    const victim = pacedVictim ?? (lane === "default" ? relayWaiting.find((client) => !client.announced) : undefined);
    if (!victim) return undefined;
    closeByRelay(victim);
  }
  const client: Client = { id: `c${++clientIds}`, lane, owner, announced: false, answered: false, gone: false, arrived: clock.now() };
  relayWaiting.push(client);
  if (controlProven !== undefined) announce(client);
  else clock.setTimeout(() => { if (!client.announced && !client.gone) closeByRelay(client); }, OFFLINE_WAIT_MS);
  return client;
}
function leave(client: Client): void {
  client.gone = true;
  client.cancelTake?.();
  const at = relayWaiting.indexOf(client);
  if (at >= 0) relayWaiting.splice(at, 1);
}
function closeByRelay(client: Client): void {
  leave(client);
  const owner = client.owner;
  if ("lossAt" in owner) {
    owner.cancelGiveUp?.();
    owner.waiting = undefined;
    scheduleMachine(owner, clock.now());
  } else { owner.cancel?.(); owner.waiting = undefined; clock.setTimeout(() => void dialDevice(owner), DEVICE_PAUSE_MS); }
}

/** The relay names a waiting client to the controller (sync or connected): it draws a token by lane before it opens anything. */
function announce(client: Client): void {
  client.announced = true;
  client.cancelTake = budget!.take(client.lane, () => void answer(client));
}

async function answer(client: Client): Promise<void> {
  if (client.gone) return;
  // the data socket for this id, from the controller's address
  if (!(await admitted("controller"))) return;
  clock.setTimeout(() => {
    if (client.gone) return;
    client.answered = true;
    const at = relayWaiting.indexOf(client);
    if (at >= 0) relayWaiting.splice(at, 1);
    const owner = client.owner;
    if ("lossAt" in owner) {
      owner.cancelGiveUp?.();
      owner.waiting = undefined;
      signInMachine(owner);
    } else {
      owner.cancel?.();
      owner.waiting = undefined;
      clock.setTimeout(() => { owner.back ??= clock.now(); }, RTT);
    }
  }, RTT);
}

function signInMachine(machine: Machine): void {
  const abort = new AbortController();
  const turn = signIns.run(() => new Promise<boolean>((resolve) => clock.setTimeout(() => resolve(!machine.removed), VERIFY_MS)), abort.signal);
  if (turn === "busy") { refused++; scheduleMachine(machine, clock.now()); return; }
  void turn.then((ok) => {
    if (!ok) { scheduleMachine(machine, clock.now()); return; }
    clock.setTimeout(() => { machine.back ??= clock.now(); }, RTT);
  });
}

// ---------- devices ----------
async function dialDevice(device: Device): Promise<void> {
  if (finished || device.back !== undefined) return;
  if (!(await admitted("devices"))) { clock.setTimeout(() => void dialDevice(device), DEVICE_PAUSE_MS); return; }
  const client = arrive(device, "default");
  if (!client) { clock.setTimeout(() => void dialDevice(device), DEVICE_PAUSE_MS); return; }
  device.waiting = client;
  device.cancel = clock.setTimeout(() => {
    // src/lib/relay/transport.ts: 25 s at the relay, then a 1 s pause and again
    leave(client);
    device.waiting = undefined;
    clock.setTimeout(() => void dialDevice(device), DEVICE_PAUSE_MS);
  }, DEVICE_WAIT_MS);
}

// ---------- the controller ----------
async function controllerReturns(): Promise<void> {
  controllerUp = true;
  budget = new RelaySocketBudget(controllerProfile, clock, options.answerMs);
  budget.take("control", () => void (async () => {
    if (!(await admitted("controller"))) return;
    clock.setTimeout(() => {
      controlProven = clock.now();
      budget!.proven();
      // sync: default-lane clients first, then the paced; the rest as connected, in that order
      const ordered = [...relayWaiting.filter((client) => client.lane !== "paced"), ...relayWaiting.filter((client) => client.lane === "paced")];
      for (const client of ordered) if (!client.announced) announce(client);
      budget!.take("control", () => void admitted("controller"));
      if (options.lateDevices > 0) {
        clock.setTimeout(() => {
          for (let index = 0; index < options.lateDevices; index++) {
            const device: Device = { index: devices.length, late: true, back: undefined };
            devices.push(device);
            void dialDevice(device);
          }
        }, deviceWindowMs(controllerProfile) + 1_000);
      }
    }, 2 * RTT);
  })());
}

// ---------- direct path ----------
interface DirectMachine { readonly index: number; back: number | undefined; backoff: number; hint: number }
async function directStorm(): Promise<Record<string, string | number>> {
  const list: DirectMachine[] = Array.from({ length: options.machines }, (_, index) => ({ index, back: undefined, backoff: 0, hint: 0 }));
  const DOWN_MS = 2_000;
  let pending = 0;
  const dial = (machine: DirectMachine) => {
    if (machine.back !== undefined) return;
    // the controller restarting: the connection is refused at once
    if (clock.now() < DOWN_MS) { retry(machine); return; }
    // server/relay/direct.ts: 64 carriers not signed in at once (each machine is its own source address)
    if (pending >= 64) { refused++; retry(machine); return; }
    pending++;
    clock.setTimeout(() => {
      const turn = signIns.run(() => new Promise<boolean>((resolve) => clock.setTimeout(() => resolve(true), VERIFY_MS)), new AbortController().signal);
      if (turn === "busy") {
        pending--;
        refused++;
        machine.hint = signIns.retryAfterMs();
        retry(machine);
        return;
      }
      void turn.then(() => clock.setTimeout(() => { pending--; machine.back = clock.now(); }, RTT));
    }, 3 * RTT);
  };
  const retry = (machine: DirectMachine) => {
    const ceiling = Math.min(60_000, 1_000 * 2 ** machine.backoff);
    machine.backoff++;
    const wait = Math.max(uniform(0, ceiling), machine.hint);
    machine.hint = 0;
    clock.setTimeout(() => dial(machine), wait);
  };
  // every session ends at 0 with the controller; each machine's first round after a draw of its backoff
  for (const machine of list) retry(machine);
  await clock.run(() => list.every((machine) => machine.back !== undefined), 3_600_000);
  const last = Math.max(...list.map((machine) => machine.back ?? Number.POSITIVE_INFINITY));
  return { PATH: "direct", MACHINES: list.length, ALL_BACK_MS: Number.isFinite(last) ? Math.round(last - DOWN_MS) : "never", REFUSED: refused, PEAK_VERIFYING: signIns.peakRunning };
}

// ---------- the relay storm ----------
async function relayStorm(): Promise<Record<string, string | number>> {
  const total = options.machines;
  // enrol: the first ones, then --enrol-after more once those hold their PACE
  const keys = await Promise.all(Array.from({ length: total + options.remove }, () => newKey()));
  const enrolled: { id: string; ownSlot: number; ownSpan: number }[] = [];
  const early = total - options.enrolAfter;
  for (const [index, key] of keys.slice(0, total).entries()) {
    store.add({ machine_id: key.id, public_key: key.spki });
    store.setState(key.id, "active");
    const ownSpan = index < early ? early : total;
    enrolled.push({ id: key.id, ownSlot: index % ownSpan, ownSpan });
  }
  // --remove: n removed (the first offline at the time, so it never heard auth_revoked), n new ones join
  const removedIds = new Set<string>();
  for (let index = 0; index < options.remove; index++) {
    const gone = enrolled[index * 7 % total]!;
    store.remove(gone.id, { offline: index === 0 });
    removedIds.add(gone.id);
  }
  const slotsBefore = new Map(store.machines().map((machine) => [machine.machine_id, machine.pace_slot]));
  for (const key of keys.slice(total)) {
    store.add({ machine_id: key.id, public_key: key.spki });
    store.setState(key.id, "active");
    enrolled.push({ id: key.id, ownSlot: enrolled.length % total, ownSpan: total });
  }
  const slotsKept = [...slotsBefore].every(([id, slot]) => store.get(id)?.pace_slot === slot);
  const slotOf = (id: string) => store.get(id)?.pace_slot ?? 0;
  // the actors: every active machine, and the one removed while offline, which dials on as a stale machine
  const offlineRemoved = options.remove > 0 ? enrolled[0]!.id : undefined;
  const actors = enrolled.filter((entry) => !removedIds.has(entry.id) || entry.id === offlineRemoved);
  const staleIndexes = new Set<number>();
  if (offlineRemoved) staleIndexes.add(actors.findIndex((entry) => entry.id === offlineRemoved));
  for (let index = actors.length - 1; staleIndexes.size < Math.min(options.stale, actors.length) && index >= 0; index--) staleIndexes.add(index);
  const offlineSlot = options.remove > 0 ? store.retiredPaceSlots()[0] ?? slotsBefore.get(offlineRemoved!) ?? 0 : 0;
  for (const [index, entry] of actors.entries()) {
    const removed = entry.id === offlineRemoved;
    machines.push({
      index, id: entry.id, slot: removed ? (offlineSlot ?? 0) : slotOf(entry.id), stale: staleIndexes.has(index), removed,
      error: staleIndexes.has(index) ? 0 : uniform(0, options.clockError), phase: uniform(-CYCLE / 2, CYCLE / 2),
      ownSlot: entry.ownSlot, ownSpan: entry.ownSpan, lossAt: 0, back: undefined, retried: false, backoff: 0, dials: [],
    });
  }
  for (let index = 0; index < options.devices; index++) devices.push({ index, late: false, back: undefined });

  const wave = options.wave > 0;
  if (wave) {
    // a connected fleet (the controller up, its bucket past the devices' window) and n machines joining or waking at once
    restartAt = 0;
    await controllerReturns();
    await clock.run(() => controlProven !== undefined, 10_000);
    clock.at(deviceWindowMs(controllerProfile) + 10_000, () => {
      const startAt = clock.now();
      restartAt = startAt;
      const joining = machines.slice(0, options.wave);
      for (const machine of machines.slice(options.wave)) machine.back = startAt;
      for (const machine of joining) { machine.lossAt = startAt; scheduleMachine(machine, startAt); }
    });
    if (options.sleeper) {
      // one connected machine frozen 15 minutes: no dial while frozen, then the next instant of its own after the wake
      const sleeper = machines[machines.length - 1]!;
      clock.at(deviceWindowMs(controllerProfile) + 20_000, () => {
        sleeper.back = undefined;
        sleeper.frozenUntil = clock.now() + 15 * 60_000;
        sleeper.lossAt = clock.now();
        clock.at(sleeper.frozenUntil, () => scheduleMachine(sleeper, clock.now()));
      });
    }
  } else {
    // the controller goes at 0 and returns at loss-spread (at least 1 s): each machine lost its session at its own moment
    restartAt = Math.max(1_000, options.lossSpread);
    for (const machine of machines) {
      machine.lossAt = uniform(0, Math.max(0, restartAt - 1));
      clock.at(machine.lossAt, () => scheduleMachine(machine, machine.lossAt));
    }
    // half the pages are visible and dial again at once; a hidden page backs off up to 30 s (src/lib/relay/transport.ts)
    for (const device of devices) clock.at(device.index % 2 === 0 ? uniform(0, 1_000) : uniform(0, 30_000), () => void dialDevice(device));
    clock.at(restartAt + STARTUP_MS, () => void controllerReturns());
  }
  const counted = () => machines.filter((machine) => !machine.removed);
  const allBack = () => counted().every((machine) => machine.back !== undefined) && devices.every((device) => device.back !== undefined)
    && (!options.sleeper || machines[machines.length - 1]!.back !== undefined) && (!wave || controlProven !== undefined);
  await clock.run(allBack, 3_600_000);
  finished = true;
  budget?.stop();

  const since = (at: number | undefined) => at === undefined ? "never" : Math.round(at - restartAt);
  const lastOf = (times: (number | undefined)[]) => times.some((at) => at === undefined) ? undefined : Math.max(restartAt, ...(times as number[]));
  // SAME_INSTANT: pairs of machines that are not stale whose first nominal instants after their loss fall within one spacing
  // (less a float's rounding: a spacing of 60000 / 22 ms is not a whole number)
  const nominal = counted().filter((machine) => !machine.stale).map((machine) => nominalAfter(machine, machine.lossAt)).sort((a, b) => a - b);
  let same = 0;
  for (let index = 0; index < nominal.length; index++) for (let other = index + 1; other < nominal.length && nominal[other]! - nominal[index]! < machineProfile.spacing_ms - 1e-6; other++) same++;
  const report: Record<string, string | number> = {
    PATH: "relay", LIMITS: options.limits, SEED: options.seed, MACHINES: counted().length, STALE: machines.filter((machine) => machine.stale).length,
    PACE: machineProfile.per_minute, SPAN, SPACING_MS: machineProfile.spacing_ms,
    CONTROL_BACK_MS: controlProven === undefined ? "never" : Math.round(controlProven - (wave ? 0 : restartAt)),
    // the bound (arithmetic (4)) is for the machines that are not stale; a stale one dials on its own guess, once a cycle
    ALL_BACK_MS: since(lastOf(counted().filter((machine) => !machine.stale).map((machine) => machine.back))),
    STALE_BACK_MS: machines.some((machine) => machine.stale && !machine.removed) ? since(lastOf(counted().filter((machine) => machine.stale).map((machine) => machine.back))) : "none",
    RATE_LIMITED: rateLimited, RETRIES: retries, SAME_INSTANT: same,
    DEVICES_BACK_MS: since(lastOf(devices.filter((device) => !device.late).map((device) => device.back))),
    LATE_DEVICE_MS: options.lateDevices ? since(lastOf(devices.filter((device) => device.late).map((device) => device.back))) : "none",
    MAX_DIALS_PER_MINUTE_PER_ADDRESS: mostIn60s(dialsAt.machines),
    MAX_CONTROLLER_SOCKETS_PER_MINUTE: mostIn60s(budget?.granted ?? []),
    PACE_SLOTS_KEPT: slotsKept ? "yes" : "no",
  };
  if (wave) {
    // the documented bound (docs/fleet-link.md, arithmetic (4)): R (at most 10 s) + W + one cycle + one spacing + E
    report["WAVE"] = options.wave;
    report["WAVE_BOUND_MS"] = Math.round(10_000 + deviceWindowMs(controllerProfile) + CYCLE + machineProfile.spacing_ms + options.clockError);
  }
  if (options.sleeper) {
    const sleeper = machines[machines.length - 1]!;
    const woke = sleeper.frozenUntil ?? 0;
    const after = sleeper.dials.filter((at) => at >= woke);
    const onGrid = after.every((at) => Math.abs(((at - sleeper.error) / machineProfile.spacing_ms - sleeper.slot) % SPAN) < 1e-6 || sleeper.stale);
    report["SLEEPER_DIALS_FIRST_CYCLE"] = after.filter((at) => at < woke + CYCLE).length;
    report["SLEEPER_ON_GRID"] = onGrid ? "yes" : "no";
    report["SLEEPER_BACK_AFTER_WAKE_MS"] = sleeper.back === undefined ? "never" : Math.round(sleeper.back - woke);
  }
  return report;
}

try {
  const report = options.path === "direct" ? await directStorm() : await relayStorm();
  for (const [key, entry] of Object.entries(report)) console.log(`${key}=${entry}`);
  const back = report["ALL_BACK_MS"];
  if (options.bound > 0 && !(typeof back === "number" && back <= options.bound)) {
    console.error(`fleet storm: ALL_BACK_MS=${back} is past the bound of ${options.bound} ms`);
    process.exitCode = 1;
  }
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

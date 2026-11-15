/**
 * The relay pace of docs/fleet-link.md (todo 37): how often fleet machines may dial one relay, and the controller's own
 * budget of sockets to it, from the per-address budget the relay names in `sync` (`per_address_per_minute`; 30 when it
 * names none). Machines dial only at the instants `(slot + k * span) * spacing` of the controller's clock, so 100
 * machines that lost their sessions at any moments still dial one per spacing, and the controller opens no more than
 * `burst + per_minute` sockets in any minute. Pure functions and a token bucket on an injected clock: the storm
 * (scripts/fleet-storm.ts) and the relay link (server/relay/link.ts) run the same code.
 */
import type { MuxClock } from "../../shared/relay-mux-engine.ts";

/** What a relay that names no budget is taken to allow (the hosted Worker's 30 a minute per address). */
export const DEFAULT_RELAY_BUDGET = 30;
/**
 * The machines' pace on the hosted budget (the owner's decision, todo 37): 22 a minute, two below the controller's own
 * 24, so its bucket has a token a minute left over for a stale machine's dial or a late device and does not take one a
 * machine on its instant needs. With it 100 machines are back within 300 s (the storm, seeds 1-50). Any other budget
 * paces the machines as the controller.
 */
export const HOSTED_MACHINE_PER_MINUTE = 22;
/** PACE's own range (docs/fleet-link.md, Fields): 1..600 a minute. */
const MAX_PER_MINUTE = 600;
/** The default slot's span, before a machine holds a PACE (and the default fleet size). */
export const DEFAULT_SPAN = 100;
/** A PACE goes to every connected machine this often, and whenever any of its fields changes. */
export const PACE_REFRESH_MS = 10 * 60_000;
/** A machine dial gets this long for the controller to answer it (the app gives 15 s: relay/core.ts). */
export const MACHINE_ANSWER_MS = 5_000;
/**
 * The devices' window after the controller's control socket is proven again: each device whose session the restart
 * ended is announced within 31 s (25 s waiting at the relay, a 1 s pause, a hidden page backing off at most 30 s:
 * src/lib/relay/transport.ts), and the bucket's worst shortfall then is 13 tokens (the plan's arithmetic (3)), refilled
 * within 13 spacings.
 */
export const DEVICE_WINDOW_FLOOR_MS = 31_000;
export const DEVICE_SHORTFALL_TOKENS = 13;

export interface RelayPaceProfile {
  /** the budget the relay named, or DEFAULT_RELAY_BUDGET */
  readonly budget: number;
  /** machine dials a minute from the machines' address: four fifths of the budget */
  readonly per_minute: number;
  /** what the controller may open beyond its refill at once: the rest of the budget less control and warm */
  readonly burst: number;
  /** one refill of the controller's bucket to the next */
  readonly spacing_ms: number;
  /** machine dials a minute on the timeline (what PACE carries): per_minute, or HOSTED_MACHINE_PER_MINUTE on the hosted budget */
  readonly machine_per_minute: number;
  /** one machine instant to the next */
  readonly machine_spacing_ms: number;
}

/** The pace for a relay that names `budget` dials a minute per address (anything else: DEFAULT_RELAY_BUDGET). */
export function relayPace(budget?: number | null): RelayPaceProfile {
  const named = typeof budget === "number" && Number.isSafeInteger(budget) && budget >= 2 ? budget : DEFAULT_RELAY_BUDGET;
  const perMinute = Math.min(MAX_PER_MINUTE, Math.floor(named * 4 / 5));
  const machines = named === DEFAULT_RELAY_BUDGET ? HOSTED_MACHINE_PER_MINUTE : perMinute;
  return { budget: named, per_minute: perMinute, burst: Math.max(0, named - perMinute - 2), spacing_ms: 60_000 / perMinute, machine_per_minute: machines, machine_spacing_ms: 60_000 / machines };
}

/** The slots of the timeline: never fewer than the fleet's machines, nor than the dials of one minute. */
export const paceSpan = (fleetMax: number, perMinute: number): number => Math.max(fleetMax, perMinute);

/** A machine's slot before its first PACE: its id's first four hex digits mod 100. */
export const defaultPaceSlot = (machineId: string): number => Number.parseInt(machineId.slice(0, 4), 16) % DEFAULT_SPAN;

/**
 * The first instant of `slot` on the controller's clock strictly after `after` (ms): `(slot + k * span) * spacing` for
 * the least integer k that makes it later. It depends only on the slot, the span, the spacing and `after`.
 */
export function nextPaceInstant(pace: { readonly slot: number; readonly span: number; readonly spacing_ms: number }, after: number): number {
  const cycle = pace.span * pace.spacing_ms;
  const k = Math.floor((after - pace.slot * pace.spacing_ms) / cycle) + 1;
  return (pace.slot + k * pace.span) * pace.spacing_ms;
}

/** The devices' window W after the control socket is proven again: max(31 s, 13 spacings). */
export const deviceWindowMs = (profile: RelayPaceProfile): number => Math.max(DEVICE_WINDOW_FLOOR_MS, DEVICE_SHORTFALL_TOKENS * profile.spacing_ms);

export type RelayLane = "control" | "default" | "paced";

interface Waiter { readonly lane: RelayLane; readonly at: number; readonly grant: () => void; readonly deadline: number | undefined; readonly expire: (() => void) | undefined }

/**
 * Every socket the controller opens to one relay while fleet machines use it (docs/fleet-link.md, "The relay pace"):
 * one bucket of `burst` tokens that refills `per_minute` a minute. The control and warm sockets go first; then, during
 * the devices' window after the control socket is proven (`proven`), a default-lane client (a device) before any paced
 * one; after it a default-lane client takes only a spare token (one beyond the next machine's), and a paced client one
 * no waiting default-lane client takes. A paced client that finds none within MACHINE_ANSWER_MS goes unanswered: its
 * machine dials again at its next instant.
 */
export class RelaySocketBudget {
  private tokens: number;
  private updated: number;
  private readonly queue: Waiter[] = [];
  private provenAt: number | undefined;
  private cancelTimer: (() => void) | undefined;
  /** sockets granted, with when: what the storm reports as the controller's sockets a minute */
  readonly granted: number[] = [];

  /** `answerMs`: how long a paced client may wait for its token (MACHINE_ANSWER_MS; the storm measures others). */
  constructor(private profile: RelayPaceProfile, private readonly clock: MuxClock, private readonly answerMs = MACHINE_ANSWER_MS) {
    this.tokens = RelaySocketBudget.capacity(profile);
    this.updated = clock.now();
  }

  /** The bucket's size: `burst`, never below the two a device past its window needs. */
  private static capacity(profile: RelayPaceProfile): number { return Math.max(2, profile.burst); }

  get pace(): RelayPaceProfile { return this.profile; }

  /** The relay named another budget: the bucket keeps what it holds, within the new size. */
  setProfile(profile: RelayPaceProfile): void {
    this.refill();
    this.profile = profile;
    this.tokens = Math.min(this.tokens, RelaySocketBudget.capacity(profile));
    this.pump();
  }

  /**
   * The control socket was proven again (`sync`): the devices' window starts now. The first time (the controller's
   * return, R) the bucket starts full at the size the relay's budget gives.
   */
  proven(): void {
    if (this.provenAt === undefined) { this.tokens = RelaySocketBudget.capacity(this.profile); this.updated = this.clock.now(); }
    this.provenAt = this.clock.now();
    this.pump();
  }

  /**
   * Calls `grant` once a token is drawn for a socket of `lane`; a paced client gives up after MACHINE_ANSWER_MS
   * (`expire`). Returns the cancel.
   */
  take(lane: RelayLane, grant: () => void, expire?: () => void): () => void {
    const now = this.clock.now();
    const waiter: Waiter = { lane, at: now, grant, deadline: lane === "paced" ? now + this.answerMs : undefined, expire };
    this.queue.push(waiter);
    this.pump();
    return () => {
      const at = this.queue.indexOf(waiter);
      if (at >= 0) { this.queue.splice(at, 1); this.pump(); }
    };
  }

  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(RelaySocketBudget.capacity(this.profile), this.tokens + Math.max(0, now - this.updated) * this.profile.per_minute / 60_000);
    this.updated = now;
  }

  private inWindow(now: number): boolean {
    return this.provenAt !== undefined && now - this.provenAt < deviceWindowMs(this.profile);
  }

  /** The waiter to serve next and the tokens it needs on hand, or undefined. */
  private next(now: number): { waiter: Waiter; need: number } | undefined {
    const first = (lane: RelayLane) => this.queue.find((waiter) => waiter.lane === lane);
    const control = first("control");
    if (control) return { waiter: control, need: 1 };
    const device = first("default");
    const machine = first("paced");
    if (device && this.inWindow(now)) return { waiter: device, need: 1 };
    if (machine) return { waiter: machine, need: 1 };
    // past the window a device takes a spare token only: one more than the next machine instant needs
    if (device) return { waiter: device, need: 2 };
    return undefined;
  }

  private pump(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    for (;;) {
      this.refill();
      const now = this.clock.now();
      for (const waiter of this.queue.filter((candidate) => candidate.deadline !== undefined && candidate.deadline <= now)) {
        this.queue.splice(this.queue.indexOf(waiter), 1);
        waiter.expire?.();
      }
      const next = this.next(now);
      if (!next) break;
      if (this.tokens < next.need) {
        const wait = Math.ceil((next.need - this.tokens) * 60_000 / this.profile.per_minute);
        const deadlines = this.queue.flatMap((waiter) => waiter.deadline === undefined ? [] : [waiter.deadline - now]);
        const windowEnds = this.provenAt === undefined ? [] : [this.provenAt + deviceWindowMs(this.profile) - now].filter((left) => left > 0);
        this.cancelTimer = this.clock.setTimeout(() => this.pump(), Math.max(1, Math.min(wait, ...deadlines, ...windowEnds)));
        return;
      }
      this.tokens -= 1;
      this.queue.splice(this.queue.indexOf(next.waiter), 1);
      this.granted.push(now);
      next.waiter.grant();
    }
    const deadlines = this.queue.flatMap((waiter) => waiter.deadline === undefined ? [] : [waiter.deadline - this.clock.now()]);
    if (deadlines.length) this.cancelTimer = this.clock.setTimeout(() => this.pump(), Math.max(1, Math.min(...deadlines)));
  }

  /** Ends every wait (the link stopped). */
  stop(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.queue.length = 0;
  }
}

/**
 * The controller's queue of machine sign-ins (docs/fleet-link.md, "Many machines at once", todo 37): at most
 * SIGN_IN_CONCURRENCY signatures are verified at a time, the others wait in the order their AUTH came, and a queued
 * machine is never dropped for a newer one: a newcomer that finds the waiting places taken is told to come back later
 * instead (`busy`; on a direct carrier a close 1013 with `retry_after_ms`). A direct carrier's machines wait in
 * SIGN_IN_WAITING places (they keep their places in the listener, so 16 of its 64 stay for phones); others in up to
 * SIGN_IN_WAITING_ELSEWHERE, bounded by their room or their sessions. A machine whose carrier closes while it
 * waits gives its place back at once. Each waiting machine holds one small record (its job and abort listener), so
 * the queue's memory is bounded by SIGN_IN_WAITING. Device sign-ins never pass through it.
 */
export const SIGN_IN_CONCURRENCY = 16;
/**
 * 16 verifying and 32 waiting hold at most 48 of a direct listener's 64 places for clients not signed in
 * (server/relay/direct.ts MAX_PENDING), since a queued machine keeps its place: 16 stay for phones.
 */
export const SIGN_IN_WAITING = 32;
/**
 * Waiting places for a machine that did not come through a direct carrier (a relay link, whose room bounds its waiting
 * clients, or an in-process session): as many as the fleet's largest size (store.ts FLEET_MAX_LIMIT).
 */
export const SIGN_IN_WAITING_ELSEWHERE = 1000;
/** The longest hint a busy answer gives (the link agent reads at most a minute). */
const MAX_RETRY_AFTER_MS = 60_000;

interface Waiting { readonly start: () => void; readonly signal: AbortSignal; readonly drop: () => void }

export class SignInQueue {
  private running = 0;
  private readonly waiting: Waiting[] = [];
  /** the most verifications that ran at once, for the storm's report and the tests */
  peakRunning = 0;
  /** newcomers told to come back later */
  busy = 0;

  constructor(private readonly concurrency = SIGN_IN_CONCURRENCY, private readonly capacity = SIGN_IN_WAITING_ELSEWHERE) {}

  get size(): { readonly running: number; readonly waiting: number } { return { running: this.running, waiting: this.waiting.length }; }

  /**
   * Runs `verify` in its turn, or answers "busy" at once when the queue is full. Rejects with the signal's reason when
   * `signal` aborts before its turn (the carrier closed), and its place goes to the next.
   */
  run<T>(verify: () => Promise<T>, signal: AbortSignal, capacity = this.capacity): Promise<T> | "busy" {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.running < this.concurrency && this.waiting.length === 0) return this.start(verify);
    if (this.waiting.length >= Math.min(capacity, this.capacity)) { this.busy++; return "busy"; }
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const drop = () => {
      const at = this.waiting.indexOf(entry);
      if (at >= 0) { this.waiting.splice(at, 1); reject(signal.reason); }
    };
    const entry: Waiting = { signal, drop, start: () => { this.start(verify).then(resolve, reject); } };
    signal.addEventListener("abort", drop, { once: true });
    this.waiting.push(entry);
    return promise;
  }

  /** How long a machine told "busy" should wait: one turn of the queue per SIGN_IN_CONCURRENCY waiting ahead of it, a second each. */
  retryAfterMs(): number {
    return Math.min(MAX_RETRY_AFTER_MS, 1_000 * Math.ceil((this.waiting.length + 1) / this.concurrency));
  }

  private start<T>(verify: () => Promise<T>): Promise<T> {
    this.running++;
    this.peakRunning = Math.max(this.peakRunning, this.running);
    let work: Promise<T>;
    try { work = verify(); } catch (error) { work = Promise.reject(error); }
    return work.finally(() => {
      this.running--;
      this.next();
    });
  }

  private next(): void {
    while (this.running < this.concurrency) {
      const entry = this.waiting.shift();
      if (!entry) return;
      entry.signal.removeEventListener("abort", entry.drop);
      entry.start();
    }
  }
}

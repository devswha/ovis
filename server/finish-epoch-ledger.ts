import type { SessionSnapshot } from "../shared/protocol.ts";

/** the ended runs one PC's ledger remembers: one per herdr restart, oldest first out */
const MAX_ENDED = 64;

/**
 * Which herdr runs (finish epochs, server/finishes.ts) of one PC this server knows have ended, for its read
 * finishes (server/seen.ts). The epoch a snapshot names proves nothing about the others: a read delivered late
 * (a WebSocket frame overtaken by an HTTP read of the same order pair) names a run that is already over. A PC's
 * server moves its epoch forward only, and labels each read when it ends, so a read known to have started
 * after every snapshot and status of the PC that reached this server is newer than all of them (`settle`): each
 * other epoch held since the last such read has ended. A cache change without that proof only holds its epoch
 * (`hold`). A run ended by a read of the server that started it (same `order_epoch`) never comes back: a
 * snapshot or status naming it is old (`stale`). One ended by another server of the PC is over while that one
 * answers, and a read naming it again holds it again.
 */
export class FinishEpochLedger {
  /** each epoch the cache took since the last settled read, with the order epoch (the PC's server) that named it */
  private held = new Map<string, string | undefined>();
  /** the ended runs; true: the server that started the run moved on from it */
  private ended = new Map<string, boolean>();

  /** `snapshot`: the one restored from disk, whose run may have ended since it was saved */
  constructor(snapshot?: SessionSnapshot | null) {
    if (snapshot) this.hold(snapshot);
  }

  /** the cache took this snapshot without proof that it is newer than the others it held */
  hold(snapshot: SessionSnapshot): void {
    const epoch = snapshot.finish_epoch;
    if (!epoch) return;
    this.held.set(epoch, snapshot.order_epoch);
    if (this.ended.get(epoch) === false) this.ended.delete(epoch);
  }

  /** the cache took a read that started after every snapshot and status it held had arrived */
  settle(snapshot: SessionSnapshot): void {
    const epoch = snapshot.finish_epoch;
    if (!epoch) return;
    const server = snapshot.order_epoch;
    for (const [held, from] of this.held) if (held !== epoch) this.end(held, server !== undefined && from === server);
    this.held = new Map([[epoch, server]]);
    this.ended.delete(epoch);
  }

  /** a snapshot or status naming this epoch was read before one this server already took */
  stale(epoch: string | undefined): boolean {
    return epoch !== undefined && this.ended.get(epoch) === true;
  }

  endedEpochs(): Set<string> {
    return new Set(this.ended.keys());
  }

  copy(): FinishEpochLedger {
    const copy = new FinishEpochLedger();
    copy.held = new Map(this.held);
    copy.ended = new Map(this.ended);
    return copy;
  }

  private end(epoch: string, own: boolean): void {
    const before = this.ended.get(epoch) === true;
    this.ended.delete(epoch);
    this.ended.set(epoch, own || before);
    for (const old of this.ended.keys()) {
      if (this.ended.size <= MAX_ENDED) break;
      this.ended.delete(old);
    }
  }
}

/**
 * The signed-in sessions one PC serves, whichever way they came: the relay links (global and regional)
 * and the direct carriers count against the same limits, so no way in adds places of its own.
 */
export class SignedInSessions {
  private order = 0;
  private readonly entries = new Set<{ readonly deviceId: string; order: number; chosen: boolean; readonly close: () => void }>();

  /**
   * at most `max` at once, and `perDevice` chosen for one device key, whose oldest gives way; at most `perDeviceCandidates`
   * not chosen yet for one device key (an app races its carriers: two direct ones and the relay)
   */
  constructor(private readonly max = 8, private readonly perDevice = 4, private readonly perDeviceCandidates = 3) {}

  get size(): number { return this.entries.size; }

  /** Counts a session that just signed in and is used at once: `candidate`, then `chosen`. */
  admit(deviceId: string, close: () => void): () => void {
    const admission = this.candidate(deviceId, close);
    admission.chosen();
    return admission.release;
  }

  private chosenOf(deviceId: string): number {
    return [...this.entries].filter((other) => other.deviceId === deviceId && other.chosen).length;
  }

  /**
   * Counts a session that just signed in but may be one of an app's racing carriers, which it closes again if
   * another came up first (src/lib/relay/transport.ts): it takes a place, but no other session of its device
   * gives way for it until `chosen` (its first stream). One past every place is closed itself; past its device's
   * candidates, the oldest of them is. `release` ends its count (idempotent).
   */
  candidate(deviceId: string, close: () => void): { readonly release: () => void; readonly chosen: () => void } {
    const entry = { deviceId, order: ++this.order, chosen: false, close };
    this.entries.add(entry);
    const release = (): void => { this.entries.delete(entry); };
    // past its device's racing carriers, the oldest of them gives way: one that never opened a stream was dropped,
    // or lost on its way (a newest-gives-way rule would keep such a dead one and shut the device out)
    const waiting = [...this.entries].filter((other) => other.deviceId === deviceId && !other.chosen).sort((left, right) => left.order - right.order);
    for (const oldest of waiting.slice(0, Math.max(0, waiting.length - this.perDeviceCandidates))) {
      this.entries.delete(oldest);
      oldest.close();
    }
    // with every place taken, a device at its share still gets in (once used, its own oldest gives way), but never
    // more than one device's racing carriers past every place
    const over = this.entries.size - this.max;
    if (over > 0 && (this.chosenOf(deviceId) < this.perDevice || over > this.perDeviceCandidates)) {
      release();
      close();
    }
    return {
      release,
      chosen: () => {
        if (entry.chosen || !this.entries.has(entry)) return;
        entry.chosen = true;
        entry.order = ++this.order;
        // the device's own oldest give way, so a device at its share always gets its new session in
        const own = [...this.entries].filter((other) => other.deviceId === deviceId && other.chosen).sort((a, b) => a.order - b.order);
        for (const oldest of own.slice(0, Math.max(0, own.length - this.perDevice))) {
          this.entries.delete(oldest);
          oldest.close();
        }
      },
    };
  }
}

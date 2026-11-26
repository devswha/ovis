import { OUTPUT_HIGH_BYTES } from "../output-window.ts";

/** hc writes an attach's history replay in 16 KiB frames under 5 ms apart: a gap this long ends it */
export const ATTACH_BATCH_QUIET_MS = 15;
/** the longest an attach's first output is held: a program that prints all along never leaves a gap */
export const ATTACH_BATCH_MAX_MS = 150;

/**
 * Holds a herdr-core attach's first output (the cleared screen and the history hc replays) until hc goes quiet,
 * and passes it on as one frame. Sent frame by frame, a viewer draws the history between them: the pane is seen
 * scrolling down through it on every switch, instead of opening at its newest rows. Output past the first gap
 * goes on as it comes. A batch passes on what it holds every OUTPUT_HIGH_BYTES, under the viewer's output window.
 */
export class AttachBatch {
  private held: string[] = [];
  private bytes = 0;
  private open = true;
  private quiet: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly forward: (data: string) => void) {}

  push(data: string): void {
    if (!this.open) {
      this.forward(data);
      return;
    }
    this.held.push(data);
    this.bytes += Buffer.byteLength(data);
    if (this.bytes >= OUTPUT_HIGH_BYTES) this.send();
    clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.end(), ATTACH_BATCH_QUIET_MS);
    this.deadline ??= setTimeout(() => this.end(), ATTACH_BATCH_MAX_MS);
  }

  /** passes on what is held, and everything after it as it comes (the attach ended, or hc went quiet) */
  end(): void {
    this.open = false;
    clearTimeout(this.quiet);
    clearTimeout(this.deadline);
    this.send();
  }

  private send(): void {
    if (this.held.length === 0) return;
    const data = this.held.join("");
    this.held = [];
    this.bytes = 0;
    this.forward(data);
  }
}

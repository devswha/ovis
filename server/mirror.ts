/**
 * A terminal for a herdr that cannot `terminal attach` (Windows, herdrdev/herdr#4821).
 */
import { HerdrError } from "./herdr/client.ts";

export const MIRROR_ACTIVE_MS = 80;
export const MIRROR_IDLE_MS = 400;
export const MIRROR_ECHO_MS = 15;
export const MIRROR_WHOLE_MS = 10_000;
export const MIRROR_QUIET_MS = 1000;
export const MIRROR_SIZE_MS = 2000;
const MIRROR_FAILURES = 10;

export interface MirrorOptions {
  read: () => Promise<string>;
  write: (data: string) => Promise<unknown>;
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
  cols: number;
  rows: number;
  size?: () => Promise<{ cols: number; rows: number } | null>;
  onResize?: (cols: number, rows: number) => void;
  activeMs?: number;
  idleMs?: number;
  sizeMs?: number;
  echoMs?: number;
  wholeMs?: number;
  quietMs?: number;
}

export function mirrorFrame(screen: string, gridRows = Number.POSITIVE_INFINITY): string {
  return `\x1b[?25l\x1b[0m\x1b[H\x1b[2J\x1b[?7l${rowsOf(screen).slice(-gridRows).join("\r\n")}\x1b[0m\x1b[?7h`;
}

const rowsOf = (screen: string): string[] => screen.replace(/(?:\r?\n)+$/, "").split(/\r?\n/);
export function mirrorRows(before: string, after: string, gridRows: number): string {
  const was = rowsOf(before).slice(-gridRows);
  const now = rowsOf(after).slice(-gridRows);
  const last = now.length - 1;
  let frame = "\x1b[?25l\x1b[?7l";
  for (let row = 0; row < Math.max(was.length, now.length); row++) {
    if (row === last || was[row] === now[row]) continue;
    frame += `\x1b[${row + 1};1H\x1b[0m\x1b[2K${now[row] ?? ""}`;
  }
  return `${frame}\x1b[${last + 1};1H\x1b[0m\x1b[2K${now[last]}\x1b[0m\x1b[?7h`;
}

export class MirrorSession {
  readonly exited: Promise<void>;
  private finish!: () => void;
  private closed = false;
  private paused = false;
  private screen: string | null = null;
  private sent: string | null = null;
  private failures = 0;
  private delay: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cols: number;
  private rows: number;
  private sizedAt = Date.now();
  private wholeAt = 0;
  private reading = false;
  private poked = false;
  private echoing = false;
  private patched = false;
  private changedAt = 0;

  constructor(private readonly options: MirrorOptions) {
    this.exited = new Promise((resolve) => { this.finish = resolve; });
    this.delay = options.activeMs ?? MIRROR_ACTIVE_MS;
    this.cols = options.cols;
    this.rows = options.rows;
    void this.tick();
  }

  private async tick(): Promise<void> {
    try {
      await this.readOnce();
    } catch (error) {
      if (this.closed) return;
      console.error(`pane mirror stopped: ${error instanceof Error ? error.message : String(error)}`);
      this.closed = true;
      this.finish();
      this.options.onExit(null);
    }
  }

  private async readOnce(): Promise<void> {
    this.echoing = false;
    if (this.closed) return;
    const active = this.options.activeMs ?? MIRROR_ACTIVE_MS;
    const idle = this.options.idleMs ?? MIRROR_IDLE_MS;
    this.reading = true;
    if (this.options.size && Date.now() - this.sizedAt >= (this.options.sizeMs ?? MIRROR_SIZE_MS)) {
      this.sizedAt = Date.now();
      const size = await this.options.size().catch(() => null);
      if (this.closed) return;
      if (size && (size.cols !== this.cols || size.rows !== this.rows)) {
        this.cols = size.cols;
        this.rows = size.rows;
        try { this.options.onResize?.(size.cols, size.rows); } catch (error) { console.error(`pane mirror resize: ${error instanceof Error ? error.message : String(error)}`); }
        this.sent = null;
        this.screen = null;
      }
    }
    try {
      this.screen = await this.options.read();
      this.failures = 0;
    } catch (error) {
      this.reading = false;
      if (this.closed) return;
      const gone = error instanceof HerdrError && error.code !== "connect_failed" && error.code !== "timeout";
      if (gone || ++this.failures >= MIRROR_FAILURES) {
        this.closed = true;
        this.finish();
        this.options.onExit(null);
        return;
      }
      this.timer = setTimeout(() => void this.tick(), idle);
      return;
    }
    this.reading = false;
    if (this.closed) return;
    const changed = this.flush();
    this.delay = changed ? active : Math.min(idle, Math.ceil(this.delay * 1.5));
    if (changed) this.changedAt = Date.now();
    else if (this.screen === this.sent && Date.now() - this.changedAt >= (this.options.quietMs ?? MIRROR_QUIET_MS)) this.settle();
    if (this.poked) {
      this.poked = false;
      this.delay = active;
      this.echoing = true;
      this.timer = setTimeout(() => void this.tick(), this.options.echoMs ?? MIRROR_ECHO_MS);
      return;
    }
    this.timer = setTimeout(() => void this.tick(), this.delay);
  }

  private flush(): boolean {
    if (this.paused || this.screen === null || this.screen === this.sent) return false;
    const all = mirrorFrame(this.screen, this.rows);
    const due = this.sent === null || Date.now() - this.wholeAt >= (this.options.wholeMs ?? MIRROR_WHOLE_MS);
    const rows = due ? null : mirrorRows(this.sent!, this.screen, this.rows);
    const whole = rows === null || Buffer.byteLength(rows) >= Buffer.byteLength(all);
    const frame = whole ? all : rows;
    if (whole) this.wholeAt = Date.now();
    this.patched = !whole;
    this.sent = this.screen;
    this.options.onData(frame);
    return true;
  }

  private settle(): void {
    if (!this.patched || this.paused || this.sent === null) return;
    this.patched = false;
    this.wholeAt = Date.now();
    this.options.onData(mirrorFrame(this.sent, this.rows));
  }

  poke(): void {
    if (this.closed) return;
    if (this.reading) { this.poked = true; return; }
    if (this.echoing) return;
    this.echoing = true;
    clearTimeout(this.timer);
    this.delay = this.options.activeMs ?? MIRROR_ACTIVE_MS;
    this.timer = setTimeout(() => void this.tick(), this.options.echoMs ?? MIRROR_ECHO_MS);
  }

  get current(): string | null {
    return this.sent === null ? null : mirrorFrame(this.sent, this.rows);
  }

  write(data: string): void {
    if (this.closed) return;
    void this.options.write(data).then(() => this.poke(), () => undefined);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused || this.closed) return;
    this.paused = false;
    this.flush();
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.finish();
  }
}

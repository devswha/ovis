import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";

/** A transcript's identity, length and clock, in the form `lstatSync` gives (historyVersion), so the two compare. */
export interface TranscriptVersion { id: string; size: number; mtimeMs: number }
export const transcriptVersion = (stat: Stats): TranscriptVersion | null => stat.isFile() ? { id: `${stat.dev}:${stat.ino}`, size: stat.size, mtimeMs: stat.mtimeMs } : null;

export class TranscriptBusyError extends Error {
  constructor(message = "the transcript reader is busy") { super(message); this.name = "TranscriptBusyError"; }
}

/** The small native surface also lets lifecycle tests hold actual operation settlement. */
export interface TranscriptHandle {
  stat(): Promise<Stats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface TranscriptIO {
  open(path: string): Promise<TranscriptHandle>;
  stat(path: string): Promise<Stats>;
}
const nativeIO: TranscriptIO = {
  open: async (path) => {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    return { stat: () => handle.stat(), read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position), close: () => handle.close() };
  },
  stat: (path) => lstat(path),
};
const WINDOW_BYTES = 1024 * 1024;

export interface TranscriptFile {
  /** Identity already checked when this handle was opened, without another metadata round trip. */
  readonly initial: TranscriptVersion;
  stat(): Promise<TranscriptVersion>;
  pathVersion(): Promise<TranscriptVersion | null>;
  /** Owned bytes, at an explicit position, at most one MiB. Short reads are completed up to EOF. */
  read(position: number, length: number): Promise<Buffer>;
  /** The same bytes in a buffer the lease keeps for them, so no window is allocated: they hold only until the next `window` or the lease's end. */
  window(position: number, length: number): Promise<Buffer>;
}
interface Request {
  path: string;
  live: boolean;
  started: boolean;
  run(): Promise<void>;
  cancel(): void;
}

/**
 * One main-process reader. A lease owns its path, handle and native-operation allowance until
 * close actually settles. Cancellation ends only the caller's wait. Native async FS uses Bun's
 * shared runtime pool; this bound does not reserve runtime capacity or interrupt a stuck syscall.
 */
export class TranscriptReader {
  private readonly queue: Request[] = [];
  private readonly active = new Set<Request>();
  private readonly paths = new Set<string>();
  private resetting = false;
  private readonly idle = new Set<() => void>();
  /** `window` buffers of leases that ended, every native operation on them settled */
  private readonly spare: Buffer[] = [];
  constructor(private readonly io: TranscriptIO = nativeIO, private readonly capacity = 2, private readonly waiting = 32) {}

  read<T>(path: string, work: (file: TranscriptFile) => Promise<T>, options: { signal?: AbortSignal; deadline?: number } = {}): Promise<T> {
    const { signal, deadline } = options;
    if (signal?.aborted || (deadline !== undefined && deadline <= Date.now())) return Promise.reject(new TranscriptBusyError("the transcript read was cancelled"));
    if (this.queue.length >= this.waiting && (this.active.size >= this.capacity || this.paths.has(path))) return Promise.reject(new TranscriptBusyError());
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { signal?.removeEventListener("abort", request.cancel); clearTimeout(timer); };
      const current = () => {
        if (request.live && deadline !== undefined && Date.now() >= deadline) request.cancel();
        if (!request.live) throw new TranscriptBusyError("the transcript read was cancelled");
      };
      const request: Request = {
        path, live: true, started: false,
        cancel: () => {
          if (!request.live) return;
          request.live = false;
          cleanup();
          reject(new TranscriptBusyError("the transcript read was cancelled"));
          if (!request.started) {
            const index = this.queue.indexOf(request);
            if (index >= 0) this.queue.splice(index, 1);
          }
          this.pump();
        },
        run: async () => {
          let handle: Awaited<ReturnType<TranscriptIO["open"]>> | undefined;
          const operations = new Set<Promise<unknown>>();
          let accepting = true;
          let value: T | undefined;
          let error: unknown;
          let failed = false;
          let scratch: Buffer | undefined;
          try {
            handle = await this.io.open(path);
            current();
            const pinned = handle;
            let busy = false;
            const operation = <V>(call: () => Promise<V>): Promise<V> => {
              const pending = (async () => {
                current();
                if (!accepting) throw new Error("the transcript lease is closed");
                if (busy) throw new Error("transcript operations must be awaited in order");
                busy = true;
                try { const result = await call(); current(); return result; }
                finally { busy = false; }
              })();
              operations.add(pending);
              void pending.then(() => operations.delete(pending), () => operations.delete(pending));
              return pending;
            };
            // a window read whole (short reads completed, up to EOF)
            const fill = (position: number, length: number, buffer: () => Buffer) => operation(async () => {
              current();
              if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0 || length > WINDOW_BYTES) throw new RangeError("invalid transcript window");
              const bytes = buffer();
              let offset = 0;
              while (offset < length) {
                const { bytesRead } = await pinned.read(bytes, offset, length - offset, position + offset);
                current();
                if (bytesRead === 0) break;
                offset += bytesRead;
              }
              return bytes.subarray(0, offset);
            });
            let initial: TranscriptVersion | undefined;
            const file: TranscriptFile = {
              get initial() { return initial!; },
              stat: () => operation(async () => {
                current();
                const version = transcriptVersion(await pinned.stat());
                current();
                if (version === null) throw new Error("the transcript is not a plain file");
                return version;
              }),
              pathVersion: () => operation(async () => {
                current();
                const version = transcriptVersion(await this.io.stat(path));
                current();
                return version;
              }),
              read: (position, length) => fill(position, length, () => Buffer.allocUnsafe(length)),
              window: (position, length) => fill(position, length, () => scratch ??= this.spare.pop() ?? Buffer.allocUnsafe(WINDOW_BYTES)),
            };
            const before = await file.stat();
            initial = before;
            const named = await file.pathVersion();
            if (named === null || named.id !== before.id) throw new Error("the transcript was replaced");
            value = await work(file);
            current();
          } catch (caught) { error = caught; failed = true; }
          finally {
            accepting = false;
            await Promise.allSettled([...operations]);
            // Even an open that answered after cancellation must close; neither its path nor the
            // physical allowance is available to a replacement until this await has settled.
            try { await handle?.close(); } catch (caught) { if (!failed) error = caught; failed = true; }
            if (scratch !== undefined) this.spare.push(scratch);
            if (request.live && deadline !== undefined && Date.now() >= deadline) request.cancel();
            this.active.delete(request);
            this.paths.delete(path);
            if (request.live) {
              request.live = false;
              cleanup();
              if (failed) reject(error); else resolve(value as T);
            }
            this.pump();
          }
        },
      };
      signal?.addEventListener("abort", request.cancel, { once: true });
      if (deadline !== undefined) { timer = setTimeout(request.cancel, Math.max(0, deadline - Date.now())); timer.unref?.(); }
      this.queue.push(request);
      this.pump();
    });
  }

  private pump(): void {
    if (this.resetting) return;
    if (this.active.size === 0 && this.queue.length === 0) { for (const resolve of this.idle) resolve(); this.idle.clear(); }
    while (this.active.size < this.capacity) {
      const index = this.queue.findIndex((request) => !this.paths.has(request.path));
      if (index < 0) return;
      const request = this.queue.splice(index, 1)[0]!;
      request.started = true;
      this.active.add(request);
      this.paths.add(request.path);
      void request.run();
    }
  }

  reset(): void {
    // a lease still open puts its buffer back once it ends
    this.spare.length = 0;
    this.resetting = true;
    try { for (const request of [...this.queue, ...this.active]) request.cancel(); }
    finally { this.resetting = false; this.pump(); }
  }
  settled(): Promise<void> { return this.active.size === 0 && this.queue.length === 0 ? Promise.resolve() : new Promise((resolve) => this.idle.add(resolve)); }
  size(): { active: number; waiting: number; paths: number } { return { active: this.active.size, waiting: this.queue.length, paths: this.paths.size }; }
}

/** The server's one reader. */
export const transcriptReader = new TranscriptReader();

import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";

/**
 * A transcript's identity, length and clock, in the form `lstatSync` gives (historyVersion), so the
 * two compare. `dev` and `ino` are numbers there, not bigints: on a filesystem whose numbers pass
 * 2^53, two files may share an identity.
 */
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
  /**
   * Starts reading the window a later `window(position, length)` will ask for, into the lease's
   * other buffer, so the read goes on while the lease awaits its other operations (a stat). The
   * bytes the last `window` returned stay as they are. A `window` that asks for anything else
   * waits for this read to settle first, and one read ahead at a time is kept.
   */
  ahead(position: number, length: number): void;
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
 * A lease has at most two native operations in flight, the one it awaits and a read ahead, so the
 * reader has at most twice its capacity of them.
 *
 * Known limits: a native operation that never settles (a read ahead or any other) keeps its lease,
 * so two of them on two paths keep every lease, and every later read waits out its deadline. A
 * cancelled lease keeps its path too, until its operations settle: a new read of that transcript
 * waits behind it.
 */
export class TranscriptReader {
  private readonly queue: Request[] = [];
  private readonly active = new Set<Request>();
  private readonly paths = new Set<string>();
  private resetting = false;
  private readonly idle = new Set<() => void>();
  /** `window` buffers of leases that ended, every native operation on them settled */
  private readonly spare: Buffer[] = [];
  constructor(private readonly io: TranscriptIO = nativeIO, readonly capacity = 2, private readonly waiting = 32) {}

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
          // the buffer the last window was returned in, and the one a read ahead fills
          let front: Buffer | undefined;
          let back: Buffer | undefined;
          let readAhead: { position: number; length: number; bytes: Promise<Buffer> } | null = null;
          try {
            handle = await this.io.open(path);
            current();
            const pinned = handle;
            let busy = false;
            // a read ahead (`beside`) runs next to the one operation the work awaits at a time
            const operation = <V>(call: () => Promise<V>, beside = false): Promise<V> => {
              const pending = (async () => {
                current();
                if (!accepting) throw new Error("the transcript lease is closed");
                if (beside) { const result = await call(); current(); return result; }
                if (busy) throw new Error("transcript operations must be awaited in order");
                busy = true;
                try { const result = await call(); current(); return result; }
                finally { busy = false; }
              })();
              operations.add(pending);
              void pending.then(() => operations.delete(pending), () => operations.delete(pending));
              return pending;
            };
            const valid = (position: number, length: number) => {
              if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0 || length > WINDOW_BYTES) throw new RangeError("invalid transcript window");
            };
            // a window read whole (short reads completed, up to EOF)
            const fill = async (position: number, length: number, bytes: Buffer) => {
              current();
              valid(position, length);
              let offset = 0;
              while (offset < length) {
                const { bytesRead } = await pinned.read(bytes, offset, length - offset, position + offset);
                current();
                if (bytesRead === 0) break;
                offset += bytesRead;
              }
              return bytes.subarray(0, offset);
            };
            const spareWindow = () => this.spare.pop() ?? Buffer.allocUnsafe(WINDOW_BYTES);
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
              read: (position, length) => operation(() => fill(position, length, Buffer.allocUnsafe(length))),
              window: (position, length) => operation(async () => {
                const read = readAhead;
                readAhead = null;
                if (read !== null) {
                  if (read.position === position && read.length === length) {
                    const bytes = await read.bytes;
                    [front, back] = [back, front];
                    return bytes;
                  }
                  // let settle first: its buffer is the next read ahead's, and the lease keeps to two native operations
                  await read.bytes.catch(() => {});
                }
                return fill(position, length, front ??= spareWindow());
              }),
              ahead: (position, length) => {
                if (readAhead !== null || !accepting) return;
                valid(position, length);
                const bytes = operation(() => fill(position, length, back ??= spareWindow()), true);
                // a read ahead nobody asks for is let go of: its failure is no failure of the lease
                bytes.catch(() => {});
                readAhead = { position, length, bytes };
              },
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
            if (front !== undefined) this.spare.push(front);
            if (back !== undefined) this.spare.push(back);
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

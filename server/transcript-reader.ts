import { constants, type Stats, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { transcriptVersion, type TranscriptVersion } from "./transcript-version.ts";
export { transcriptVersion, sameTranscriptVersion, type TranscriptVersion } from "./transcript-version.ts";

export class TranscriptBusyError extends Error {
  constructor(message = "the transcript reader is busy") { super(message); this.name = "TranscriptBusyError"; }
}

/** The small native surface also lets lifecycle tests hold actual operation settlement. */
export interface TranscriptHandle {
  stat(): Promise<Stats | BigIntStats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface TranscriptIO {
  open(path: string): Promise<TranscriptHandle>;
  stat(path: string): Promise<Stats | BigIntStats>;
}
const nativeIO: TranscriptIO = {
  open: async (path) => {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    return { stat: () => handle.stat({ bigint: true }), read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position), close: () => handle.close() };
  },
  stat: (path) => lstat(path, { bigint: true }),
};
const WINDOW_BYTES = 1024 * 1024;

export interface TranscriptFile {
  /** Identity already checked when this handle was opened, without another metadata round trip. */
  readonly initial: TranscriptVersion;
  stat(): Promise<TranscriptVersion>;
  pathVersion(): Promise<TranscriptVersion | null>;
  /** Owned bytes, at an explicit position, at most one MiB. Short reads are completed up to EOF. */
  read(position: number, length: number): Promise<Buffer>;
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
  constructor(private readonly io: TranscriptIO = nativeIO, private readonly capacity = 2, private readonly waiting = 32) {}

  read<T>(path: string, work: (file: TranscriptFile) => Promise<T>, options: { signal?: AbortSignal; deadline?: number } = {}): Promise<T> {
    return this.run(path, work, options, false);
  }

  version(path: string, options: { signal?: AbortSignal; deadline?: number } = {}): Promise<TranscriptVersion | null> {
    return this.run(path, (file) => file.pathVersion(), options, true);
  }

  private run<T>(path: string, work: (file: TranscriptFile) => Promise<T>, options: { signal?: AbortSignal; deadline?: number }, metadata: boolean): Promise<T> {
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
          try {
            if (!metadata) handle = await this.io.open(path);
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
            let initial: TranscriptVersion | undefined;
            const file: TranscriptFile = {
              get initial() { if (initial === undefined) throw new Error("metadata leases have no pinned identity"); return initial; },
              stat: () => operation(async () => {
                current();
                const version = transcriptVersion(await (pinned ? pinned.stat() : this.io.stat(path)));
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
              read: (position, length) => operation(async () => {
                current();
                if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0 || length > WINDOW_BYTES) throw new RangeError("invalid transcript window");
                if (pinned === undefined) throw new Error("metadata leases cannot read bytes");
                const bytes = Buffer.allocUnsafe(length);
                let offset = 0;
                while (offset < length) {
                  const { bytesRead } = await pinned.read(bytes, offset, length - offset, position + offset);
                  current();
                  if (bytesRead === 0) break;
                  offset += bytesRead;
                }
                return bytes.subarray(0, offset);
              }),
            };
            if (!metadata) {
              const before = await file.stat();
              initial = before;
              const named = await file.pathVersion();
              if (named === null || named.id !== before.id) throw new Error("the transcript was replaced");
            }
            value = await work(file);
            current();
          } catch (caught) { error = caught; failed = true; }
          finally {
            accepting = false;
            await Promise.allSettled([...operations]);
            // Even an open that answered after cancellation must close; neither its path nor the
            // physical allowance is available to a replacement until this await has settled.
            try { await handle?.close(); } catch (caught) { if (!failed) error = caught; failed = true; }
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
      if (deadline !== undefined) timer = setTimeout(request.cancel, Math.max(0, deadline - Date.now()));
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
    this.resetting = true;
    try { for (const request of [...this.queue, ...this.active]) request.cancel(); }
    finally { this.resetting = false; this.pump(); }
  }
  settled(): Promise<void> { return this.active.size === 0 && this.queue.length === 0 ? Promise.resolve() : new Promise((resolve) => this.idle.add(resolve)); }
  size(): { active: number; waiting: number; paths: number } { return { active: this.active.size, waiting: this.queue.length, paths: this.paths.size }; }
}

let shared: TranscriptReader | undefined;
const reader = () => shared ??= new TranscriptReader();
export const transcriptReader = {
  read: <T>(path: string, work: (file: TranscriptFile) => Promise<T>, options?: { signal?: AbortSignal; deadline?: number }) => reader().read(path, work, options),
  version: (...args: Parameters<TranscriptReader["version"]>) => reader().version(...args),
  settled: () => shared?.settled() ?? Promise.resolve(),
  size: () => shared?.size() ?? { active: 0, waiting: 0, paths: 0 },
};

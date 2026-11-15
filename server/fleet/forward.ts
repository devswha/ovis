/**
 * One fleet machine's local forwards on the controller (docs/fleet-link.md section 2): a TCP listener on 127.0.0.1 at
 * a port the system picks, whose every connection becomes one `bridge` pipe, and a Unix socket `<n>.sock` (0600) in a
 * folder of its own made with mkdtemp (0700) under the OS temp folder, whose every connection becomes one `native`
 * pipe. The folder is not under the state folder: a long state path can pass the Unix socket path limit (104 bytes
 * on macOS). It is new for every forward, so a server that crashed leaves nothing a restart binds to, and no restart
 * names another machine's socket. Windows gets no Unix socket forward (`native: false`).
 *
 * A `bridge` connection becomes a pipe only once its first request head carries `Authorization: Bearer <token>` with
 * the bridge token of the machine's newest advert, as the roster's own client sends it to any PC's endpoint
 * (server/machines.ts, server/remote-websocket.ts), and as server/relay-pc.ts's loopback endpoint checks it: compared in
 * constant time, never logged. Any other local user of this host is closed before a pipe is opened, so it cannot hold
 * the machine's 16 pipes; the head goes on to the bridge unchanged, which asks for the same token again. The Unix
 * socket forward keeps to its 0600 socket in a 0700 folder. Every pipe a forward opens goes to the one machine it was
 * made for: `open` is bound to that machine.
 *
 * Bytes are copied both ways with each direction's end kept apart (a half-close stays a half-close). A pipe that ends
 * with a RESET, or a session that goes, ends the local connection at once, as a TCP reset where there is one, so a
 * client never reads a cut answer as a whole one; a local connection that goes before both directions ended resets its
 * pipe `cancelled`. A connection that finds no session closes at once and reads nothing.
 */
import { timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MuxClock, MuxStreamError } from "../../shared/relay-mux-engine.ts";
import { PIPE_DATA_BYTES } from "./mux-ext.ts";
import type { PipeStream } from "./mux-ext.ts";

/** A pipe the fleet opened and the machine accepted, how it ends, and the pace its DATA frames go at. */
export interface OpenedPipe {
  readonly pipe: PipeStream;
  /** Settles when the pipe retires (undefined) or is reset (its error). */
  readonly disposed: Promise<MuxStreamError | undefined>;
  /** Resolves once `frames` more DATA frames may go to the machine. */
  pace(frames: number, signal?: AbortSignal): Promise<void>;
}

export interface MachineForwardOptions {
  /** Opens a pipe to the forward's own machine; rejects when it cannot (no session, endpoint not advertised, timeout). */
  readonly open: (endpoint: "bridge" | "native", signal: AbortSignal) => Promise<OpenedPipe>;
  /** The socket's name in its folder: `<index>.sock`. */
  readonly index: number;
  /** Whether to open the Unix socket forward too. */
  readonly native: boolean;
  /** The bridge token of the machine's newest advert, which a `bridge` connection must present; undefined: none is let in. */
  readonly bearer: () => string | undefined;
  /**
   * `true` when the machine is not reconnecting; else a wait for it that resolves whether it is back (false: the wait
   * ran out) and rejects when `signal` aborts. A connection waits for it before anything else (`hold`).
   */
  readonly ready?: (signal: AbortSignal) => Promise<boolean> | true;
  /** What times a head's HEAD_WAIT_MS; the fleet's clock (a test's own), else the timers of this process. */
  readonly clock?: Pick<MuxClock, "setTimeout">;
}

const processClock: Pick<MuxClock, "setTimeout"> = {
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/** How much of a `bridge` connection's first request head is read for its bearer, and how long that head may take. */
export const HEAD_LIMIT_BYTES = 16 * 1024;
export const HEAD_WAIT_MS = 10_000;
/** How much a connection may send while it waits for a reconnecting machine; past it, it is closed. */
export const WAIT_BUFFER_BYTES = 256 * 1024;
const HEAD_END = Buffer.from("\r\n\r\n");

/** Whether a request head's Authorization header is `Bearer <token>`, compared in constant time. */
function presents(head: Buffer, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  for (const line of head.toString("latin1").split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0 || line.slice(0, colon).trim().toLowerCase() !== "authorization") continue;
    const given = Buffer.from(line.slice(colon + 1).trim(), "latin1");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
  return false;
}

function listen(server: Server, at: { port: number; host: string } | string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const done = () => { server.off("error", reject); resolve(); };
    if (typeof at === "string") server.listen(at, done);
    else server.listen(at.port, at.host, done);
  });
}

/** Ends `socket` at once: a TCP reset where the socket is TCP. */
function abort(socket: Socket): void {
  if (socket.destroyed) return;
  if (typeof socket.resetAndDestroy === "function" && socket.remoteAddress !== undefined) socket.resetAndDestroy();
  else socket.destroy();
}

export class MachineForward {
  private readonly connections = new Set<Socket>();
  private closed = false;

  private constructor(private readonly tcp: Server, private readonly unix: Server | undefined, readonly port: number,
    readonly socketPath: string | null, private readonly folder: string | null) {}

  static async open(options: MachineForwardOptions): Promise<MachineForward> {
    const servers: Server[] = [];
    let folder: string | null = null;
    try {
      const tcp = createServer({ allowHalfOpen: true, pauseOnConnect: true });
      servers.push(tcp);
      await listen(tcp, { port: 0, host: "127.0.0.1" });
      const address = tcp.address();
      if (!address || typeof address === "string") throw new Error("the forward has no TCP address");
      let unix: Server | undefined;
      let socketPath: string | null = null;
      if (options.native) {
        folder = mkdtempSync(join(tmpdir(), "ovis-fleet-"));
        chmodSync(folder, 0o700);
        socketPath = join(folder, `${options.index}.sock`);
        unix = createServer({ allowHalfOpen: true, pauseOnConnect: true });
        servers.push(unix);
        await listen(unix, socketPath);
        chmodSync(socketPath, 0o600);
      }
      const forward = new MachineForward(tcp, unix, address.port, socketPath, folder);
      tcp.on("connection", (socket) => forward.serve(socket, "bridge", options));
      unix?.on("connection", (socket) => forward.serve(socket, "native", options));
      return forward;
    } catch (error) {
      for (const server of servers) server.close();
      if (folder) rmSync(folder, { recursive: true, force: true });
      throw error;
    }
  }

  /** Stops listening, ends every connection (and so its pipe) and deletes the socket and its folder. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const stopped = [this.tcp, this.unix].filter((server) => server !== undefined).map((server) => new Promise<void>((resolve) => server.close(() => resolve())));
    for (const socket of this.connections) abort(socket);
    await Promise.all(stopped);
    if (this.folder) rmSync(this.folder, { recursive: true, force: true });
  }

  private serve(socket: Socket, endpoint: "bridge" | "native", { open, bearer, ready, clock = processClock }: MachineForwardOptions): void {
    if (this.closed) { abort(socket); return; }
    this.connections.add(socket);
    const gone = new AbortController();
    socket.on("error", () => {});
    socket.once("close", () => { this.connections.delete(socket); gone.abort(); });
    // a connection to a reconnecting machine waits for its new session (a bridge one for its token) instead of being turned away
    const waiting = ready?.(gone.signal) ?? true;
    const waited = waiting === true ? Promise.resolve(true) : this.hold(socket, waiting, gone);
    const admitted = waited.then((live) => !live || socket.destroyed ? false : endpoint === "bridge" ? this.admit(socket, bearer, clock) : true);
    void admitted.then((admit) => {
      if (!admit || socket.destroyed) { abort(socket); return; }
      open(endpoint, gone.signal).then((opened) => this.copy(socket, opened, gone.signal), () => abort(socket));
    });
  }

  /**
   * While a connection waits for its reconnecting machine. A paused socket half-open sees no hang-up, so what the caller
   * sends is read and kept here, and put back once the wait is over. An end or close before any pipe exists is the
   * caller leaving: the wait ends at once and no pipe is opened for it. Past WAIT_BUFFER_BYTES it is closed too.
   * Resolves whether the machine is back to carry it.
   */
  private hold(socket: Socket, waiting: Promise<boolean>, gone: AbortController): Promise<boolean> {
    const chunks: Buffer[] = [];
    let size = 0;
    const leave = (): void => gone.abort();
    const take = (chunk: Buffer): void => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > WAIT_BUFFER_BYTES) leave();
    };
    socket.on("data", take);
    socket.once("end", leave);
    socket.once("close", leave);
    socket.resume();
    return waiting.then((back) => back, () => false).then((back) => {
      socket.off("data", take);
      socket.off("end", leave);
      socket.off("close", leave);
      socket.pause();
      if (gone.signal.aborted || socket.destroyed) return false;
      if (chunks.length) socket.unshift(Buffer.concat(chunks));
      return back;
    });
  }

  /**
   * Whether a `bridge` connection's first request head presents the machine's bridge token: what it read is put back
   * (the head goes on to the bridge first, and the connection's end stays behind it). False, with nothing more read,
   * when the machine offers none (no session, no `bridge` in its advert), the head presents another or none, or it is
   * longer than HEAD_LIMIT_BYTES or slower than HEAD_WAIT_MS.
   */
  private admit(socket: Socket, bearer: () => string | undefined, clock: Pick<MuxClock, "setTimeout">): Promise<boolean> {
    if (bearer() === undefined) return Promise.resolve(false);
    return new Promise((resolve) => {
      let read = Buffer.alloc(0);
      const finish = (admit: boolean): void => {
        cancel();
        socket.off("data", take);
        socket.off("end", refuse);
        socket.off("close", refuse);
        socket.pause();
        if (admit) socket.unshift(read);
        resolve(admit);
      };
      const refuse = (): void => finish(false);
      const take = (chunk: Buffer): void => {
        read = Buffer.concat([read, chunk]);
        const end = read.indexOf(HEAD_END);
        if (end < 0 ? read.length > HEAD_LIMIT_BYTES : end + HEAD_END.length > HEAD_LIMIT_BYTES) { refuse(); return; }
        if (end < 0) return;
        const token = bearer();
        finish(token !== undefined && presents(read.subarray(0, end), token));
      };
      const cancel = clock.setTimeout(refuse, HEAD_WAIT_MS);
      socket.on("data", take);
      socket.once("end", refuse);
      socket.once("close", refuse);
      socket.resume();
    });
  }

  private copy(socket: Socket, { pipe, disposed, pace }: OpenedPipe, gone: AbortSignal): void {
    if (socket.destroyed) { pipe.reset("cancelled"); return; }
    let over = false;
    let ended = false;
    let read = false;
    void disposed.then((error) => {
      over = true;
      if (error) abort(socket);
    });
    // a local connection that goes before both directions ended takes the pipe with it; one that ended both retires it
    socket.once("close", () => { if (!over && !(ended && read)) pipe.reset("cancelled"); });

    // local to machine: one write at a time, each at the pace of its frames
    let writing = Promise.resolve();
    socket.on("data", (chunk: Buffer) => {
      socket.pause();
      writing = writing
        .then(() => pace(Math.ceil(chunk.length / PIPE_DATA_BYTES), gone))
        .then(() => pipe.write(chunk))
        .then(() => { if (!over) socket.resume(); }, () => abort(socket));
    });
    socket.once("end", () => {
      ended = true;
      writing = writing.then(() => pipe.end()).catch(() => abort(socket));
    });
    socket.resume();

    // machine to local: as the socket drains
    void (async () => {
      const reader = pipe.readable.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { read = true; break; }
          if (!socket.write(value)) {
            await new Promise<void>((resolve) => {
              const done = () => { socket.off("drain", done); socket.off("close", done); resolve(); };
              socket.on("drain", done);
              socket.on("close", done);
            });
          }
          if (socket.destroyed) return;
        }
        socket.end();
      } catch { abort(socket); }
      finally { reader.releaseLock(); }
    })();
  }
}

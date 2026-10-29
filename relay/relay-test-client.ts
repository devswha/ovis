/**
 * A WebSocket peer of the relay for tests, the QA script and the load smoke: every frame and the
 * close are queued as events to await, each with a deadline, never a fixed wait.
 */
export type Received = string | Uint8Array;

export class Peer {
  private readonly queue: Received[] = [];
  private readonly waiters: ((frame: Received) => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly ready: Promise<void>;

  constructor(readonly socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      const frame = typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
    this.closed = new Promise((resolve) => socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })));
    // a refused socket opens and closes at once; either way it is ready to be looked at
    this.ready = Promise.race([new Promise<void>((resolve) => socket.addEventListener("open", () => resolve())), this.closed.then(() => undefined)]);
  }

  static async open(url: string): Promise<Peer> {
    const peer = new Peer(new WebSocket(url));
    await within(peer.ready, `open ${url}`);
    return peer;
  }

  next(what = "a frame", timeoutMs = 5000): Promise<Received> {
    const frame = this.queue.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    return within(new Promise<Received>((resolve) => this.waiters.push(resolve)), what, timeoutMs);
  }

  async json(what = "a JSON frame"): Promise<Record<string, unknown>> {
    const frame = await this.next(what);
    if (typeof frame !== "string") throw new Error(`expected text for ${what}, got ${frame.byteLength} bytes`);
    return JSON.parse(frame) as Record<string, unknown>;
  }

  closeCode(what = "the close", timeoutMs = 5000): Promise<number> {
    return within(this.closed, what, timeoutMs).then((close) => close.code);
  }

  /** frames queued and not yet taken */
  get pending(): number {
    return this.queue.length;
  }
}

export function within<T>(promise: Promise<T>, what: string, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

export const randomServerId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** URLs of a relay at `base` (ws://host:port) for one server_id */
export function relayUrls(base: string, serverId: string) {
  return {
    control: `${base}/v1/ws?server_id=${serverId}&role=server&v=1`,
    client: `${base}/v1/ws?server_id=${serverId}&role=client&v=1`,
    data: (connectionId: string) => `${base}/v1/ws?server_id=${serverId}&role=server&connection_id=${connectionId}&v=1`,
  };
}

/** A PC's control socket, a client, and the data socket the PC opens for it once told. */
export async function openPair(base: string, serverId: string, control?: Peer) {
  const urls = relayUrls(base, serverId);
  const ownControl = control ?? await Peer.open(urls.control);
  if (!control) await ownControl.json("sync");
  const client = await Peer.open(urls.client);
  const assigned = await client.json("assigned");
  const connected = await ownControl.json("connected");
  if (connected["connection_id"] !== assigned["connection_id"]) throw new Error("control heard of another client");
  const data = await Peer.open(urls.data(assigned["connection_id"] as string));
  return { control: ownControl, client, data, connectionId: assigned["connection_id"] as string };
}

export function equalBytes(a: Received, b: Received): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

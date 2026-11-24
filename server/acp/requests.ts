import { KeeperDisconnected, KeeperRequestError, record, text, type Message } from "./messages.ts";

interface InFlight { resolve: (result: unknown) => void; reject: (error: Error) => void }
/** The local calls on a keeper connection: a prompt's delivery receipt and the agent's reply
 * have separate lifetimes. Neither is transferred to a later connection. */
export class KeeperRequests {
  private nextId = 1;
  private readonly receipts = new Map<string, () => void>();
  private readonly inFlight = new Map<number, InFlight>();

  constructor(private readonly write: (message: unknown) => void) {}

  /** Chat acknowledges the archived write, not the end of a turn that may itself wait for an approval. */
  async submit(sessionId: string, text: string): Promise<void> {
    const key = crypto.randomUUID();
    const receipt = Promise.withResolvers<void>();
    this.receipts.set(key, receipt.resolve);
    const timer = setTimeout(() => receipt.reject(new KeeperDisconnected()), 5000);
    try {
      await Promise.race([receipt.promise, this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }], _meta: { "ovis.sh/submit": key } })]);
    } finally { clearTimeout(timer); this.receipts.delete(key); }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.inFlight.set(id, { resolve, reject });
    this.write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  delivered(key: unknown): void {
    if (typeof key === "string") this.receipts.get(key)?.();
  }

  answered(message: Message): void {
    const id = typeof message.id === "number" ? message.id : null;
    if (id === null) return;
    const call = this.inFlight.get(id);
    if (call === undefined) return;
    this.inFlight.delete(id);
    const error = record(message.error);
    if (error !== null) call.reject(new KeeperRequestError(typeof error["code"] === "number" ? error["code"] : 0, text(error["message"]) ?? "error"));
    else call.resolve(message.result);
  }

  dropped(): void {
    for (const call of this.inFlight.values()) call.reject(new KeeperDisconnected());
    this.inFlight.clear();
  }
}

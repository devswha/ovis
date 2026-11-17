import { type ChannelHandlers, HcConnection, HcError, type HcStreamMethod, type HcTransport } from "./connection.ts";
import type { HcMethod, HcMethods } from "./hc-api.generated.ts";
import { isRecord } from "./snapshot.ts";
import { EVENT_LINE_BYTES } from "./adapter.ts";

/**
 * The core lists and reports another machine's terminals as `lab/t3` beside its own `t3`. hc takes a
 * machine's permanent id (`<id>/t3`) as it takes its name; a name can be given to another machine
 * (`hc machine rename`), the id cannot. hc still lists and reports terminals by name.
 */

export class MachineScopedConnection extends HcConnection {
  private readonly prefix: string;

  constructor(spawn: () => HcTransport, readonly machine: string, readonly id: string) {
    super(spawn);
    this.prefix = `${machine}/`;
  }

  override async call<M extends HcMethod>(method: M, params: HcMethods[M]["params"], timeoutMs?: number): Promise<HcMethods[M]["result"]> {
    if (method !== "machine.list") await this.stillThis(timeoutMs);
    const result = await super.call(method, this.scoped(method, params), timeoutMs);
    return this.mine(method, result);
  }

  override async open<M extends HcStreamMethod>(method: M, params: HcMethods[M]["params"], handlers: ChannelHandlers, timeoutMs?: number) {
    await this.stillThis(timeoutMs);
    const heard = method === "events.subscribe" ? { ...handlers, onData: this.eventLines(handlers.onData) } : handlers;
    const opened = await super.open(method, this.scoped(method, params), heard, timeoutMs);
    return { ...opened, result: this.mine(method, opened.result) };
  }

  private async stillThis(timeoutMs?: number): Promise<void> {
    const { machines } = await super.call("machine.list", {}, timeoutMs);
    if (machines.some((machine) => machine.name === this.machine && machine.id === this.id)) return;
    throw new HcError("closed", `herdr-core no longer calls this machine ${this.machine}: it was renamed or removed`);
  }

  address(local: string): string {
    return `${this.id}/${local}`;
  }

  local(address: string): string | null {
    return address.startsWith(this.prefix) ? address.slice(this.prefix.length) : null;
  }

  private scoped<P>(method: string, params: P): P {
    const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };
    for (const key of ["terminal", "parent", "children_of"]) {
      if (typeof out[key] === "string") out[key] = this.address(out[key]);
    }
    if (method === "terminal.run" || method === "doc.get" || method === "doc.set") out["on"] = this.id;
    return out as P;
  }

  private record(value: unknown): unknown {
    if (!isRecord(value) || typeof value["address"] !== "string") return value;
    const address = this.local(value["address"]);
    if (address === null) return null;
    const { parent, ...rest } = value;
    const local = typeof parent === "string" ? this.local(parent) : null;
    return { ...rest, address, ...(local === null ? { parent: null } : { parent: local }) };
  }

  private mine<R>(method: string, result: R): R {
    if (!isRecord(result)) return result;
    if (Array.isArray(result["terminals"])) {
      const { machines: _machines, ...rest } = result;
      return { ...rest, terminals: result["terminals"].map((terminal) => this.record(terminal)).filter((terminal) => terminal !== null) } as R;
    }
    if (method === "terminal.get" || method === "terminal.run") return this.record(result) as R;
    return result;
  }

  private eventLines(onData: (payload: Uint8Array) => void): (payload: Uint8Array) => void {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    return (payload) => {
      pending += decoder.decode(payload, { stream: true });
      if (pending.length > EVENT_LINE_BYTES && !pending.includes("\n")) { onData(encoder.encode(pending)); pending = ""; return; }
      const lines = pending.split("\n");
      pending = lines.pop()!;
      const kept = lines.flatMap((line) => {
        const event = this.event(line);
        return event === null ? [] : [event];
      });
      if (kept.length > 0) onData(encoder.encode(`${kept.join("\n")}\n`));
    };
  }

  private event(line: string): string | null {
    let message: unknown;
    try { message = JSON.parse(line); } catch { return line; }
    // anything but an event (`missed`) is about the stream itself
    if (!isRecord(message) || message["method"] !== "event" || !isRecord(message["params"])) return line;
    const { terminal, machine, data, ...params } = message["params"];
    let own: Record<string, unknown>;
    if (typeof terminal === "string") {
      const local = this.local(terminal);
      if (local === null) return null;
      own = { ...params, terminal: local };
    } else if (machine === this.machine) {
      own = params;
    } else {
      return null;
    }
    if (data !== undefined) {
      const record = this.record(data);
      if (record === null) return null;
      own["data"] = record;
    }
    return JSON.stringify({ ...message, params: own });
  }
}

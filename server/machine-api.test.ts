import { describe, expect, it } from "bun:test";
import type { MachineEvent } from "../shared/machines.ts";
import { handleMachineRequest, MACHINE_EVENTS_QUEUE_BYTES } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

/** A roster stand-in whose one listener the test drives, as the status hub drives the real one. */
function managerStandIn() {
  let listener: ((event: MachineEvent) => void) | null = null;
  const manager = { subscribe: (next: (event: MachineEvent) => void) => { listener = next; return () => { listener = null; }; } } as unknown as MachineManager;
  return { manager, emit: (event: MachineEvent) => listener?.(event), listening: () => listener !== null };
}

const status = (index: number): MachineEvent => ({
  type: "machine-message", machine_id: "local",
  message: { type: "pane-status", pane_id: `p${index}`, agent_status: "working", finish_epoch: "e", finish_id: 0 },
});

async function open(manager: MachineManager) {
  const abort = new AbortController();
  const response = await handleMachineRequest(new Request("http://127.0.0.1:7317/api/machines/events", { signal: abort.signal }), manager);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: MachineEvent[] = [];
  /** reads until `count` events have come, or the stream ended: whether it is still open */
  const readUntil = async (count: number): Promise<boolean> => {
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) return false;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as MachineEvent);
      }
    }
    return true;
  };
  const close = async () => { abort.abort(); await reader.cancel().catch(() => undefined); };
  return { reader, events, readUntil, close };
}

describe("the machine events stream", () => {
  it("keeps a browser that reads on through a burst of status frames written before it caught up", async () => {
    const { manager, emit } = managerStandIn();
    const stream = await open(manager);
    try {
      // herdr hands a burst over in one socket read: every frame is written before the browser reads one
      for (let index = 0; index < 300; index++) emit(status(index));
      expect(await stream.readUntil(300)).toBe(true);
      expect(stream.events.map((event) => event.type === "machine-message" && event.message.type === "pane-status" ? event.message.pane_id : null))
        .toEqual(Array.from({ length: 300 }, (_, index) => `p${index}`));
      emit(status(300));
      expect(await stream.readUntil(301)).toBe(true);
    } finally {
      await stream.close();
    }
  });

  it("still ends the stream of a browser that stopped reading, once what waits for it passes the bound", async () => {
    const { manager, emit, listening } = managerStandIn();
    const stream = await open(manager);
    try {
      const frame = status(0);
      const size = `data: ${JSON.stringify(frame)}\n\n`.length;
      for (let written = 0; written <= MACHINE_EVENTS_QUEUE_BYTES + size && listening(); written += size) emit(frame);
      expect(listening()).toBe(false);
      // what was queued before the bound is still delivered, then the stream ends
      expect(await stream.readUntil(Number.MAX_SAFE_INTEGER)).toBe(false);
    } finally {
      await stream.close();
    }
  });
});

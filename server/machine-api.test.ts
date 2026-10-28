import { describe, expect, it } from "bun:test";
import type { MachineEvent } from "../shared/machines.ts";
import { handleMachineRequest, machineEventsQueuedBytes } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

// The agreed policy, written out rather than read from the code: raising either must fail here.
const STREAM_BYTES = 4 * 1024 * 1024;
const TOTAL_BYTES = 32 * 1024 * 1024;

/** A roster stand-in that tells every open stream, as the status hub tells the real one. */
function managerStandIn() {
  const listeners = new Set<(event: MachineEvent) => void>();
  const manager = { subscribe: (listener: (event: MachineEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } as unknown as MachineManager;
  return { manager, emit: (event: MachineEvent) => { for (const listener of [...listeners]) listener(event); }, listening: () => listeners.size };
}

const status = (index: number): MachineEvent => ({
  type: "machine-message", machine_id: "local",
  message: { type: "pane-status", pane_id: `p${index}`, agent_status: "working", finish_epoch: "e", finish_id: 0 },
});
const large = (bytes: number): MachineEvent => ({
  type: "machine-message", machine_id: "local",
  message: { type: "pane-status", pane_id: "x".repeat(bytes), agent_status: "idle", finish_epoch: "e", finish_id: 0 },
});
const frameBytes = (event: MachineEvent): number => `data: ${JSON.stringify(event)}\n\n`.length;

async function open(manager: MachineManager) {
  const abort = new AbortController();
  const response = await handleMachineRequest(new Request("http://127.0.0.1:7317/api/machines/events", { signal: abort.signal }), manager);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: MachineEvent[] = [];
  /** reads until `count` events have come: "open", or how the stream ended ("ended" delivers what it held, "failed" drops it) */
  const readUntil = async (count: number): Promise<"open" | "ended" | "failed"> => {
    while (events.length < count) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); } catch { return "failed"; }
      if (chunk.done) return "ended";
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as MachineEvent);
      }
    }
    return "open";
  };
  const close = async () => { abort.abort(); await reader.cancel().catch(() => undefined); };
  return { events, readUntil, close };
}

describe("the machine events stream", () => {
  it("keeps a browser that reads on through a burst of status frames written before it caught up", async () => {
    const { manager, emit } = managerStandIn();
    const stream = await open(manager);
    try {
      // a burst is told before the browser reads any of it: every frame is written before it reads one
      for (let index = 0; index < 300; index++) emit(status(index));
      expect(await stream.readUntil(300)).toBe("open");
      expect(stream.events.map((event) => event.type === "machine-message" && event.message.type === "pane-status" ? event.message.pane_id : null))
        .toEqual(Array.from({ length: 300 }, (_, index) => `p${index}`));
      emit(status(300));
      expect(await stream.readUntil(301)).toBe("open");
    } finally {
      await stream.close();
    }
  });

  it("keeps a stream open after a frame larger than its allowance, as a roster of thousands of panes is", async () => {
    const { manager, emit } = managerStandIn();
    const stream = await open(manager);
    try {
      emit(large(STREAM_BYTES + 1024));
      for (let index = 0; index < 20; index++) emit(status(index));
      expect(await stream.readUntil(21)).toBe("open");
      emit(status(20));
      expect(await stream.readUntil(22)).toBe("open");
    } finally {
      await stream.close();
    }
  });

  it("ends a stream that stopped reading past 4 MiB, and drops what waited for it", async () => {
    const { manager, emit, listening } = managerStandIn();
    const stream = await open(manager);
    try {
      const within = Math.floor(STREAM_BYTES / frameBytes(status(0)));
      for (let sent = 0; sent < within; sent++) emit(status(0));
      expect(listening()).toBe(1);
      emit(status(0));
      emit(status(0));
      expect(listening()).toBe(0);
      // errored, not closed: the 4 MiB that waited is not still handed to a browser that stopped reading
      expect(await stream.readUntil(1)).toBe("failed");
      expect(stream.events).toEqual([]);
      expect(machineEventsQueuedBytes()).toBe(0);
    } finally {
      await stream.close();
    }
  });

  it("gives a large frame room only while it waits: once read, the stream is held to 4 MiB again", async () => {
    const { manager, emit, listening } = managerStandIn();
    const stream = await open(manager);
    try {
      emit(large(2 * STREAM_BYTES));
      expect(await stream.readUntil(1)).toBe("open");
      const within = Math.floor(STREAM_BYTES / frameBytes(status(0)));
      for (let sent = 0; sent < within; sent++) emit(status(0));
      expect(listening()).toBe(1);
      emit(status(0));
      emit(status(0));
      expect(listening()).toBe(0);
    } finally {
      await stream.close();
    }
  });

  it("ends a stream that stopped reading with a second large frame waiting behind the first", async () => {
    const { manager, emit, listening } = managerStandIn();
    const stream = await open(manager);
    try {
      emit(large(STREAM_BYTES + 1024));
      emit(large(STREAM_BYTES + 1024));
      expect(listening()).toBe(1);
      emit(status(0));
      expect(listening()).toBe(0);
    } finally {
      await stream.close();
    }
  });

  it("holds every stream together to 32 MiB, ending the stalled ones and not one that keeps up", async () => {
    const { manager, emit, listening } = managerStandIn();
    // twelve browsers that stopped reading, watching devices or not: 12 x 3.5 MiB would be 42 MiB
    const stalled = await Promise.all(Array.from({ length: 12 }, () => open(manager)));
    try {
      const frames = Math.floor(3.5 * 1024 * 1024 / frameBytes(status(0)));
      for (let sent = 0; sent < frames; sent++) {
        emit(status(0));
        expect(machineEventsQueuedBytes()).toBeLessThanOrEqual(TOTAL_BYTES);
      }
      expect(listening()).toBeLessThan(12);
      expect(listening()).toBeGreaterThan(0);
      const healthy = await open(manager);
      try {
        for (let index = 0; index < 300; index++) emit(status(index));
        expect(await healthy.readUntil(300)).toBe("open");
        expect(machineEventsQueuedBytes()).toBeLessThanOrEqual(TOTAL_BYTES);
      } finally {
        await healthy.close();
      }
    } finally {
      await Promise.all(stalled.map((stream) => stream.close()));
    }
    expect(machineEventsQueuedBytes()).toBe(0);
  });
});

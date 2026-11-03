import { describe, expect, it } from "bun:test";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { MachineEvent } from "../../shared/machines.ts";
import type { EventStreamHandlers } from "./eventStream.ts";
import { keepMachineEvents, type MachineEventSocket } from "./machineEventStream.ts";

class Socket implements MachineEventSocket {
  machineEventsAvailable: boolean | null = null;
  messages = new Set<(message: ServerMessage) => void>();
  disconnects = new Set<() => void>();
  requests: boolean[] = [];
  connections = 0;
  on(handler: (message: ServerMessage) => void) { this.messages.add(handler); return () => { this.messages.delete(handler); }; }
  onDisconnect(handler: () => void) { this.disconnects.add(handler); return () => { this.disconnects.delete(handler); }; }
  connect() { this.connections++; }
  setMachineEvents(enabled: boolean) { this.requests.push(enabled); }
  offer(enabled: boolean) {
    this.machineEventsAvailable = enabled;
    this.tell({ type: "features", features: enabled ? ["machine-events"] : [], connection: "c" });
  }
  tell(message: ServerMessage) { for (const handler of this.messages) handler(message); }
  lose() { this.machineEventsAvailable = null; for (const handler of this.disconnects) handler(); }
}
function scenario(socket = new Socket()) {
  const heard: string[] = [];
  const events: MachineEvent[] = [];
  let fallback: EventStreamHandlers | undefined;
  let fallbackOpens = 0, fallbackStops = 0;
  const stop = keepMachineEvents(socket, {
    opened: () => { heard.push("open"); }, lost: () => { heard.push("lost"); }, closed: () => { heard.push("closed"); },
    message: (event) => { events.push(event); },
  }, (handlers) => { fallback = handlers; fallbackOpens++; return () => { fallbackStops++; }; });
  return { socket, heard, events, stop, fallback: () => fallback, counts: () => [fallbackOpens, fallbackStops] };
}
const event: MachineEvent = { type: "seen", finishes: [] };
describe("machine notifications over the existing terminal socket", () => {
  it("opens no SSE for twenty browser connections and accepts initial and live events", () => {
    const tabs = Array.from({ length: 20 }, () => scenario());
    for (const tab of tabs) {
      expect(tab.counts()).toEqual([0, 0]);
      tab.socket.offer(true);
      tab.socket.offer(true);
      tab.socket.tell({ type: "machine-event", event });
      expect(tab.socket.requests).toEqual([true]);
      expect(tab.events).toEqual([event]);
      expect(tab.counts()).toEqual([0, 0]);
      tab.stop();
      expect(tab.socket.requests).toEqual([true, false]);
      expect(tab.socket.messages.size + tab.socket.disconnects.size).toBe(0);
    }
  });
  it("resubscribes once after reconnect without acquiring an HTTP event connection", () => {
    const tab = scenario(); tab.socket.offer(true); tab.socket.lose(); tab.socket.offer(true);
    expect(tab.heard).toEqual(["open", "lost", "open"]);
    expect(tab.socket.requests).toEqual([true, true]);
    expect(tab.counts()).toEqual([0, 0]); tab.stop();
  });
  it("uses SSE on an older or rolled-back server and switches back after an upgrade", () => {
    const tab = scenario(); tab.socket.offer(false);
    tab.fallback()!.opened();
    tab.fallback()!.message(new MessageEvent("message", { data: JSON.stringify(event) }));
    tab.fallback()!.message(new MessageEvent("message", { data: "bad json" }));
    expect(tab.events).toEqual([event]);
    expect(tab.counts()).toEqual([1, 0]);
    tab.socket.lose(); tab.socket.offer(true);
    expect(tab.counts()).toEqual([1, 1]);
    tab.socket.lose(); tab.socket.offer(false);
    expect(tab.counts()).toEqual([2, 1]); tab.stop(); expect(tab.counts()).toEqual([2, 2]);
  });
  it("subscribes when mounted after capabilities arrived and ignores late messages after unmount", () => {
    const socket = new Socket(); socket.offer(true);
    const tab = scenario(socket); expect(socket.requests).toEqual([true]);
    tab.stop(); tab.stop(); socket.tell({ type: "machine-event", event }); socket.offer(true);
    expect(tab.events).toEqual([]); expect(socket.requests).toEqual([true, false]);
  });
});

/** Machine notifications reuse the local terminal socket; old servers keep their SSE transport. */
import type { MachineEvent } from "../../shared/machines.ts";
import type { HerdrSocket } from "./ws.ts";
import { keepEventStream, type EventStreamHandlers } from "./eventStream.ts";

type MachineEventHandlers = Omit<EventStreamHandlers, "message"> & { message(event: MachineEvent): void };
export type MachineEventSocket = Pick<HerdrSocket, "on" | "onDisconnect" | "connect" | "machineEventsAvailable" | "setMachineEvents">;

export function keepMachineEvents(socket: MachineEventSocket, handlers: MachineEventHandlers,
  fallback: (handlers: EventStreamHandlers) => () => void = (callbacks) => keepEventStream("/api/machines/events", callbacks)): () => void {
  let subscribed = false;
  let stopped = false;
  let stopFallback: (() => void) | undefined;
  const choose = () => {
    if (stopped || socket.machineEventsAvailable === null) return;
    if (socket.machineEventsAvailable) {
      stopFallback?.(); stopFallback = undefined;
      if (subscribed) return;
      subscribed = true;
      handlers.opened();
      socket.setMachineEvents(true);
    } else if (!stopFallback) {
      subscribed = false;
      stopFallback = fallback({ ...handlers, message: (event) => {
        let payload: MachineEvent;
        try { payload = JSON.parse(event.data) as MachineEvent; } catch { return; }
        handlers.message(payload);
      } });
    }
  };
  const offMessage = socket.on((message) => {
    if (stopped) return;
    if (message.type === "features" || message.type === "snapshot") choose();
    else if (message.type === "machine-event" && subscribed) handlers.message(message.event);
  });
  const offDisconnect = socket.onDisconnect(() => {
    if (subscribed) { subscribed = false; handlers.lost(); }
  });
  choose();
  socket.connect();
  return () => {
    if (stopped) return;
    stopped = true;
    offMessage(); offDisconnect(); stopFallback?.();
    if (subscribed) socket.setMachineEvents(false);
  };
}

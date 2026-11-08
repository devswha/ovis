import { useEffect, useState } from "react";

/**
 * How long a dropped connection may stay unsaid. A server restart (an update, a preview following main)
 * drops every socket and the client is back within about 4 s (ws.ts backs off 0.25, 0.5, 1, 2 s): saying
 * Reconnecting for each of those would be noise, as messengers show a status only for a drop that lasts.
 */
export const RECONNECT_GRACE_MS = 4_000;

/**
 * Whether to show the connection as up: a connection this page had reads as up for RECONNECT_GRACE_MS after
 * it drops, unless `urgent` (input waits for it, the user acted, the output stopped), which says it at once.
 * Only what is shown waits: sending still reads the socket itself. `lostAt` is when the shared socket lost its
 * connection (HerdrSocket.lostSince): a terminal mounted during a drop gets only what is left of the grace.
 */
export function useReconnectGrace(connected: boolean, connectedBefore: boolean, urgent: boolean, lostAt: number | null = null): boolean {
  const dropped = !connected && connectedBefore;
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    if (!dropped) {
      setGraceOver(false);
      return;
    }
    const timer = setTimeout(() => setGraceOver(true), Math.max(0, (lostAt ?? Date.now()) + RECONNECT_GRACE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [dropped, lostAt]);
  if (connected) return true;
  const outlasted = lostAt !== null && Date.now() - lostAt >= RECONNECT_GRACE_MS;
  return dropped && !urgent && !graceOver && !outlasted;
}

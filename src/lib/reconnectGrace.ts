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
 * Only what is shown waits: sending still reads the socket itself.
 */
export function useReconnectGrace(connected: boolean, connectedBefore: boolean, urgent: boolean): boolean {
  const dropped = !connected && connectedBefore;
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    if (!dropped) {
      setGraceOver(false);
      return;
    }
    const timer = setTimeout(() => setGraceOver(true), RECONNECT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [dropped]);
  if (connected) return true;
  return dropped && !urgent && !graceOver;
}

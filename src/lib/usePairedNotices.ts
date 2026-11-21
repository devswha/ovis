import { useCallback, useEffect, useRef, useState } from "react";
import { markJoinSeen } from "./api.ts";
import type { DevicePairedEvent, DeviceRemovedEvent, PendingKey, RelayPairingRequest, RemotePairingRequest } from "../../shared/machines.ts";

export function usePairedNotices(pendingAccess: boolean | undefined) {
  const [pairedNotices, setPairedNotices] = useState<readonly DevicePairedEvent[]>([]);
  const [relayPairings, setRelayPairings] = useState<readonly RelayPairingRequest[]>([]);
  /** devices asking to join the account through this PC, for this device to approve as a member (components/AccountApprovals.tsx) */
  const [remotePairings, setRemotePairings] = useState<readonly RemotePairingRequest[]>([]);
  const [removedNotices, setRemovedNotices] = useState<readonly DeviceRemovedEvent[]>([]);
  /** devices waiting for this PC's screen (S2-34) */
  const [pendingKeys, keepPendingKeys] = useState<readonly PendingKey[]>([]);
  const access = useRef(pendingAccess);
  access.current = pendingAccess;
  // A roster event can beat the first health read. Keep it masked until drive access is confirmed.
  const setPendingKeys = useCallback((pending: readonly PendingKey[]) => {
    if (access.current !== false) keepPendingKeys(pending);
  }, []);
  const clearPendingKeys = useCallback(() => keepPendingKeys((current) => current.length === 0 ? current : []), []);
  useEffect(() => {
    if (pendingAccess === false) clearPendingKeys();
  }, [pendingAccess, clearPendingKeys]);
  const dismissRemovedNotice = useCallback((event: DeviceRemovedEvent) => setRemovedNotices((list) => list.filter((item) => item.event_id !== event.event_id)), []);
  // seen here is seen in every window of the PC; a watching window, which may not mark it, still drops it here
  const dropPairedNotice = useCallback((eventId: string) => setPairedNotices((list) => list.filter((item) => item.event_id !== eventId)), []);
  const dismissPairedNotice = useCallback((event: DevicePairedEvent) => {
    dropPairedNotice(event.event_id);
    markJoinSeen(event.event_id).catch((error: unknown) => console.warn("Ovis: the join could not be marked seen on the PC", error instanceof Error ? error.message : error));
  }, [dropPairedNotice]);
  return { pairedNotices, setPairedNotices, dismissPairedNotice, relayPairings, setRelayPairings, remotePairings, setRemotePairings, removedNotices, setRemovedNotices, dismissRemovedNotice, pendingKeys: pendingAccess === true ? pendingKeys : [], setPendingKeys, clearPendingKeys };
}

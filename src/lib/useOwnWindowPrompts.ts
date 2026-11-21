import { useMemo } from "react";

import type { PendingKey, RelayPairingRequest } from "../../shared/machines.ts";
import { useOwnJoins } from "../components/OwnJoins.tsx";
import { firstJoinPrompts, pendingKeyPrompts, type PromptPairing } from "../components/RelayPairingPrompt.tsx";

/**
 * What this PC's window asks in one place (RelayPairingPrompt): devices waiting with digits, and, in the PC's own window
 * alone, a first join with Allow beside its digits, and a key waiting for its screen beside a button that opens the confirm
 * page. `ownWindow` is a display hint only: the routes and the confirm page enforce their own rules.
 */
export function useOwnWindowPrompts(relayPairings: readonly RelayPairingRequest[], pendingKeys: readonly PendingKey[], ownWindow: boolean): readonly PromptPairing[] {
  const ownJoins = useOwnJoins(ownWindow);
  // a first join's deadline is counted from its own read: an unrelated update rebuilds the list, never that deadline
  const firstJoins = useMemo(() => firstJoinPrompts(ownJoins), [ownJoins]);
  return useMemo(() => [...relayPairings, ...firstJoins, ...(ownWindow ? pendingKeyPrompts(pendingKeys) : [])], [relayPairings, firstJoins, ownWindow, pendingKeys]);
}

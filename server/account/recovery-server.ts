import { userInfo } from "node:os";
import type { DeviceStore } from "../devices.ts";
import type { DeviceJournal } from "./device-journal.ts";
import type { KeyProofPairings } from "./key-proof.ts";
import type { PcAccountState } from "./pc-binding.ts";
import type { PendingRedemptions } from "./pending.ts";
import { recoveryActs, type RecoverySeams } from "./recovery-acts.ts";
import { openRecoverySocket, type RecoveryReleases } from "./recovery.ts";
import { SafetyLog } from "./safety-log.ts";

/** Wire the PC's stores into its local recovery socket. */
export function openPcRecovery(options: {
  readonly stateDir: string;
  readonly devices: DeviceStore;
  readonly pcAccount: PcAccountState | null;
  readonly journal: DeviceJournal;
  readonly safetyLog: SafetyLog;
  readonly releases: RecoveryReleases;
  readonly pending: PendingRedemptions | undefined;
  readonly pairings: KeyProofPairings | undefined;
}) {
  const { stateDir, devices, pcAccount, journal, safetyLog, releases, pending, pairings } = options;
  const seams: RecoverySeams = {
    pendingList: () => (pending?.list() ?? []).map(({ id, label, fingerprint }) => ({ id, label, fingerprint })),
    admitPending: (id, fingerprint) => {
      const waiting = pending?.list().find((entry) => entry.id === id);
      if (waiting === undefined || pairings === undefined) return "unknown";
      if (waiting.fingerprint !== fingerprint) return "mismatch";
      // The log's freeze set includes blocks. Check before approve consumes the pending redemption.
      const standing = safetyLog.state().freezes.find(({ record }) => record.target === waiting.key)?.record;
      if (standing?.kind === "block" || standing?.kind === "freeze") {
        return { refused: `${waiting.label} cannot be admitted while ${standing.kind} ${standing.id} stands: lift it first with ovis recover --lift ${standing.id}` };
      }
      return pairings.approve(id, fingerprint, "recover");
    },
    removeKey: (input) => devices.removeKey(input),
    appendLift: (blockId, forget, user) => {
      const block = safetyLog.state().blocks.find((entry) => entry.record.id === blockId);
      const binding = block === undefined ? pcAccount?.binding() ?? null : { account: block.record.account };
      const done = safetyLog.appendLift(blockId, binding, { cause: "recover", forget });
      if (done.outcome === "applied") journal.append({ kind: "lift", how: "recover", key: null, no: null, row: null, label: blockId, by: user, account: binding?.account ?? null });
      return done;
    },
    revokeAll: (user) => devices.revokeAll(user),
  };
  const handle = recoveryActs({ releases, logReadable: () => !devices.failsClosed && SafetyLog.open(stateDir).readable, user: userInfo().username, seams });
  const opened = openRecoverySocket({ stateDir, handle });
  if ("refused" in opened) {
    if (opened.refused !== "windows") console.error(`ovis recover is not available: ${opened.refused}`);
    return null;
  }
  return opened;
}

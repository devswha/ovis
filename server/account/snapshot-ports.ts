/**
 * The ports of a whole account read (snapshot-read.ts) on this PC's real state (Step 2, S2-24). Every block of the
 * snapshot goes through DeviceStore.applyBlock, which checks its signature and its signer's age by this PC's admission
 * order before anything is written. A lift counts only after DeviceStore.liftAuthority, and is appended to the safety
 * log in the commit turn.
 */
import type { BlockRecord, DeviceLiftRecord } from "../../shared/account-records.ts";
import type { DeviceStore } from "../devices.ts";
import { OrderConflict, type AccountOrder } from "./account-order.ts";
import type { DeviceJournal } from "./device-journal.ts";
import type { PcAccountState } from "./pc-binding.ts";
import type { SafetyLog } from "./safety-log.ts";
import { SnapshotWriteRefused, type SnapshotPorts, type StagedRead } from "./snapshot-read.ts";

export interface SnapshotDeps {
  readonly devices: DeviceStore;
  readonly safetyLog: SafetyLog;
  readonly pc: PcAccountState;
  readonly journal: DeviceJournal;
  /** The account's order, written in each whole read's commit turn (P21). */
  readonly order: AccountOrder;
  /** This PC's relay identity now, or null without one. */
  serverId(): string | null;
  requestRead(): void;
}


export function snapshotPorts(deps: SnapshotDeps): SnapshotPorts {
  const { devices, safetyLog, pc, journal } = deps;
  return {
    scope() {
      const account = devices.account();
      const serverId = deps.serverId();
      if (account === null || serverId === null || deps.order.problem !== null) return null;
      const state = safetyLog.state();
      return { account, serverId, gen: devices.gen(), lock: state.locked ? state.locks.map((entry) => entry.record.id).join(",") : null };
    },
    lastVersion: () => deps.order.lastVersion(pc.binding()?.bind_id, deps.serverId()),
    knownBlocks: () => new Set(safetyLog.blockIds()),
    async deny(block: BlockRecord) {
      let raised = false;
      await devices.applyBlock(block, "snapshot", () => { raised = true; });
      return raised;
    },
    async liftAuthority(lift: DeviceLiftRecord) {
      const entry = safetyLog.state().freezes.find(({ record }) => record.account === lift.account &&
        (record.kind === "block" ? record.id === lift.target : record.kind === "freeze" && record.id === `f:${lift.target}`));
      const target = entry?.record.target;
      if (!target || deps.order.late(lift.signer)) return false;
      const signerNo = deps.order.no(lift.signer);
      const targetNo = deps.order.no(target);
      return signerNo !== null && targetNo !== null && signerNo < targetNo && devices.liftAuthority(lift);
    },
    commit(stage: StagedRead) {
      const binding = pc.binding();
      if (binding === null) throw new Error("Snapshot commit requires a current binding");
      let recordOrder: () => void;
      try { recordOrder = deps.order.prepare(stage.snapshot, binding.bind_id); } catch (error) {
        if (error instanceof OrderConflict) journal.append({ kind: "account", how: "order_conflict", key: error.key, no: null, row: null, label: error.message, by: null, account: binding.account });
        throw error;
      }
      const blocks = new Map(stage.snapshot.blocks.map((block) => [block.id, block]));
      for (const line of stage.snapshot.freezes) {
        const block = blocks.get(line.block);
        if (!block || safetyLog.receipt(line.block) || devices.isTombstoned(block.signer)) continue;
        const id = `f:${line.block}`;
        if (safetyLog.receipt(id)) continue;
        const receipt = safetyLog.append({ got: "snapshot", record: { v: 1, kind: "freeze", id, account: block.account,
          target: line.target, after: line.after, signer: "service", signed_at: block.signed_at, signature: "" } });
        if (receipt.outcome !== "applied") throw new Error("Cannot record the snapshot freeze line");
        pc.raiseGen();
      }
      for (const lift of stage.lifts) {
        const receipt = safetyLog.append({ record: lift, got: "snapshot" });
        if (receipt.outcome === "refused") throw new SnapshotWriteRefused(receipt.code);
        if (receipt.outcome === "applied") pc.raiseGen();
      }
      recordOrder();
    },
    methodsVersion: () => deps.order.methodsVersion(),
    journalMethod(version) {
      journal.append({ kind: "method", how: `methods_version:${version}`, key: null, no: null, row: null, label: "The account's sign-in methods changed", by: null, account: devices.account() });
      deps.order.recordMethod(version);
    },
    requestRead: deps.requestRead,
  };
}

/**
 * The ports of a whole account read (snapshot-read.ts) on this PC's real state (Step 2, S2-24). Every block of the
 * snapshot goes through DeviceStore.applyBlock, which checks its signature and its signer's age by this PC's admission
 * order before anything is written. A lift counts only after DeviceStore.liftAuthority, and is appended to the safety
 * log in the commit turn.
 */
import type { BlockRecord, DeviceLiftRecord } from "../../shared/account-records.ts";
import type { DeviceStore } from "../devices.ts";
import type { AccountOrder } from "./account-order.ts";
import type { DeviceJournal } from "./device-journal.ts";
import type { PcAccountState } from "./pc-binding.ts";
import type { SafetyLog } from "./safety-log.ts";
import type { SnapshotPorts, StagedRead } from "./snapshot-read.ts";

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

/** A method entry's `how` carries the methods version it saw: the journal is where this PC remembers it (T58). */
const METHOD_HOW = /^methods_version:(\d+)$/;

export function snapshotPorts(deps: SnapshotDeps): SnapshotPorts {
  const { devices, safetyLog, pc, journal } = deps;
  const methodsVersion = (): number | null => {
    const entry = [...journal.entries()].reverse().find((candidate) => candidate.kind === "method" && METHOD_HOW.test(candidate.how));
    return entry === undefined ? null : Number(METHOD_HOW.exec(entry.how)![1]);
  };
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
    liftAuthority: (lift: DeviceLiftRecord) => devices.liftAuthority(lift),
    commit(stage: StagedRead) {
      const binding = pc.binding();
      if (binding === null) throw new Error("Snapshot commit requires a current binding");
      let lifted = false;
      for (const lift of stage.lifts) if (safetyLog.append({ record: lift, got: "snapshot" }).outcome === "applied") lifted = true;
      if (lifted) pc.raiseGen();
      deps.order.record(stage.snapshot, binding.bind_id);
    },
    methodsVersion,
    journalMethod(version) {
      journal.append({ kind: "method", how: `methods_version:${version}`, key: null, no: null, row: null, label: "The account's sign-in methods changed", by: null, account: devices.account() });
    },
    requestRead: deps.requestRead,
  };
}

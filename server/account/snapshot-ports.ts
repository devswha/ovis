/**
 * The ports of a whole account read (snapshot-read.ts) on this PC's real state (Step 2, S2-24). Every denial goes
 * through the device store's own verified path: a block through DeviceStore.applyBlock, which checks its signature and
 * its signer's age by this PC's admission order before anything is written, and a remove through applyAccountRecords.
 * A lift counts only after DeviceStore.liftAuthority, and is appended to the safety log in the commit turn.
 */
import { AccountRecordError, parseAccountRecord, parseSafetyRecord, type DeviceLiftRecord } from "../../shared/account-records.ts";
import type { DeviceStore } from "../devices.ts";
import type { DeviceJournal } from "./device-journal.ts";
import type { PcAccountState } from "./pc-binding.ts";
import { applyAccountRecords } from "./records.ts";
import type { SafetyLog } from "./safety-log.ts";
import type { RecordClass, SnapshotPorts, StagedRead } from "./snapshot-read.ts";

export interface SnapshotDeps {
  readonly devices: DeviceStore;
  readonly safetyLog: SafetyLog;
  readonly pc: PcAccountState;
  readonly journal: DeviceJournal;
  /** This PC's relay identity now, or null without one. */
  serverId(): string | null;
  requestRead(): void;
}

/** A method entry's `how` carries the methods version it saw: the journal is where this PC remembers it (T58). */
const METHOD_HOW = /^methods_version:(\d+)$/;

function classify(record: unknown): RecordClass {
  try {
    const safety = parseSafetyRecord(record);
    return safety.kind === "block" ? "denial" : safety.kind === "lift" && safety.signer !== "pc" ? "lift" : "invalid";
  } catch (error) {
    if (!(error instanceof AccountRecordError)) throw error;
  }
  try {
    const account = parseAccountRecord(record);
    return account.kind === "remove" ? "denial" : account.kind === "add" ? "add" : "invalid";
  } catch (error) {
    if (error instanceof AccountRecordError) return "invalid";
    throw error;
  }
}

export function snapshotPorts(deps: SnapshotDeps): SnapshotPorts {
  const { devices, safetyLog, pc, journal } = deps;
  let lastVersion: number | null = null;
  const methodsVersion = (): number | null => {
    const entry = [...journal.entries()].reverse().find((candidate) => candidate.kind === "method" && METHOD_HOW.test(candidate.how));
    return entry === undefined ? null : Number(METHOD_HOW.exec(entry.how)![1]);
  };
  return {
    scope() {
      const account = devices.account();
      const serverId = deps.serverId();
      if (account === null || serverId === null) return null;
      const state = safetyLog.state();
      return { account, serverId, gen: devices.gen(), lock: state.locked ? state.locks.map((entry) => entry.record.id).join(",") : null };
    },
    lastVersion: () => lastVersion,
    knownBlocks: () => new Set(safetyLog.blockIds()),
    classify,
    async deny(record) {
      const before = devices.gen();
      if (classify(record) !== "denial") return false;
      try {
        parseSafetyRecord(record);
        await devices.applyBlock(record, "snapshot");
      } catch (error) {
        if (!(error instanceof AccountRecordError)) throw error;
        await applyAccountRecords(devices, [record], deps.serverId());
      }
      return devices.gen() > before;
    },
    liftAuthority: (lift: DeviceLiftRecord) => devices.liftAuthority(lift),
    commit(stage: StagedRead) {
      let lifted = false;
      for (const lift of stage.lifts) if (safetyLog.append({ record: lift, got: "snapshot" }).outcome === "applied") lifted = true;
      if (lifted) pc.raiseGen();
      lastVersion = stage.snapshot.version;
    },
    methodsVersion,
    journalMethod(version) {
      journal.append({ kind: "method", how: `methods_version:${version}`, key: null, no: null, row: null, label: "The account's sign-in methods changed", by: null, account: devices.account() });
    },
    requestRead: deps.requestRead,
  };
}

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readDeviceRegistry } from "../devices.ts";
import { privateStateRefusal, writePrivateState } from "../private-state.ts";
import { ADMISSION_FILE } from "./admission-order.ts";
import { ACCOUNT_ORDER_FILE } from "./account-order.ts";
import { REMOVAL_FILE } from "./removal-evidence.ts";
import { DEVICE_JOURNAL_FILE, SAFETY_LOG_FILE } from "./safety-log.ts";
import { SnapshotWriteRefused } from "./snapshot-read.ts";
import type { PcAccountState } from "./pc-binding.ts";

const FILE = "account-activation.json";
const STEP2_STATE = [ADMISSION_FILE, ACCOUNT_ORDER_FILE, REMOVAL_FILE, DEVICE_JOURNAL_FILE, SAFETY_LOG_FILE];

/** The one migration window for a PC's pre-Step-2 credentials. Written before any Step-2 state is created. */
export class FirstActivation {
  private constructor(private readonly path: string, private active: boolean | string) {}

  static open(stateDir: string, sibling: string | null | undefined): FirstActivation {
    const path = join(stateDir, FILE);
    try {
      if (privateStateRefusal(path) !== null) return new FirstActivation(path, false);
      if (sibling && [FILE, ...STEP2_STATE].some(file => lstatSync(join(sibling, file), { throwIfNoEntry: false }))) {
        return new FirstActivation(path, false);
      }
      if (lstatSync(path, { throwIfNoEntry: false })) {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (typeof value !== "object" || value === null || !("v" in value) || value.v !== 1
          || !("pending" in value) || value.pending !== true) return new FirstActivation(path, false);
        const binding = "bind_id" in value ? value.bind_id : undefined;
        return new FirstActivation(path, binding === undefined ? true
          : typeof binding === "string" && /^[0-9a-f]{32}$/.test(binding) && binding);
      }
      if (STEP2_STATE.some(file => lstatSync(join(stateDir, file), { throwIfNoEntry: false }))) return new FirstActivation(path, false);
      const registry = readDeviceRegistry(join(stateDir, "devices.json"), true);
      if (registry.kind !== "ok") return new FirstActivation(path, false);
      const local = registry.devices.filter(row => !row.imported);
      // A never-bound PC needs no exception. Its eventual binding starts the usual wait.
      if (local.length === 0 || local.some(row => row.origin !== undefined)
        || !registry.devices.some(row => row.account !== undefined)) {
        return new FirstActivation(path, false);
      }
      writePrivateState(path, { v: 1, pending: true });
      return new FirstActivation(path, true);
    } catch (error) {
      // An unreadable or unwritable marker never grants the migration exception.
      if (error instanceof Error) return new FirstActivation(path, false);
      throw error;
    }
  }

  /** Attach an interrupted or unscoped migration marker only to the original T50 binding. */
  scope(pc: PcAccountState | null): void {
    if (this.active !== true) return;
    this.active = false;
    const binding = pc?.binding();
    if (pc === null || !binding || pc.strict !== null || pc.clears().length > 0 || pc.first() !== null
      || binding.pending || binding.service) return;
    try {
      writePrivateState(this.path, { v: 1, pending: true, bind_id: binding.bind_id });
      this.active = binding.bind_id;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }

  pending(binding: string): boolean { return this.active === binding; }

  complete(binding: string | null): void {
    if (binding === null || !this.pending(binding)) return;
    try { writePrivateState(this.path, { v: 1, pending: false }); }
    catch (error) {
      if (error instanceof Error) throw new SnapshotWriteRefused("Cannot finish first activation", { cause: error });
      throw error;
    }
    this.active = false;
  }
}

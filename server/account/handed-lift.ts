import { AccountRecordError, isDeviceSafetyRecord, parseSafetyRecord, verifySafetyRecord } from "../../shared/account-records.ts";
import type { DeviceStore } from "../devices.ts";
import type { RecordOutcome } from "./records.ts";

/** A hand-delivered lift is a hint to read, never authority to thaw. */
export async function handedLift(value: unknown, store: DeviceStore): Promise<RecordOutcome> {
  try {
    const lift = parseSafetyRecord(value);
    if (!isDeviceSafetyRecord(lift) || lift.kind !== "lift") return { id: lift.id, outcome: "refused", code: "record_invalid" };
    if (lift.account !== store.account()) return { id: lift.id, outcome: "refused", code: "account_mismatch" };
    const valid = await verifySafetyRecord(lift);
    return { id: lift.id, outcome: "refused", code: valid ? "read_pending" : "signature_invalid" };
  } catch (error) {
    if (error instanceof AccountRecordError) return { id: null, outcome: "refused", code: "record_invalid" };
    throw error;
  }
}

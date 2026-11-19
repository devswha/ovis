import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { DeviceJournal } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function store(): DeviceStore {
  const dir = mkdtempSync(join(tmpdir(), "ovis-lock-seams-"));
  dirs.push(dir);
  const log = SafetyLog.open(dir);
  return new DeviceStore(dir, null, null, { safety: log, pc: PcAccountState.open(dir), removals: RemovalEvidence.open(dir, log), journal: DeviceJournal.open(dir, () => log.ensureFile()) });
}
async function key(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return exportAccountKey(pair.publicKey);
}

describe("what the lock asks of the rows (P11, T46)", () => {
  test("T46: turning the lock on ends every row not confirmed on this PC's screen, with its sessions, in that turn", async () => {
    const devices = store();
    const remote = devices.pairRelay(devices.startPairing().code, "Phone", await key())!.device.id;
    const screen = await key();
    const { codeId } = devices.redeemCode(devices.startPairing().code, "code", screen) as { codeId: string };
    const local = devices.admitConfirmed({ codeId, key: screen, label: "Laptop", source: "screen" })!.id;
    expect(devices.originOf(remote)?.from).toBe("remote");
    expect(devices.originOf(local)?.from).toBe("pc");
    expect(devices.originOf("0000000000000000")).toBeNull();
    let closed = false;
    devices.onRevoke(remote, () => { closed = true; });
    expect(devices.endUnlockedRows()).toEqual([remote]);
    expect(closed).toBe(true);
    expect(devices.has(remote)).toBe(false);
    expect(devices.has(local)).toBe(true);
  });
});

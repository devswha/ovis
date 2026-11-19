import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signSafetyRecord, type BlockRecord, type DeviceLiftRecord } from "../../shared/account-records.ts";
import type { AccountSnapshotPage } from "../../shared/account-snapshot.ts";
import { DeviceStore } from "../devices.ts";
import { AccountOrder } from "./account-order.ts";
import { DeviceJournal } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";
import { snapshotPorts } from "./snapshot-ports.ts";
import { readSnapshot, type PageAnswer } from "./snapshot-read.ts";

const ACCOUNT = "acct_1";
const SERVER = "0123456789abcdef0123456789abcdef";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Key { keys: CryptoKeyPair; spki: string }
async function key(): Promise<Key> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

function pc() {
  const dir = mkdtempSync(join(tmpdir(), "s2-24-ports-"));
  dirs.push(dir);
  const safetyLog = SafetyLog.open(dir);
  const pcAccount = PcAccountState.open(dir);
  const journal = DeviceJournal.open(dir);
  const devices = new DeviceStore(dir, null, null, { safety: safetyLog, pc: pcAccount, removals: RemovalEvidence.open(dir, safetyLog), journal });
  const reads: string[] = [];
  const order = AccountOrder.open(dir);
  devices.attachAccountOrder(order);
  const ports = snapshotPorts({ devices, safetyLog, pc: pcAccount, journal, order, serverId: () => SERVER, requestRead: () => { reads.push("read"); } });
  return { devices, safetyLog, journal, ports, reads };
}

/** A drive member of the account here, admitted now: each one joins after the ones before it. */
async function member(devices: DeviceStore): Promise<Key & { id: string }> {
  const k = await key();
  const id = devices.pairRelay(devices.startPairing().code, "Phone", k.spki)!.device.id;
  devices.linkAccountKey(id, k.spki, k.spki, ACCOUNT);
  return { ...k, id };
}

const block = (target: string, by: Key, claims = { target_no: 9, signer_no: 1 }): Promise<BlockRecord> =>
  signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, ...claims, signer: by.spki, signed_at: new Date().toISOString(), nonce: newRecordId() }, by.keys.privateKey) as Promise<BlockRecord>;
const lift = (target: string, by: Key): Promise<DeviceLiftRecord> =>
  signSafetyRecord({ v: 1, kind: "lift", account: ACCOUNT, target, signer: by.spki, signer_no: 1, signed_at: new Date().toISOString() }, by.keys.privateKey) as Promise<DeviceLiftRecord>;

let snapshots = 0;
function page(over: Partial<AccountSnapshotPage>): { page: AccountSnapshotPage } {
  snapshots++;
  return { page: { v: 1, snapshot: snapshots.toString(16).padStart(32, "0"), account: ACCOUNT, server_id: SERVER, version: snapshots, methods_version: 0, page: 0, last: true, devices: [], removed: [], blocks: [], lifts: [], freezes: [], ...over } };
}
const read = (ports: ReturnType<typeof pc>["ports"], answer: PageAnswer) => readSnapshot(async () => answer, ports);

describe("S2-24 a whole read applied to this PC's real state (G1, T15, T52, T58)", () => {
  test("T52: a forged block in a snapshot page is not applied and raises nothing", async () => {
    const { devices, safetyLog, ports } = pc();
    const [older, target] = [await member(devices), await member(devices)];
    const good = await block(target.spki, older);
    const forged = { ...good, signature: (await block(older.spki, target)).signature };
    expect(await read(ports, page({ blocks: [forged] }))).toMatchObject({ committed: true, denials: 1 });
    expect(safetyLog.entries()).toHaveLength(0);
    expect(devices.has(target.id)).toBe(true);
  });

  test("P21: a newer key's block claiming signer number 1 is refused; a valid block applies as it is read", async () => {
    const { devices, safetyLog, ports } = pc();
    const [older, target, late] = [await member(devices), await member(devices), await member(devices)];
    expect(await read(ports, page({ blocks: [await block(target.spki, late, { target_no: 99, signer_no: 1 })] }))).toMatchObject({ committed: true });
    expect(devices.has(target.id)).toBe(true);
    expect(safetyLog.entries()).toHaveLength(0);
    expect(await read(ports, page({ blocks: [await block(target.spki, older)] }))).toMatchObject({ committed: true });
    expect(devices.has(target.id)).toBe(false);
    expect(safetyLog.entries()).toHaveLength(1);
  });

  test("T52: a lift signed by a key newer here is refused; an older device's lift in a whole read ends the freeze", async () => {
    const { devices, safetyLog, ports } = pc();
    const [older, target, newer] = [await member(devices), await member(devices), await member(devices)];
    const blocked = await block(target.spki, older);
    expect(await devices.applyBlock(blocked, "handed")).toMatchObject({ outcome: "applied" });
    const stranger = (await key()).spki;
    expect(devices.admits(stranger)).toBe(false);
    expect(await read(ports, page({ lifts: [await lift(blocked.id, newer)] }))).toMatchObject({ committed: true, liftsRefused: 1 });
    expect(devices.admits(stranger)).toBe(false);
    expect(await read(ports, page({ lifts: [await lift(blocked.id, older)] }))).toMatchObject({ committed: true, liftsRefused: 0 });
    expect(devices.admits(stranger)).toBe(true);
    expect(safetyLog.state().freezes).toEqual([]);
  });

  test("T58: a committed methods version change is journalled once", async () => {
    const { devices, journal, ports } = pc();
    await member(devices);
    const methods = () => journal.entries().filter((entry) => entry.kind === "method").length;
    await read(ports, page({ methods_version: 2 }));
    await read(ports, page({ methods_version: 2 }));
    expect(methods()).toBe(1);
    await read(ports, page({ methods_version: 3 }));
    expect(methods()).toBe(2);
  });

  test("G1: a snapshot older than the last one applied is refused", async () => {
    const { devices, ports } = pc();
    await member(devices);
    const newer = page({});
    const older = page({});
    older.page = { ...older.page, version: 1 };
    newer.page = { ...newer.page, version: 5 };
    expect(await read(ports, newer)).toMatchObject({ committed: true });
    expect(await read(ports, older)).toEqual({ committed: false, reason: "stale", denials: 0 });
  });

  test("T52, P21: a lift signed by a key the account's order marks late is refused, though it is older here", async () => {
    const { devices, ports } = pc();
    const [older, target] = [await member(devices), await member(devices)];
    const blocked = await block(target.spki, older);
    expect(await devices.applyBlock(blocked, "handed")).toMatchObject({ outcome: "applied" });
    // the first read lists the target at 5; the next lists the older key first at 3: late in the account's order
    await read(ports, page({ devices: [{ key: target.spki, no: 5, eligible: true, label: "T" }] }));
    await read(ports, page({ devices: [{ key: older.spki, no: 3, eligible: true, label: "O" }, { key: target.spki, no: 5, eligible: true, label: "T" }] }));
    expect(await devices.liftAuthority(await lift(blocked.id, older))).toBe(false);
  });
});

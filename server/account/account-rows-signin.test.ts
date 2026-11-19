import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signSafetyRecord, type BlockRecord } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { AccountDeviceStore } from "./account-devices.ts";
import { DeviceJournal } from "./device-journal.ts";
import { PcAccountState } from "./pc-binding.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const ACCOUNT = "acct_1";
const SERVER = "0123456789abcdef0123456789abcdef";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Key { keys: CryptoKeyPair; spki: string }
async function key(): Promise<Key> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

/** A PC in ACCOUNT with its real log, binding and journal, and the account rows attached to its device store. */
function pc() {
  const dir = mkdtempSync(join(tmpdir(), "s2-25-signin-"));
  dirs.push(dir);
  const safety = SafetyLog.open(dir);
  const binding = PcAccountState.open(dir);
  const journal = DeviceJournal.open(dir);
  const devices = new DeviceStore(dir, null, null, { safety, pc: binding, removals: RemovalEvidence.open(dir, safety), journal });
  const clock = { now: Date.now() };
  const rows = new AccountDeviceStore(dir, SERVER, {
    journal: (entry) => { journal.append({ kind: entry.kind === "drop" ? "drop" : "admit", how: entry.reason ?? "list", key: entry.key, no: entry.no ?? null, row: entry.row, label: entry.label ?? "", by: null, account: ACCOUNT }); },
    closeSessions: (id) => { devices.closeAccountSessions(id); },
    heldByDevicesJson: (candidate) => devices.hasKey(candidate),
    admits: (candidate) => devices.admits(candidate),
    now: () => clock.now,
    admitOrigin: (at) => binding.admit("remote", "list", null, at),
  });
  devices.attachAccountRows(rows);
  return { devices, rows, clock };
}

async function member(devices: DeviceStore): Promise<Key & { id: string }> {
  const k = await key();
  const id = devices.pairRelay(devices.startPairing().code, "Phone", k.spki)!.device.id;
  devices.linkAccountKey(id, k.spki, k.spki, ACCOUNT);
  return { ...k, id };
}

function listed(...keys: Key[]) {
  return { account: ACCOUNT, snapshot: "1".padStart(32, "0"), version: 1, devices: keys.map((k, index) => ({ key: k.spki, no: index + 10, label: `Device ${index}`, eligible: true })), removed: [] };
}

async function signIn(devices: DeviceStore, id: string, signer: Key, serverId = SERVER) {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const message = Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(serverId)]);
  const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.keys.privateKey, message)).toString("base64url");
  return devices.matchAccountRelay(id, nonce, signature, serverId);
}

describe("S2-25 an account-joined row signs in by relay AUTH (S21, S25, T35)", () => {
  test("S25: a proved sign-in of a held row is refused with its reason, and a wrong key learns nothing", async () => {
    const { devices, rows } = pc();
    await member(devices);
    const phone = await key();
    rows.commitList(listed(phone));
    const [row] = rows.rows();
    expect(await signIn(devices, row!.id, phone)).toEqual({ refused: { refused: "join_hold", seconds: null }, holdUntil: null });
    expect(await signIn(devices, row!.id, await key())).toBeNull();
    expect(devices.sessionRow(row!.id)).toBeNull();
    expect(devices.has(row!.id)).toBe(true);
  });

  test("T35: a list drop reaches the row's revoke listeners through the device store, and the row is gone", async () => {
    const { devices, rows } = pc();
    await member(devices);
    const phone = await key();
    rows.commitList(listed(phone));
    const [row] = rows.rows();
    const closed: string[] = [];
    devices.onRevoke(row!.id, () => { closed.push(row!.id); });
    expect(closed).toEqual([]);
    rows.commitList({ ...listed(), snapshot: "2".padStart(32, "0"), version: 2 });
    expect(closed).toEqual([row!.id]);
    expect(devices.has(row!.id)).toBe(false);
    expect(await signIn(devices, row!.id, phone)).toBeNull();
  });

  test("T64: a block of an account-joined key ends its row and closes the sessions of the account rows it freezes, in the apply turn", async () => {
    const { devices, rows } = pc();
    const signer = await member(devices);
    const [target, newer] = [await key(), await key()];
    rows.commitList(listed(target, newer));
    const [targetRow, newerRow] = rows.rows();
    const closed: string[] = [];
    for (const row of [targetRow!, newerRow!]) devices.onRevoke(row.id, () => { closed.push(row.id); });
    devices.onRevoke(signer.id, () => { closed.push(signer.id); });
    const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: target.spki, target_no: 10, signer: signer.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, signer.keys.privateKey) as BlockRecord;
    expect(await devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied" });
    expect(closed.sort()).toEqual([targetRow!.id, newerRow!.id].sort());
    expect(rows.row(targetRow!.id)).toBeNull();
    expect(rows.row(newerRow!.id)).not.toBeNull();
    expect(devices.sessionRow(newerRow!.id)).toBeNull();
  });

  test("P21: an account-joined row signs as a member, and every row of the target, in both stores, must have joined after it", async () => {
    const { devices, rows } = pc();
    await member(devices);
    const [signer, target] = [await key(), await key()];
    rows.commitList(listed(signer, target));
    const late = await member(devices);
    const block = (by: Key, of: string) => signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: of, target_no: 9, signer: by.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, by.keys.privateKey) as Promise<BlockRecord>;
    // the devices.json row that joined after both account rows cannot block the older account row
    expect(await devices.applyBlock(await block(late, signer.spki), "handed")).toMatchObject({ outcome: "refused", reason: "signer_not_older" });
    // the older account row can block the newer one
    expect(await devices.applyBlock(await block(signer, target.spki), "handed")).toMatchObject({ outcome: "applied" });
  });

  test("T36, P5: an account-joined key signs no remove of another key, newer or not; a devices.json member still may", async () => {
    const { devices, rows } = pc();
    const older = await member(devices);
    const [joined, newer] = [await key(), await key()];
    rows.commitList(listed(joined, newer));
    expect(devices.removeAuthority(joined.spki, newer.spki, ACCOUNT)).toBe(false);
    expect(devices.removeAuthority(joined.spki, joined.spki, ACCOUNT)).toBe(true);
    expect(devices.removeAuthority(older.spki, newer.spki, ACCOUNT)).toBe(true);
  });
});

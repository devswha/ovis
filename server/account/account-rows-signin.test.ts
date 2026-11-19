import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey } from "../../shared/account-records.ts";
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
    expect(await signIn(devices, row!.id, phone)).toEqual({ refused: { refused: "join_hold", seconds: null } });
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
});

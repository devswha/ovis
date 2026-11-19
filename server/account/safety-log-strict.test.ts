import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signSafetyRecord, type SafetyRecord } from "../../shared/account-records.ts";
import { DeviceStore } from "../devices.ts";
import { pcRecordId, SafetyLog } from "./safety-log.ts";

const AT = "2026-11-20T09:00:00.000Z";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); } });

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "ovis-safety-strict-"));
  dirs.push(made);
  return made;
}
async function signer() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}
const pc = (kind: "lock" | "unlock" | "lift", account: string, target: string | null): SafetyRecord =>
  ({ v: 1, id: pcRecordId(), kind, account, target, signer: "pc", signed_at: AT, signature: "", ...(kind === "lift" ? { forget: false } : {}) }) as SafetyRecord;

describe("the safety log's endings and its failed writes (P24, S19)", () => {
  test("P24: an ending ends only a record of its own account", async () => {
    const log = SafetyLog.open(dir());
    const by = await signer();
    const block = await signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: (await signer()).spki, target_no: 3, signer: by.spki, signer_no: 1, signed_at: AT, nonce: newRecordId() }, by.keys.privateKey);
    const lock = pc("lock", "acct_1", null);
    for (const record of [block, lock]) log.append({ record, got: "pc", ...(record.kind === "block" ? { asof: { signer_no: 1, target_no: 3, after: 3, joined: 3, signer_removed: false } } : {}) });
    log.append({ record: pc("lift", "acct_2", block.id), got: "pc" });
    log.append({ record: pc("unlock", "acct_2", lock.id), got: "pc" });
    expect(log.state().blocks.map((entry) => entry.record.id)).toEqual([block.id]);
    expect(log.state().locked).toBe(true);
    log.append({ record: pc("lift", "acct_1", block.id), got: "pc" });
    log.append({ record: pc("unlock", "acct_1", lock.id), got: "pc" });
    expect(log.state().blocks).toEqual([]);
    expect(log.state().locked).toBe(false);
  });

  test("S19: an append that cannot be written fails the PC closed until a reload finds the log whole, and every way in is refused meanwhile", async () => {
    const at = dir();
    const log = SafetyLog.open(at);
    const devices = new DeviceStore(at, null, null, log);
    const phone = await signer();
    const id = devices.pairRelay(devices.startPairing().code, "Phone", phone.spki)!.device.id;
    chmodSync(at, 0o500);
    expect(log.append({ record: pc("lock", "acct_1", null), got: "pc" })).toMatchObject({ outcome: "refused", code: "log_unavailable" });
    expect(log.strict).not.toBeNull();
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const serverId = "0123456789abcdef0123456789abcdef";
    const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, phone.keys.privateKey, Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(serverId)]))).toString("base64url");
    expect(await devices.matchRelay(id, nonce, signature, serverId)).toBeNull();
    expect(devices.pairRelay(devices.startPairing().code, "Tablet", (await signer()).spki)).toBeNull();
    expect(devices.pairRelayApproved("Tablet", (await signer()).spki, { path: "account", addedBy: id })).toBeNull();
    chmodSync(at, 0o700);
    // strict stays on this handle until a reload finds the log whole (S19)
    expect(log.append({ record: pc("lock", "acct_1", null), got: "pc" }).outcome).toBe("refused");
    expect(log.strict).not.toBeNull();
    expect(SafetyLog.open(at).strict).toBeNull();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SafetyRecord } from "../../shared/account-records.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { DEVICE_JOURNAL_FILE, pcRecordId, SAFETY_LOG_FILE, SafetyLog } from "./safety-log.ts";

const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "ovis-safety-gate-"));
  dirs.push(made);
  return made;
}
const lock = (): SafetyRecord => ({ v: 1, id: pcRecordId(), kind: "lock", account: "acct_1", target: null, signer: "pc", signed_at: new Date().toISOString(), signature: "" });

describe("the safety log holds what it acknowledged (P24, T28, T41, S19)", () => {
  test("T28: a log missing beside the device journal S2-07 writes fails closed", () => {
    const at = dir();
    expect(DEVICE_JOURNAL_FILE).toBe("device-journal.json");
    writeFileSync(join(at, DEVICE_JOURNAL_FILE), JSON.stringify({ v: 1, next_seq: 1, entries: [], seen: {}, open: [], trimmed: 0 }), { mode: 0o600 });
    expect(SafetyLog.open(at).strict).not.toBeNull();
  });

  test("T41: what is in force is worked out at start, before any listener answers", () => {
    const at = dir();
    SafetyLog.open(at).append({ record: lock(), got: "pc" });
    const fixture = relayFixture(false, { stateDir: at, accountOpensAll: true });
    fixtures.push(fixture);
    dirs.splice(dirs.indexOf(at), 1);
    // the replay ran in createServer: the served handle holds the lock without being asked
    expect(fixture.app.context.services.safetyLog?.inForce.locked).toBe(true);
  });

  test("S19: a failed append keeps the log strict until a reload finds it whole", () => {
    const at = dir();
    const log = SafetyLog.open(at);
    log.append({ record: lock(), got: "pc" });
    chmodSync(at, 0o500);
    expect(log.append({ record: lock(), got: "pc" }).outcome).toBe("refused");
    chmodSync(at, 0o700);
    // a later, unrelated append neither goes in nor clears the failure
    expect(log.append({ record: lock(), got: "pc" })).toMatchObject({ outcome: "refused", code: "log_unavailable" });
    expect(log.strict).not.toBeNull();
    expect(SafetyLog.open(at).strict).toBeNull();
  });

  test("P24: numbers account for every entry, so a history this writer could not have made fails closed", () => {
    const at = dir();
    writeFileSync(join(at, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 2, base: [], entries: [], waiting: [] }), { mode: 0o600 });
    expect(SafetyLog.open(at).strict).not.toBeNull();
  });

  test("P24: two handles of one folder never give one number twice nor lose an acknowledged record", () => {
    const at = dir();
    const [a, b] = [SafetyLog.open(at), SafetyLog.open(at)];
    const [first, second] = [lock(), lock()];
    expect(a.append({ record: first, got: "pc" })).toEqual({ outcome: "applied", id: first.id, n: 1 });
    expect(b.append({ record: second, got: "pc" })).toEqual({ outcome: "applied", id: second.id, n: 2 });
    const reopened = SafetyLog.open(at);
    expect(reopened.receipt(first.id)).toEqual({ outcome: "applied", id: first.id, n: 1 });
    expect(reopened.receipt(second.id)).toEqual({ outcome: "applied", id: second.id, n: 2 });
  });
});

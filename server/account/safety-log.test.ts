import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../devices.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { ACCOUNT_JOURNAL_FILE, pcRecordId, SAFETY_LOG_FILE, SafetyLog, signedRecordId, type BlockAsOf, type SafetyRecord } from "./safety-log.ts";

const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-safety-log-"));
  dirs.push(dir);
  return dir;
}

const ACCOUNT = "acct_1";
const AT = "2026-11-20T10:00:00.000Z";
const ASOF: BlockAsOf = { signer_no: 1, target_no: 3, after: 3, joined: 7, signer_removed: false };

/** A P-256 SPKI in base64url, as the log stores keys; only its form matters here. */
async function key(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64url");
}

/** A device-signed record as the log keeps it: its signed bytes whole, and an id that is their SHA-256. */
function signed(kind: "block" | "lift", target: string, signer: string): { record: SafetyRecord; bytes: Uint8Array } {
  const bytes = new Uint8Array(randomBytes(120));
  const record: SafetyRecord = { id: signedRecordId(bytes), kind, account: ACCOUNT, target, signer, signed_at: AT, sig: randomBytes(64).toString("base64url") };
  return { record, bytes };
}

function pcRecord(kind: "lock" | "unlock" | "lift" | "forget", target: string | null, extra: Partial<SafetyRecord> = {}): SafetyRecord {
  return { id: pcRecordId(), kind, account: ACCOUNT, target, signer: "pc", signed_at: AT, sig: "", ...extra };
}

function serviceFreeze(blockId: string, target: string): SafetyRecord {
  return { id: `f:${blockId}`, kind: "freeze", account: ACCOUNT, target, signer: "service", signed_at: AT, sig: "" };
}

const ids = (entries: readonly { record: { id: string } }[]) => entries.map((entry) => entry.record.id).sort();

describe("the PC safety log (account-log.json)", () => {
  test("P24: append preserves signed bytes, IDs and increasing local numbers", async () => {
    const dir = stateDir();
    const signer = await key();
    const target = await key();
    const log = SafetyLog.open(dir);
    expect(log.strict).toBeNull();
    const block = signed("block", target, signer);
    expect(log.append({ record: block.record, bytes: block.bytes, got: "handed", asof: ASOF })).toEqual({ outcome: "applied", id: block.record.id, n: 1 });
    const lock = pcRecord("lock", null);
    expect(log.append({ record: lock, got: "pc" })).toEqual({ outcome: "applied", id: lock.id, n: 2 });
    // the same record again is the same receipt, read from the log, and appends nothing
    expect(log.append({ record: block.record, bytes: block.bytes, got: "mailbox", asof: ASOF })).toEqual({ outcome: "applied", id: block.record.id, n: 1 });
    expect(log.receipt(block.record.id)).toEqual({ outcome: "applied", id: block.record.id, n: 1 });

    // what a restart reads is what was appended: bytes whole, ids and numbers kept, the next number never used
    const again = SafetyLog.open(dir);
    expect(again.strict).toBeNull();
    const entries = again.entries();
    expect(entries.map((entry) => entry.n)).toEqual([1, 2]);
    expect(entries[0]!.record).toEqual(block.record);
    expect(entries[0]!.got).toBe("handed");
    expect(entries[0]!.asof).toEqual(ASOF);
    expect(Buffer.from(entries[0]!.bytes!, "base64url").equals(Buffer.from(block.bytes))).toBe(true);
    expect(entries[1]!.record).toEqual(lock);
    const unlock = pcRecord("unlock", lock.id);
    expect(again.append({ record: unlock, got: "pc" })).toEqual({ outcome: "applied", id: unlock.id, n: 3 });
    const file = JSON.parse(readFileSync(join(dir, SAFETY_LOG_FILE), "utf8")) as { v: number; next: number; base: unknown[]; entries: unknown[]; waiting: unknown[] };
    expect(file).toMatchObject({ v: 1, next: 4, base: [], waiting: [] });
    expect(file.entries).toHaveLength(3);

    // a signed record whose id is not the hash of its bytes, and a second record under a known id, are refused and change nothing
    const forged = signed("block", target, signer);
    expect(again.append({ record: { ...forged.record, id: createHash("sha256").update("other").digest("hex") }, bytes: forged.bytes, got: "handed", asof: ASOF }).outcome).toBe("refused");
    expect(again.append({ record: { ...lock, signed_at: "2026-11-21T10:00:00.000Z" }, got: "pc" })).toEqual({ outcome: "refused", id: lock.id, code: "conflict" });
    expect(again.entries()).toHaveLength(3);
    expect(again.strict).toBeNull();
  });

  test("T41: replay derives block, freeze, lock and record-specific endings before serving", async () => {
    const dir = stateDir();
    const signer = await key();
    const [a, b, c, frozen] = [await key(), await key(), await key(), await key()];
    const log = SafetyLog.open(dir);
    const blockA = signed("block", a, signer);
    const blockB = signed("block", b, signer);
    const blockC = signed("block", c, signer);
    for (const block of [blockA, blockB, blockC]) log.append({ record: block.record, bytes: block.bytes, got: "mailbox", asof: ASOF });
    const freeze = serviceFreeze(createHash("sha256").update("a block this log does not hold").digest("hex"), frozen);
    log.append({ record: freeze, got: "snapshot" });
    const lock1 = pcRecord("lock", null);
    const lock2 = pcRecord("lock", null);
    log.append({ record: lock1, got: "pc" });
    log.append({ record: lock2, got: "pc" });
    // a lift ends the block it names and that block's freeze; its marker stands
    const liftA = signed("lift", blockA.record.id, signer);
    log.append({ record: liftA.record, bytes: liftA.bytes, got: "snapshot" });
    // a forgetting lift ends block B and its marker
    log.append({ record: pcRecord("lift", blockB.record.id, { forget: true }), got: "pc" });
    // an unlock ends the one lock it names
    log.append({ record: pcRecord("unlock", lock1.id), got: "pc" });
    // endings that name a record of another kind end nothing
    log.append({ record: pcRecord("unlock", blockC.record.id), got: "pc" });
    log.append({ record: pcRecord("lift", lock2.id), got: "pc" });
    const replayed = (state: ReturnType<SafetyLog["state"]>) => ({
      locked: state.locked,
      locks: ids(state.locks),
      blocks: ids(state.blocks),
      freezes: ids(state.freezes),
      markers: ids(state.markers),
    });
    const expected = {
      locked: true,
      locks: [lock2.id],
      blocks: [blockC.record.id],
      freezes: [blockC.record.id, freeze.id].sort(),
      markers: [blockA.record.id, blockC.record.id].sort(),
    };
    expect(replayed(log.state())).toEqual(expected);
    // a start replays the file alone and derives the same: nothing ended comes back
    expect(replayed(SafetyLog.open(dir).state())).toEqual(expected);

    // a lift of a service freeze's block ends that freeze (by `f:` and the block's id)
    const liftFreeze = pcRecord("lift", freeze.id.slice(2));
    log.append({ record: liftFreeze, got: "pc" });
    log.append({ record: pcRecord("unlock", lock2.id), got: "pc" });
    expect(replayed(SafetyLog.open(dir).state())).toEqual({ ...expected, locked: false, locks: [], freezes: [blockC.record.id] });

    // the server replays it in createServer, before any listener answers
    const fixture = relayFixture(false, { stateDir: dir, accountOpensAll: true });
    fixtures.push(fixture);
    dirs.splice(dirs.indexOf(dir), 1);
    const served = fixture.app.context.services.safetyLog;
    expect(served).not.toBeNull();
    expect(replayed(served!.state())).toEqual({ ...expected, locked: false, locks: [], freezes: [blockC.record.id] });
  });

  test("T28: missing or invalid log fails closed once journal exists", async () => {
    // no journal and no log: a PC that never kept one starts with an empty log
    const fresh = stateDir();
    expect(SafetyLog.open(fresh).strict).toBeNull();
    expect(existsSync(join(fresh, SAFETY_LOG_FILE))).toBe(false);

    const journalled = () => {
      const dir = stateDir();
      writeFileSync(join(dir, ACCOUNT_JOURNAL_FILE), JSON.stringify({ v: 1, entries: [] }), { mode: 0o600 });
      return dir;
    };
    // missing beside a journal
    const missing = journalled();
    expect(SafetyLog.open(missing).strict).toContain(SAFETY_LOG_FILE);
    // not JSON
    const garbled = journalled();
    writeFileSync(join(garbled, SAFETY_LOG_FILE), "{not json", { mode: 0o600 });
    expect(SafetyLog.open(garbled).strict).not.toBeNull();
    // one id with two different records
    const signer = await key();
    const target = await key();
    const block = signed("block", target, signer);
    const entry = { n: 1, got: "handed", record: block.record, bytes: Buffer.from(block.bytes).toString("base64url"), asof: ASOF };
    const twice = journalled();
    writeFileSync(join(twice, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 3, base: [], waiting: [], entries: [entry, { ...entry, n: 2, record: { ...block.record, target: signer } }] }), { mode: 0o600 });
    expect(SafetyLog.open(twice).strict).not.toBeNull();
    // a signed record whose id is not the hash of the bytes it keeps
    const forged = journalled();
    writeFileSync(join(forged, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 2, base: [], waiting: [], entries: [{ ...entry, bytes: randomBytes(120).toString("base64url") }] }), { mode: 0o600 });
    expect(SafetyLog.open(forged).strict).not.toBeNull();
    // a number taken twice, or one at or past `next`
    const numbered = journalled();
    writeFileSync(join(numbered, SAFETY_LOG_FILE), JSON.stringify({ v: 1, next: 1, base: [], waiting: [], entries: [entry] }), { mode: 0o600 });
    expect(SafetyLog.open(numbered).strict).not.toBeNull();

    // a strict log appends nothing, so the file it could not read is never written over
    const before = readFileSync(join(garbled, SAFETY_LOG_FILE), "utf8");
    const strictLog = SafetyLog.open(garbled);
    expect(strictLog.append({ record: pcRecord("lock", null), got: "pc" })).toMatchObject({ outcome: "refused", code: "log_unavailable" });
    expect(readFileSync(join(garbled, SAFETY_LOG_FILE), "utf8")).toBe(before);

    // fails closed: a device this PC paired signs in no more, and account records are refused, until the log is put right
    const dir = journalled();
    writeFileSync(join(dir, SAFETY_LOG_FILE), "[]", { mode: 0o600 });
    const pairing = new DeviceStore(dir);
    const { token } = pairing.pair(pairing.startPairing().code, "Phone", "drive")!;
    expect(pairing.match(token)).not.toBeNull();
    const closed = new DeviceStore(dir, null, null, SafetyLog.open(dir));
    expect(closed.match(token)).toBeNull();
    expect(closed.accountError).not.toBeNull();
    expect(closed.gated).toBe(true);
    expect(closed.pair(closed.startPairing().code, "Other", "drive")).toBeNull();

    // the same through the server's own start
    const fixture = relayFixture(false, { stateDir: dir, accountOpensAll: true });
    fixtures.push(fixture);
    dirs.splice(dirs.indexOf(dir), 1);
    expect(fixture.app.context.services.safetyLog?.strict).not.toBeNull();
    expect(fixture.app.context.services.devices.match(token)).toBeNull();
  });

  test("P24: missing release flag leaves the existing PC path and files untouched", () => {
    const previous = process.env["OVIS_ACCOUNT_OPENS_ALL"];
    delete process.env["OVIS_ACCOUNT_OPENS_ALL"];
    try {
      // a log that would fail closed, beside a journal: with the flag off nobody reads it, and nothing is written
      const dir = stateDir();
      writeFileSync(join(dir, ACCOUNT_JOURNAL_FILE), JSON.stringify({ v: 1, entries: [] }), { mode: 0o600 });
      writeFileSync(join(dir, SAFETY_LOG_FILE), "{not json", { mode: 0o600 });
      const pairing = new DeviceStore(dir);
      const { token } = pairing.pair(pairing.startPairing().code, "Phone", "drive")!;
      expect(pairing.match(token)).not.toBeNull();
      const fixture = relayFixture(false, { stateDir: dir });
      fixtures.push(fixture);
      dirs.splice(dirs.indexOf(dir), 1);
      expect(fixture.app.context.services.safetyLog).toBeNull();
      expect(fixture.app.context.services.devices.match(token)).not.toBeNull();
      expect(fixture.app.context.services.devices.accountError).toBeNull();
      expect(readFileSync(join(dir, SAFETY_LOG_FILE), "utf8")).toBe("{not json");

      // a PC with no log gets none
      const empty = relayFixture(false, {});
      fixtures.push(empty);
      expect(empty.app.context.services.safetyLog).toBeNull();
      expect(existsSync(join(empty.stateDir, SAFETY_LOG_FILE))).toBe(false);

      // only "1" turns it on
      process.env["OVIS_ACCOUNT_OPENS_ALL"] = "true";
      const other = relayFixture(false, {});
      fixtures.push(other);
      expect(other.app.context.services.safetyLog).toBeNull();
    } finally {
      if (previous === undefined) delete process.env["OVIS_ACCOUNT_OPENS_ALL"];
      else process.env["OVIS_ACCOUNT_OPENS_ALL"] = previous;
    }
  });
});

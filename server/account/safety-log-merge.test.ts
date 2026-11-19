import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayFixture } from "../relay/test-helpers.ts";
import { mergeSafetyLogs, pcRecordId, SAFETY_LOG_FILE, SafetyLog, signedRecordId, type BlockAsOf, type SafetyRecord } from "./safety-log.ts";

const dirs: string[] = [];
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-safety-merge-"));
  dirs.push(dir);
  return dir;
}

const ACCOUNT = "acct_1";
const AT = "2026-11-20T10:00:00.000Z";
const asof = (after: number): BlockAsOf => ({ signer_no: 1, target_no: after, after, joined: null, signer_removed: false });

async function key(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64url");
}

function block(target: string, signer: string) {
  const bytes = new Uint8Array(randomBytes(120));
  const record: SafetyRecord = { id: signedRecordId(bytes), kind: "block", account: ACCOUNT, target, signer, signed_at: AT, sig: randomBytes(64).toString("base64url") };
  return { record, bytes };
}

const pc = (kind: "lock" | "unlock" | "lift", target: string | null, extra: Partial<SafetyRecord> = {}): SafetyRecord =>
  ({ id: pcRecordId(), kind, account: ACCOUNT, target, signer: "pc", signed_at: AT, sig: "", ...extra });

const inForce = (log: SafetyLog) => {
  const state = log.state();
  return { locked: state.locked, blocks: state.blocks.map((e) => e.record.id).sort(), markers: state.markers.map((e) => e.record.id).sort() };
};
const numbers = (log: SafetyLog) => Object.fromEntries(log.entries().map((entry) => [entry.record.id, { n: entry.n, got: entry.got }]));

describe("merging and folding the PC safety log", () => {
  test("T48: both directories retain endings and local numbering despite different receipt metadata", async () => {
    const [own, other] = [stateDir(), stateDir()];
    const signer = await key();
    const x = block(await key(), signer);
    const y = block(await key(), signer);
    const lock = pc("lock", null);
    const mine = SafetyLog.open(own);
    mine.append({ record: x.record, bytes: x.bytes, got: "handed", asof: asof(3) });
    mine.append({ record: lock, got: "pc" });
    const theirs = SafetyLog.open(other);
    // the same lock, taken another way; an ending the owner made in the other dir only; a block only it holds
    theirs.append({ record: lock, got: "merge" });
    const liftX = pc("lift", x.record.id);
    theirs.append({ record: liftX, got: "pc" });
    theirs.append({ record: y.record, bytes: y.bytes, got: "mailbox", asof: asof(5) });

    expect(mergeSafetyLogs(own, other)).toBeNull();
    const [a, b] = [SafetyLog.open(own), SafetyLog.open(other)];
    expect(a.strict).toBeNull();
    expect(b.strict).toBeNull();
    // each dir keeps its numbers, and takes the other's records after its last one, in that dir's order
    expect(numbers(a)).toEqual({ [x.record.id]: { n: 1, got: "handed" }, [lock.id]: { n: 2, got: "pc" }, [liftX.id]: { n: 3, got: "merge" }, [y.record.id]: { n: 4, got: "merge" } });
    expect(numbers(b)).toEqual({ [lock.id]: { n: 1, got: "merge" }, [liftX.id]: { n: 2, got: "pc" }, [y.record.id]: { n: 3, got: "mailbox" }, [x.record.id]: { n: 4, got: "merge" } });
    // the asof the other dir noted comes with its record; signed bytes come whole
    expect(a.entries().find((e) => e.record.id === y.record.id)?.asof).toEqual(asof(5));
    expect(Buffer.from(b.entries().find((e) => e.record.id === x.record.id)!.bytes!, "base64url").equals(Buffer.from(x.bytes))).toBe(true);
    // nothing ended comes back, nothing in force is lost: the same state in both
    const expected = { locked: true, blocks: [y.record.id], markers: [x.record.id, y.record.id].sort() };
    expect(inForce(a)).toEqual(expected);
    expect(inForce(b)).toEqual(expected);
    // a second merge changes nothing
    const before = readFileSync(join(own, SAFETY_LOG_FILE), "utf8");
    expect(mergeSafetyLogs(own, other)).toBeNull();
    expect(readFileSync(join(own, SAFETY_LOG_FILE), "utf8")).toBe(before);

    // a dir with no log takes the other's records
    const empty = stateDir();
    expect(mergeSafetyLogs(empty, own)).toBeNull();
    expect(inForce(SafetyLog.open(empty))).toEqual(expected);
  });

  test("T48: conflicting signed records of the same ID fail closed", async () => {
    const [own, other] = [stateDir(), stateDir()];
    const signer = await key();
    const x = block(await key(), signer);
    SafetyLog.open(own).append({ record: x.record, bytes: x.bytes, got: "handed", asof: asof(3) });
    // the same id with another target: one id, two records
    const forged = { ...x.record, target: await key() };
    const theirs = SafetyLog.open(other);
    expect(theirs.append({ record: forged, bytes: x.bytes, got: "handed", asof: asof(3) }).outcome).toBe("applied");
    const [ownBefore, otherBefore] = [readFileSync(join(own, SAFETY_LOG_FILE), "utf8"), readFileSync(join(other, SAFETY_LOG_FILE), "utf8")];
    const problem = mergeSafetyLogs(own, other);
    expect(problem).not.toBeNull();
    // nothing written to either dir, and the PC fails closed until it is put right
    expect(readFileSync(join(own, SAFETY_LOG_FILE), "utf8")).toBe(ownBefore);
    expect(readFileSync(join(other, SAFETY_LOG_FILE), "utf8")).toBe(otherBefore);
    expect(SafetyLog.open(own, problem).strict).not.toBeNull();

    // the server's own start: a sibling dir with a conflicting log fails the PC closed
    const sibling = stateDir();
    const conflicting = SafetyLog.open(sibling);
    conflicting.append({ record: forged, bytes: x.bytes, got: "handed", asof: asof(3) });
    const active = stateDir();
    SafetyLog.open(active).append({ record: x.record, bytes: x.bytes, got: "handed", asof: asof(3) });
    const fixture = relayFixture(false, { stateDir: active, siblingStateDir: sibling, accountOpensAll: true });
    fixtures.push(fixture);
    dirs.splice(dirs.indexOf(active), 1);
    expect(fixture.app.context.services.safetyLog?.strict).not.toBeNull();
    expect(fixture.app.context.services.devices.accountError).not.toBeNull();
  });

  test("P24: folding keeps evidence needed by a live marker and never forgets an ID", async () => {
    const dir = stateDir();
    const signer = await key();
    const log = SafetyLog.open(dir);
    const x = block(await key(), signer);
    const y = block(await key(), signer);
    const lock = pc("lock", null);
    for (const b of [x, y]) log.append({ record: b.record, bytes: b.bytes, got: "handed", asof: asof(3) });
    log.append({ record: lock, got: "pc" });
    // nothing folds while any record is in force
    expect(log.fold()).toBe(0);
    log.append({ record: pc("unlock", lock.id), got: "pc" });
    log.append({ record: pc("lift", x.record.id), got: "pc" });
    log.append({ record: pc("lift", x.record.id, { forget: true }), got: "pc" });
    log.append({ record: pc("lift", y.record.id), got: "pc" });
    expect(log.fold()).toBeGreaterThan(0);
    const reopened = SafetyLog.open(dir);
    const kept = reopened.entries().map((e) => e.record.id);
    // y was lifted but not forgotten: its marker stands, so its entry stays whole with its bytes, and so does its lift
    expect(kept).toContain(y.record.id);
    expect(reopened.entries().find((e) => e.record.id === y.record.id)?.bytes).toBeDefined();
    expect(inForce(reopened).markers).toEqual([y.record.id]);
    // x, the lock and their endings folded: known and ended, never forgotten
    expect(kept).not.toContain(x.record.id);
    expect(kept).not.toContain(lock.id);
    const base = (JSON.parse(readFileSync(join(dir, SAFETY_LOG_FILE), "utf8")) as { base: { id: string; kind: string; ended_by: string[] }[] }).base;
    expect(base.find((line) => line.id === x.record.id)).toMatchObject({ kind: "block", account: ACCOUNT });
    expect(base.find((line) => line.id === lock.id)).toBeDefined();
    // a folded id handed again starts nothing, and a merge never brings it back
    expect(reopened.append({ record: x.record, bytes: x.bytes, got: "handed", asof: asof(3) })).toEqual({ outcome: "already_applied", id: x.record.id });
    const sibling = stateDir();
    SafetyLog.open(sibling).append({ record: x.record, bytes: x.bytes, got: "mailbox", asof: asof(3) });
    expect(mergeSafetyLogs(dir, sibling)).toBeNull();
    expect(inForce(SafetyLog.open(dir))).toEqual({ locked: false, blocks: [], markers: [y.record.id] });
    expect(inForce(SafetyLog.open(sibling)).blocks).toEqual([]);
    expect(existsSync(join(sibling, SAFETY_LOG_FILE))).toBe(true);
  });

  test("T51: repeat yields applied with its local number until fold, then already_applied", async () => {
    const dir = stateDir();
    const log = SafetyLog.open(dir);
    const x = block(await key(), await key());
    expect(log.append({ record: x.record, bytes: x.bytes, got: "handed", asof: asof(3) })).toEqual({ outcome: "applied", id: x.record.id, n: 1 });
    log.append({ record: pc("lift", x.record.id), got: "pc" });
    // lifted, not forgotten: still whole, still the same receipt
    expect(log.fold()).toBe(0);
    expect(log.append({ record: x.record, bytes: x.bytes, got: "mailbox", asof: asof(3) })).toEqual({ outcome: "applied", id: x.record.id, n: 1 });
    log.append({ record: pc("lift", x.record.id, { forget: true }), got: "pc" });
    expect(log.fold()).toBeGreaterThan(0);
    expect(log.receipt(x.record.id)).toEqual({ outcome: "already_applied", id: x.record.id });
    expect(log.append({ record: x.record, bytes: x.bytes, got: "mailbox", asof: asof(3) })).toEqual({ outcome: "already_applied", id: x.record.id });
    expect(createHash("sha256").update(x.bytes).digest("hex")).toBe(x.record.id);
  });
});

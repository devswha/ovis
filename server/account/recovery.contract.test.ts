/**
 * `ovis recover` against a real server (device-row-states rows R11, T70, P23, S19): with the release flag on the
 * server opens the recovery socket in its state folder and answers it; with the flag off it opens none. While the
 * log cannot be read, the list still answers and nothing is released.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { newRecordId, signSafetyRecord, type BlockRecord, type SafetyRecord } from "../../shared/account-records.ts";
import { bounded } from "../relay/test-helpers.ts";
import { JOURNAL_FILE } from "./device-journal.ts";
import { memberRow, pairingPc, phone, provingDevice, type Pc } from "./pairing.test-helpers.ts";
import { pcRecordId } from "./safety-log.ts";
import { askRecovery, RECOVER_DIR, RECOVER_SOCKET } from "./recovery.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });
const unix = process.platform !== "win32";

test.if(unix)("R11: with the flag on, the server answers ovis recover on its recovery socket", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true } });
  pcs.push(made);
  expect(await bounded(askRecovery(made.stateDir, { act: "list" }))).toEqual({ rows: [], pending: [] });
});

test.if(unix)("R11: with the flag off, the server opens no recovery socket", async () => {
  const made = await pairingPc({ server: { accountOpensAll: false } });
  pcs.push(made);
  expect(existsSync(join(made.stateDir, RECOVER_DIR, RECOVER_SOCKET))).toBe(false);
});

test.if(unix)("P23: while the log cannot be read, ovis recover still lists, and releases nothing", async () => {
  const made = await pairingPc({ startRelay: false, server: { accountOpensAll: true },
    prepare: (dir) => { writeFileSync(join(dir, "account-log.json"), "not json", { mode: 0o600 }); } });
  pcs.push(made);
  made.app.context.services.recoveryReleases!.registerRecoverySource(() => [{
    id: "0123456789abcdef", key: "key-a", label: "Phone", origin: { from: "remote", how: "list" }, waiting: "catching_up",
    joinHold: false, held: false, openNotice: false, expired: false, covered: false, frozen: false, lastSeenAt: null,
  }]);
  const listed = await bounded(askRecovery(made.stateDir, { act: "list" })) as { rows: { id: string; refusal: string | null }[] };
  expect(listed.rows.map((row) => [row.id, row.refusal])).toEqual([["0123456789abcdef", "log_unreadable"]]);
  expect(await bounded(askRecovery(made.stateDir, { act: "release", rows: ["0123456789abcdef"] }))).toEqual({ error: "0123456789abcdef cannot be released: log_unreadable" });
  expect(made.app.context.services.recoveryReleases!.releaseOf("0123456789abcdef")).toBeNull();
});

test.if(unix)("P23/T37/T69/T70/P22: every write refuses a log that turns unreadable after start without changing state", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  const releases = made.app.context.services.recoveryReleases!;
  releases.registerRecoverySource(() => [{
    id: "0123456789abcdef", key: "key-a", label: "Phone", origin: { from: "remote", how: "list" }, waiting: "catching_up",
    joinHold: false, held: false, openNotice: false, expired: false, covered: false, frozen: false, lastSeenAt: null,
  }]);
  expect(await bounded(askRecovery(made.stateDir, { act: "release", rows: ["0123456789abcdef"] }))).toEqual({ released: ["0123456789abcdef"] });
  const { waiting } = await waitingDevice(made);
  const activeRelease = releases.releaseOf("0123456789abcdef");
  const beforeRows = made.stored();
  const beforeJournal = journal(made);
  const logPath = join(made.stateDir, "account-log.json");
  writeFileSync(logPath, "not json", { mode: 0o600 });

  const error = { error: "This PC cannot read its safety log, so nothing is changed: log_unreadable" };
  for (const action of [
    { act: "remove", targets: [member.row.id] },
    { act: "lift", blocks: ["a".repeat(64)] },
    { act: "revoke_all" },
    { act: "admit", pending: waiting.id, fingerprint: waiting.fingerprint },
    { act: "undo", rows: null },
  ]) {
    expect(await bounded(askRecovery(made.stateDir, action))).toEqual(error);
  }
  // The write gate must answer before release looks up a row, even one that does not wait here.
  const missing = "fedcba9876543210";
  expect(await bounded(askRecovery(made.stateDir, { act: "release", rows: [missing] }))).toEqual({ error: `${missing} cannot be released: log_unreadable` });

  const listed = await bounded(askRecovery(made.stateDir, { act: "list" })) as { rows: { refusal: string | null }[]; pending: unknown[] };
  expect(listed.rows.map((row) => row.refusal)).toEqual(["log_unreadable"]);
  expect(listed.pending).toEqual([waiting]);
  expect(made.stored()).toEqual(beforeRows);
  expect(journal(made)).toEqual(beforeJournal);
  expect(readFileSync(logPath, "utf8")).toBe("not json");
  expect(releases.releaseOf("0123456789abcdef")).toEqual(activeRelease);
});

test.if(unix)("T37: remove of a named key over the socket ends its row and records the removal", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true } });
  pcs.push(made);
  expect(await bounded(askRecovery(made.stateDir, { act: "remove", targets: [member.row.id] }))).toEqual({ removed: [member.row.id] });
  expect(made.stored().some((row) => row.id === member.row.id)).toBe(false);
});

test.if(unix)("T69: a lift of a block this log does not hold is refused, and changes nothing", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true } });
  pcs.push(made);
  const answer = await bounded(askRecovery(made.stateDir, { act: "lift", blocks: ["a".repeat(64)] })) as { error?: string };
  expect(answer.error).toContain("was not lifted");
});

test.if(unix)("T70: revoke-all over the socket ends every row", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true } });
  pcs.push(made);
  expect(await bounded(askRecovery(made.stateDir, { act: "revoke_all" }))).toEqual({ revoked: 1 });
  expect(made.stored()).toEqual([]);
});

test.if(unix)("P23: while the log cannot be read, remove, lift, revoke-all and admit all refuse", async () => {
  const made = await pairingPc({ startRelay: false, server: { accountOpensAll: true },
    prepare: (dir) => { writeFileSync(join(dir, "account-log.json"), "not json", { mode: 0o600 }); } });
  pcs.push(made);
  for (const act of [{ act: "remove", targets: ["0123456789abcdef"] }, { act: "lift", blocks: ["a".repeat(64)] }, { act: "revoke_all" },
    { act: "admit", pending: "0123456789abcdef0123456789abcdef", fingerprint: "AB12-CD34" }]) {
    expect(await bounded(askRecovery(made.stateDir, act))).toEqual({ error: "This PC cannot read its safety log, so nothing is changed: log_unreadable" });
  }
});

test.if(unix)("P22: admit of a device that does not wait here admits nobody", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true } });
  pcs.push(made);
  expect(await bounded(askRecovery(made.stateDir, { act: "admit", pending: "0123456789abcdef0123456789abcdef", fingerprint: "AB12-CD34" }))).toEqual({ error: "No such device waits here" });
});

const journal = (made: Pc) => (JSON.parse(readFileSync(join(made.stateDir, JOURNAL_FILE), "utf8")) as { entries: { kind: string; how: string; row: string | null; label: string; by: string | null }[] }).entries;

async function waitingDevice(made: Pc) {
  const paired = await provingDevice(made, await made.offerCode());
  await paired.pending;
  const listed = await bounded(askRecovery(made.stateDir, { act: "list" })) as { pending: { id: string; label: string; fingerprint: string }[] };
  return { paired, waiting: listed.pending.find((entry) => entry.fingerprint === paired.fingerprint)! };
}

test.if(unix)("P22/T70: the fingerprint the terminal showed admits the waiting device once, with origin recover; a wrong one admits nobody", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  const { paired, waiting } = await waitingDevice(made);
  expect(waiting.label).toBe("New phone");
  expect(await bounded(askRecovery(made.stateDir, { act: "admit", pending: waiting.id, fingerprint: `${waiting.fingerprint[0] === "0" ? "1" : "0"}${waiting.fingerprint.slice(1)}` }))).toEqual({ error: "The fingerprint does not match the waiting device" });
  expect(made.stored().some((row) => row.relay_public_key === paired.device.spki)).toBe(false);
  const admitted = await bounded(askRecovery(made.stateDir, { act: "admit", pending: waiting.id, fingerprint: waiting.fingerprint })) as { admitted: string };
  const row = made.stored().find((stored) => stored.relay_public_key === paired.device.spki) as { id: string; origin?: { from: string } } | undefined;
  expect(row?.id).toBe(admitted.admitted);
  expect(row?.origin?.from).toBe("recover");
  expect(await bounded(askRecovery(made.stateDir, { act: "admit", pending: waiting.id, fingerprint: waiting.fingerprint }))).toEqual({ error: "No such device waits here" });
});

test.if(unix)("P22: while the PC is locked, the right fingerprint admits nobody, and the waiting device is gone", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  const { paired, waiting } = await waitingDevice(made);
  made.app.context.services.safetyLog!.append({ record: { v: 1, id: pcRecordId(), kind: "lock", account: "acct_1", target: null, signer: "pc", signed_at: new Date().toISOString(), signature: "" } as SafetyRecord, got: "pc" });
  expect(await bounded(askRecovery(made.stateDir, { act: "admit", pending: waiting.id, fingerprint: waiting.fingerprint }))).toEqual({ error: "This PC refused to admit the key (locked, frozen, or its log cannot be read)" });
  expect(made.stored().some((row) => row.relay_public_key === paired.device.spki)).toBe(false);
  expect((await bounded(askRecovery(made.stateDir, { act: "list" })) as { pending: unknown[] }).pending).toEqual([]);
});

test.if(unix)("T69/P24: a lift at the PC ends the block, and the journal says recover and this PC's user", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true } });
  pcs.push(made);
  const [signer, target] = [await phone(), await phone()];
  for (const key of [signer, target]) {
    const id = made.devices.pairRelay(made.devices.startPairing().code, "Phone", key.spki)!.device.id;
    made.devices.linkAccountKey(id, key.spki, key.spki, "acct_1");
  }
  const block = await signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: target.spki, target_no: 9, signer: signer.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, signer.keys.privateKey) as BlockRecord;
  await made.devices.applyBlock(block, "handed");
  expect(await bounded(askRecovery(made.stateDir, { act: "lift", blocks: [block.id] }))).toEqual({ lifted: [block.id] });
  expect(made.app.context.services.safetyLog!.state().blocks).toEqual([]);
  expect(journal(made).filter((entry) => entry.kind === "lift")).toEqual([expect.objectContaining({ how: "recover", label: block.id, by: userInfo().username })]);
});

test.if(unix)("T37/P24: remove and revoke-all are journalled with recover and this PC's user", async () => {
  const [first, second] = [await memberRow("acct_1"), await memberRow("acct_1")];
  const made = await pairingPc({ rows: [first.row, second.row], server: { accountOpensAll: true } });
  pcs.push(made);
  await bounded(askRecovery(made.stateDir, { act: "remove", targets: [first.row.id] }));
  await bounded(askRecovery(made.stateDir, { act: "revoke_all" }));
  const lines = journal(made).filter((entry) => entry.kind === "remove");
  expect(lines.map((entry) => entry.row)).toEqual(expect.arrayContaining([first.row.id, second.row.id]));
  expect(lines.every((entry) => entry.how === "recover" && entry.by === userInfo().username)).toBe(true);
});

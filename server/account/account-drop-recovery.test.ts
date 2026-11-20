import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountDeviceId, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { privateStateFs } from "../private-state.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { keyOf } from "./account-devices.test-helpers.ts";
import { DeviceJournal, JOURNAL_FILE, JOURNAL_MAX } from "./device-journal.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { applyAccountRecords } from "./records.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const listedPc = () => createListedPc(close => closes.push(close));
const rows = (dir: string) => parseAccountDevicesFile(JSON.parse(readFileSync(join(dir, ACCOUNT_DEVICES_FILE), "utf8"))).devices;
const drops = (dir: string) => DeviceJournal.open(dir).entries().filter(entry => entry.kind === "drop")
  .map(({ kind, how, key, row, account }) => ({ kind, how, key, row, account }));

function failReplacement(path: string) {
  const rename = privateStateFs.renameSync;
  return spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (to === path) throw new Error("replacement failed");
    rename(from, to);
  });
}

async function leave({ fixture, device, serverId }: Awaited<ReturnType<typeof listedPc>>) {
  const record = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, signer: device.publicKey,
    key: device.publicKey, id: newRecordId(), issued_at: new Date().toISOString() }, device.keys.privateKey);
  return applyAccountRecords(fixture.app.context.services.devices, [record], serverId);
}

function restartOffline(dir: string) {
  const restarted = relayFixture(false, { stateDir: dir, accountOpensAll: true, accountService: { url: "off" } });
  restarted.app.stop();
}

test("P8/T41/P10/T44: identity reset preserves a signed leave's pending drop", async () => {
  const pc = await listedPc();
  const { fixture, device } = pc;
  const dir = fixture.stateDir;
  const fault = failReplacement(join(dir, JOURNAL_FILE));
  try { await expect(leave(pc)).rejects.toThrow("replacement failed"); } finally { fault.mockRestore(); }
  expect(rows(dir).map(row => row.id)).toEqual([device.id]);
  expect(drops(dir)).toEqual([]);
  await fixture.app.context.services.relay.resetIdentity();
  fixture.app.stop();
  restartOffline(dir);
  restartOffline(dir);
  expect(drops(dir).filter(entry => entry.row === device.id)).toEqual([
    { kind: "drop", how: "remove", key: device.publicKey, row: device.id, account: ACCOUNT },
  ]);
  expect(rows(dir)).toEqual([]);
});

test.each(["last listed row", "still-listed sibling"] as const)("P8/T41/P10: leave then Revoke-all during one outage (%s)", async scenario => {
  const pc = await listedPc();
  const { fixture, device, serverId, service } = pc;
  const { accountMailbox, devices } = fixture.app.context.services;
  const dir = fixture.stateDir;
  const siblingKey = keyOf("sibling");
  const sibling = accountDeviceId(serverId, siblingKey);
  const expected = [{ kind: "drop" as const, how: "remove", key: device.publicKey, row: device.id, account: ACCOUNT }];
  if (scenario === "still-listed sibling") {
    service.registerDevice(ACCOUNT, siblingKey, "Sibling");
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expected.push({ kind: "drop", how: "revoke_all", key: siblingKey, row: sibling, account: ACCOUNT });
  }
  const fault = failReplacement(join(dir, JOURNAL_FILE));
  try {
    await expect(leave(pc)).rejects.toThrow("replacement failed");
    try { devices.revokeAll(); } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("replacement failed")) throw error;
    }
    expect(rows(dir).map(row => row.id)).toEqual(expected.map(entry => entry.row));
    expect(drops(dir)).toEqual([]);
  } finally { fault.mockRestore(); }
  fixture.app.stop();
  restartOffline(dir);
  restartOffline(dir);
  expect(drops(dir).filter(entry => entry.row === device.id || entry.row === sibling)).toEqual(expected);
  expect(rows(dir)).toEqual([]);
});

test("P8/T41/P10: offline Revoke recovery allocates no new drop after the original is trimmed", async () => {
  const { fixture, device, member } = await listedPc();
  const dir = fixture.stateDir;
  const { devices } = fixture.app.context.services;
  const fault = failReplacement(join(dir, ACCOUNT_DEVICES_FILE));
  try { expect(() => devices.revoke(device.id)).toThrow("replacement failed"); } finally { fault.mockRestore(); }
  expect(rows(dir).map(row => row.id)).toEqual([device.id]);
  const original = DeviceJournal.open(dir).entries().at(-1);
  expect(original).toMatchObject({ kind: "drop", how: "revoke", row: device.id });
  for (let index = 0; index < JOURNAL_MAX; index++) {
    devices.journalEvent({ kind: "account", how: "link", key: member.publicKey, row: member.id, account: ACCOUNT, no: null, label: "", by: null });
  }
  const retained = DeviceJournal.open(dir).entries();
  expect(retained[0]?.seq).toBe((original?.seq ?? 0) + 1);
  fixture.app.stop();
  restartOffline(dir);
  expect(rows(dir)).toEqual([]);
  expect(DeviceJournal.open(dir).entries().at(-1)?.seq).toBe(retained.at(-1)?.seq);
});

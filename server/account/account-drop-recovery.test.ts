import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { privateStateFs } from "../private-state.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { DeviceJournal, JOURNAL_FILE } from "./device-journal.ts";
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

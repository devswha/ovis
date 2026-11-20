import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceJournal, JOURNAL_FILE } from "./device-journal.ts";
import { privateStateFs } from "../private-state.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { keyOf } from "./account-devices.test-helpers.ts";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { accountDeviceId, newRecordId, signAccountRecord, signSafetyRecord } from "../../shared/account-records.ts";
import { applyAccountRecords } from "./records.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { FrameType, type MuxFrame, ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import { bounded, relayConnection, relayFixture } from "../relay/test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

const listedPc = () => createListedPc(close => closes.push(close));

async function refusal(pc: Awaited<ReturnType<typeof listedPc>>, features: readonly string[]) {
  const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
  let failed: Extract<MuxFrame, { type: typeof FrameType.SESSION_ERROR }>["payload"] | undefined;
  link.onFrame = (frame) => { if (frame.type === FrameType.SESSION_ERROR) failed = frame.payload; };
  void link.auth(pc.device, features).catch(() => undefined);
  await bounded(link.serverError);
  return failed;
}

describe("S2-25 an account-joined sign-in over the relay (S25)", () => {
  test.each([
    ["revoke", JOURNAL_FILE], ["remove", JOURNAL_FILE], ["remove", ACCOUNT_DEVICES_FILE],
    ["block", JOURNAL_FILE], ["block", ACCOUNT_DEVICES_FILE], ["revoke_all", ACCOUNT_DEVICES_FILE],
  ] as const)("P8, T41: offline restart records %s once after replacement of %s failed", async (act, file) => {
    const { fixture, device, member, serverId } = await listedPc();
    const { devices } = fixture.app.context.services;
    const { stateDir } = fixture;
    const rename = privateStateFs.renameSync;
    const fault = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (to === join(stateDir, file)) throw new Error("replacement failed");
      rename(from, to);
    });
    try {
      switch (act) {
        case "revoke": expect(() => devices.revoke(device.id)).toThrow("replacement failed"); break;
        case "revoke_all": expect(() => devices.revokeAll()).toThrow("replacement failed"); break;
        case "remove": {
          const record = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, signer: device.publicKey,
            key: device.publicKey, id: newRecordId(), issued_at: new Date().toISOString() }, device.keys.privateKey);
          await expect(applyAccountRecords(devices, [record], serverId)).rejects.toThrow("replacement failed");
          break;
        }
        case "block": {
          const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: device.publicKey,
            signer: member.publicKey, target_no: 2, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, member.keys.privateKey);
          expect(await devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied" });
          break;
        }
      }
    } finally { fault.mockRestore(); }
    expect(devices.has(device.id)).toBe(false);
    const registry = () => parseAccountDevicesFile(JSON.parse(readFileSync(join(stateDir, ACCOUNT_DEVICES_FILE), "utf8"))).devices;
    if (act !== "revoke") expect(registry().map(row => row.id)).toEqual([device.id]);
    fixture.app.stop();
    const recovered = relayFixture(false, { stateDir, accountOpensAll: true, accountService: { url: "off" } });
    try {
      const restarted = recovered.app.context.services.devices;
      expect(restarted.isTombstoned(device.publicKey)).toBe(true);
      expect(restarted.has(member.id)).toBe(act !== "revoke_all");
      expect(restarted.has(device.id)).toBe(false);
      expect(registry()).toEqual([]);
      const history = DeviceJournal.open(stateDir).entries().filter(entry => entry.row === device.id);
      expect(history.map(({ kind, how }) => [kind, how])).toEqual([["admit", "list"], ["drop", act]]);
    } finally { recovered.app.stop(); }
  });

  test.each(["before", "after"] as const)("P8, T41: startup finishes an account revoke interrupted %s its journal write", async (cut) => {
    const { fixture, device, member } = await listedPc();
    const { devices } = fixture.app.context.services;
    const path = join(fixture.stateDir, ACCOUNT_DEVICES_FILE);
    const checkpoint = `${path}.at-interrupt`;
    const append = DeviceJournal.prototype.append;
    const failure = spyOn(DeviceJournal.prototype, "append").mockImplementation(function (this: DeviceJournal, entry) {
      if (entry.kind === "drop" && entry.how === "revoke") {
        copyFileSync(path, checkpoint);
        if (cut === "after") append.call(this, entry);
        throw new Error("journal unavailable");
      }
      return append.call(this, entry);
    });
    try { expect(() => devices.revoke(device.id)).toThrow("journal unavailable"); } finally { failure.mockRestore(); }
    const knownAfterFailure = devices.has(device.id);
    expect(devices.isTombstoned(device.publicKey)).toBe(true);
    fixture.app.stop();
    // A process stop at the checkpoint runs no final registry write.
    copyFileSync(checkpoint, path);
    const recovered = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: true, accountService: { url: "off" } });
    try {
      const rows = parseAccountDevicesFile(JSON.parse(readFileSync(path, "utf8"))).devices;
      const restarted = recovered.app.context.services.devices;
      expect({ knownAfterFailure, persisted: rows.map(row => row.id), knownAfterRestart: restarted.has(device.id) })
        .toEqual({ knownAfterFailure: false, persisted: [], knownAfterRestart: false });
      expect(restarted.isTombstoned(device.publicKey)).toBe(true);
      expect(restarted.has(member.id)).toBe(true);
      const history = DeviceJournal.open(fixture.stateDir).entries().filter(entry => entry.row === device.id);
      expect(history.map(({ kind, how }) => [kind, how])).toEqual([["admit", "list"], ["drop", "revoke"]]);
    } finally { recovered.app.stop(); }
  });

  test("T20, P8: revoke-all intent and all session closes survive a failed account drop journal", async () => {
    const { fixture, device, member } = await listedPc();
    const { devices } = fixture.app.context.services;
    const intent = join(fixture.stateDir, "revoke-all.json");
    const closedWithDeny: string[] = [];
    for (const id of [member.id, device.id]) devices.onRevoke(id, () => { if (existsSync(intent)) closedWithDeny.push(id); });
    const append = DeviceJournal.prototype.append;
    const failure = spyOn(DeviceJournal.prototype, "append").mockImplementation(function (this: DeviceJournal, entry) {
      if (entry.kind === "drop" && entry.how === "revoke_all") throw new Error("journal unavailable");
      return append.call(this, entry);
    });
    try { expect(() => devices.revokeAll()).toThrow("journal unavailable"); } finally { failure.mockRestore(); }
    expect(closedWithDeny.sort()).toEqual([member.id, device.id].sort());
    expect(devices.has(member.id)).toBe(false);
    expect(existsSync(intent)).toBe(true);
    fixture.app.stop();
    const recovered = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: true, accountService: { url: "off" } });
    try {
      expect(recovered.app.context.services.devices.account()).toBeNull();
      expect(recovered.app.context.services.devices.has(device.id)).toBe(false);
      expect(existsSync(intent)).toBe(false);
    } finally { recovered.app.stop(); }
  });

  for (const deny of ["local revoke", "account removal"] as const) {
    test(`T34, G6: a valid list cannot restore a key covered by its ${deny}`, async () => {
      const { fixture, device, serverId } = await listedPc();
      const { services } = fixture.app.context;
      if (deny === "local revoke") {
        expect(services.devices.revoke(device.id)).toBe(true);
      } else {
        const record = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, signer: device.publicKey, key: device.publicKey,
          id: newRecordId(), issued_at: "2026-11-01T00:00:00.000Z" }, device.keys.privateKey);
        expect(await applyAccountRecords(services.devices, [record], serverId)).toMatchObject([{ outcome: "applied" }]);
      }
      expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      expect(services.devices.isTombstoned(device.publicKey)).toBe(true);
      expect(services.devices.has(device.id)).toBe(false);
    });
  }

  test.each(["enrollment", "held key", "waiting removal"] as const)("T34, G8/G9: a whole read commits without admitting a key blocked by %s", async (gate) => {
    const { fixture, service, serverId, member } = await listedPc();
    const { accountMailbox, accountHolds, devices } = fixture.app.context.services;
    const key = keyOf("k-waiting");
    service.registerDevice(ACCOUNT, key, "Waiting phone");
    switch (gate) {
      case "enrollment": accountHolds.startEnrolling(member.id); break;
      case "held key": accountHolds.hold([key]); break;
      case "waiting removal":
        expect(accountMailbox.wait(await signAccountRecord({ v: 1, kind: "remove", key, account: ACCOUNT,
          signer: member.publicKey, id: newRecordId(), issued_at: new Date().toISOString() }, member.keys.privateKey))).toBe(true);
        break;
    }
    // A barred candidate must not even need a writable admission journal for the read to commit.
    const append = DeviceJournal.prototype.append;
    const fence = spyOn(DeviceJournal.prototype, "append").mockImplementation(function (this: DeviceJournal, entry) {
      if (entry.kind === "admit" && entry.key === key) throw new Error("unexpected join notice for blocked key");
      return append.call(this, entry);
    });
    try {
      const outcome = await accountMailbox.readSnapshot();
      expect(accountMailbox.error).toBeNull();
      expect(outcome).toMatchObject({ committed: true });
      expect(devices.has(accountDeviceId(serverId, key))).toBe(false);
    } finally { fence.mockRestore(); }
  });

  test("T34, G15: a list stops at 64 unanswered notices and resumes when one is answered", async () => {
    const { fixture, device, service, serverId } = await listedPc();
    const { accountMailbox, devices } = fixture.app.context.services;
    const [original] = devices.openNotices();
    if (!original) throw new Error("missing initial join notice");
    const ids = Array.from({ length: 65 }, (_, index) => {
      const key = keyOf(`k-${index}`);
      service.registerDevice(ACCOUNT, key, `Phone ${index}`);
      return accountDeviceId(serverId, key);
    });
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(devices.openNotices()).toHaveLength(64);
    expect(devices.openNotices()).toContainEqual(original);
    expect(devices.has(device.id)).toBe(true);
    expect(ids.filter(id => devices.has(id))).toHaveLength(63);

    devices.decideNotice(original.id);
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(ids.filter(id => devices.has(id))).toHaveLength(64);
    expect(devices.openNotices()).toHaveLength(64);
  });

  test("S25: the whole read admits the listed device as an account row, held until its notice is out", async () => {
    const pc = await listedPc();
    expect(pc.fixture.app.context.services.devices.has(pc.device.id)).toBe(true);
  });

  test("S25: an app that offered the account feature is refused held, with its hold state", async () => {
    const pc = await listedPc();
    expect(await refusal(pc, [ACCOUNT_OPENS_ALL_FEATURE])).toEqual({ code: "held", message: "This device waits for its join hold on this PC", hold: { reason: "join_hold", until: null } });
  });

  test("S25: an old-app hello gets today's code for the same refusal", async () => {
    const pc = await listedPc();
    expect(await refusal(pc, [])).toEqual({ code: "auth_failed", message: "auth_failed" });
  });
});

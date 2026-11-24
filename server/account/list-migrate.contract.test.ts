/**
 * A PC whose account was in use before it had a signed list (docs/account-list.md, "An account that was in use"): what
 * it tells a device of the keys it has let in, how it comes to follow the list a device names to it, and what it does
 * with the rows of that list once it follows it.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { bounded, relayAccountFixture, relayConnection, relayDevice, relayFixture, TestClock } from "../relay/test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT_LIST_OWED_FILE } from "./list-follow.ts";
import { MIGRATE_TIME_SCALE_ENV } from "./migrate-time.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { ask } from "./pairing.test-helpers.ts";
import { asSignIn, birthPlan, migratingDevice, MigratedList, type MigratingPhone } from "./migrate.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

const DAY_MS = 86_400_000;
/** How often the PC under test reads its account's snapshot while time passes. */
const READ_EVERY_MS = 30 * 60_000;
/** A key this PC put out: what a device's sign-in key was before somebody removed it here. */
const removedKey = (await migratingDevice("Old phone")).signIn.key;

/** The PC's clocks, moved by hand together: the time of day every part of it reads, and the clock its waits and its running time are counted on. */
function testTime() {
  let now = Date.now();
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  closes.push(() => spy.mockRestore());
  const waits = new TestClock();
  return { waits, advance(ms: number) { now += ms; waits.advance(ms); }, seconds: () => Math.floor(now / 1000) };
}

/**
 * A PC in an account that was in use: the account's snapshot let a phone and a tablet in by their sign-in keys, and
 * the PC has let both in for a day and more, by both of its clocks. The account has no list yet.
 */
async function accountInUse() {
  const time = testTime();
  const service = new FakeAccountService();
  service.opensAll = true;
  service.listAccounts = "*";
  const accountService = { url: "https://account.test", fetch: service.fetch };
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService });
  closes.push(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const { services } = fixture.app.context;
  services.devices.useClock(time.waits);
  const endpoint = bytesToHex(importPublicKey(services.relay.currentIdentity()!.public_key));
  const phone = await migratingDevice("Phone");
  const tablet = await migratingDevice("Tablet");
  for (const device of [phone, tablet]) service.registerDevice(ACCOUNT, device.signIn.key, device.label);
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  time.advance(JOIN_HOLD_MS + 1_000);
  for (const device of [phone, tablet]) expect(services.accountRows!.access(accountDeviceId(serverId, device.signIn.key))).toEqual({ ok: true });
  const witness = services.accountWitness!;
  witness.step();
  /**
   * Time passes with the PC running: both of its clocks move, it reads the account's snapshot as it does every few
   * minutes (with no whole read for an hour its rows would wait for one), and its record takes each stretch.
   */
  const run = async (ms: number) => {
    for (let left = ms; left > 0; left -= READ_EVERY_MS) {
      time.advance(Math.min(left, READ_EVERY_MS));
      expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      witness.step();
    }
  };
  await run(DAY_MS + 60_000);
  const list = services.accountList!;
  const pull = async () => { await services.accountMailbox.pull(); await list.settled(); };
  /** What a sign-in comes to: the role the PC lets the device in as, or null. */
  const signsIn = async (device: MigratingPhone, which: "signIn" | "member" = "signIn"): Promise<"drive" | "watch" | null> => {
    const link = await relayConnection(fixture, { serverId });
    return await link.auth(asSignIn(serverId, device, which)).then((ok) => ok.role, () => null);
  };
  const rowOf = (key: string) => services.accountRows!.rows().find((row) => row.key === key) ?? null;
  return { time, service, fixture, member, serverId, services, endpoint, phone, tablet, witness, run, list, pull, signsIn, rowOf };
}

describe("what a PC tells a device of its account before the account moves", () => {
  test("the keys it lets in through the account now, for how long by its two counters, and the keys it holds a removal against", async () => {
    const pc = await accountInUse();
    const guest = await relayDevice(pc.fixture);
    pc.services.devices.removeAccountKey(removedKey, ACCOUNT, { id: "b".repeat(32), issuedAt: new Date().toISOString() });
    const phone = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await phone.auth(asSignIn(pc.serverId, pc.phone));
    const answer = await ask(phone, "/api/account/list/witness");
    expect(answer.status).toBe(200);
    const body = answer.body as { account: string; pinned: string | null; admits: { key: string; wall: number; ran: number; idle: number | null }[]; removed: string[] };
    expect([body.account, body.pinned, body.removed]).toEqual([ACCOUNT, null, [removedKey]]);
    // the account's rows alone: the pairing made at this PC is none, and neither is a guest's
    expect(body.admits.map((row) => row.key).sort()).toEqual([pc.phone.signIn.key, pc.tablet.signIn.key].sort());
    for (const row of body.admits) {
      expect(row.wall).toBeGreaterThanOrEqual(86_400);
      expect(row.ran).toBeGreaterThanOrEqual(86_400);
    }
    // the phone signed in today; the tablet's row was let in and not used since
    expect(body.admits.find((row) => row.key === pc.phone.signIn.key)?.idle).toBeLessThan(86_400);
    // a pairing of the account's member may ask too, and a device outside the account may not
    const member = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await member.auth(pc.member);
    expect((await ask(member, "/api/account/list/witness")).status).toBe(200);
    const outsider = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await outsider.auth(guest);
    expect((await ask(outsider, "/api/account/list/witness")).status).toBe(403);
  });

  test("a key let in a moment ago is told with what it has; a row that waits for the account service is told as none", async () => {
    const pc = await accountInUse();
    const laptop = await migratingDevice("Laptop");
    pc.service.registerDevice(ACCOUNT, laptop.signIn.key, "Laptop");
    expect(await pc.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(pc.services.accountRows!.access(accountDeviceId(pc.serverId, laptop.signIn.key))).toEqual({ ok: true });
    await pc.run(60_000);
    const phone = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await phone.auth(asSignIn(pc.serverId, pc.phone));
    const admits = (await ask(phone, "/api/account/list/witness")).body as { admits: { key: string; wall: number; ran: number }[] };
    expect(admits.admits.find((row) => row.key === laptop.signIn.key)).toMatchObject({ wall: 60, ran: 60 });
    // two hours with no whole read of the snapshot: every row waits for one, and lets nobody in meanwhile
    pc.time.advance(2 * 60 * 60_000);
    expect(pc.services.accountWitness!.admits()).toEqual({ account: ACCOUNT, admits: [] });
  });

  test("a staging run's factor multiplies what the PC tells, and says so in its status; the production service never takes it", async () => {
    const was = process.env[MIGRATE_TIME_SCALE_ENV];
    process.env[MIGRATE_TIME_SCALE_ENV] = "60";
    closes.push(() => { if (was === undefined) delete process.env[MIGRATE_TIME_SCALE_ENV]; else process.env[MIGRATE_TIME_SCALE_ENV] = was; });
    const pc = await accountInUse();
    const phone = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await phone.auth(asSignIn(pc.serverId, pc.phone));
    const told = (await ask(phone, "/api/account/list/witness")).body as { admits: { key: string; wall: number; ran: number }[] };
    const record = pc.witness.record()!.keys[pc.phone.signIn.key]!;
    expect(told.admits.find((row) => row.key === pc.phone.signIn.key)).toMatchObject({ wall: record.wall * 60, ran: record.ran * 60 });
    expect((await ask(phone, "/api/account/status")).body).toMatchObject({ migrate_time_scale: 60 });
    const production = relayFixture(false, { accountOpensAll: true, accountService: { url: "https://account.ovis.sh", fetch: pc.service.fetch } });
    closes.push(() => production.close());
    expect(production.app.context.services.accountWitness!.scale).toBe(1);
  });

  test("a PC in no account answers not_in_account", async () => {
    const fixture = relayFixture(false, { accountOpensAll: true });
    closes.push(() => fixture.close());
    const base = `http://127.0.0.1:${fixture.app.port}`;
    const answer = await fetch(`${base}/api/account/list/witness`, { headers: { origin: base } });
    expect([answer.status, ((await answer.json()) as { error: { code: string } }).error.code]).toEqual([409, "not_in_account"]);
  });
});

/** The same PC, once the phone moved the account onto its list carrying the tablet in, and pinned to that list by a person at it. */
async function pinnedToBirth() {
  const pc = await accountInUse();
  const born = await MigratedList.born(pc.service, ACCOUNT, pc.phone, birthPlan([pc.tablet]), pc.time.seconds);
  await pc.pull();
  expect(await pc.list.wantList(born.id)).toMatchObject({ status: { pinned: false, want: born.id } });
  await born.addPostedPc(pc.endpoint, pc.phone.member);
  await pc.pull();
  expect(pc.list.status()).toMatchObject({ pinned: true, standing: "in", list: born.id });
  pc.time.advance(JOIN_HOLD_MS + 1_000);
  return { ...pc, born };
}

describe("after the pin, the rows the list makes", () => {
  test("a carried device that hands its place to its account key keeps its row on this PC: no removal, no hold, no notice", async () => {
    const pc = await pinnedToBirth();
    expect(await pc.signsIn(pc.tablet)).toBe("drive");
    const before = pc.rowOf(pc.tablet.signIn.key)!;
    const published = spyOn(pc.services.devices, "publish");
    const announced = spyOn(pc.services.devices, "announceListAdmissions");
    const open = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await open.auth(asSignIn(pc.serverId, pc.tablet));
    await pc.born.handOver(pc.tablet);
    await pc.pull();
    // the session of the key it handed over ends as a row that changed under it, and it signs in with its account key
    expect(await bounded(open.serverError, 2000)).toBe("auth_changed");
    const after = pc.rowOf(pc.tablet.member.key);
    expect(after).toMatchObject({ id: accountDeviceId(pc.serverId, pc.tablet.member.key), no: before.no, label: before.label, origin: before.origin, state: "live", hold_until: null });
    expect(pc.rowOf(pc.tablet.signIn.key)).toBeNull();
    expect(await pc.signsIn(pc.tablet, "member")).toBe("drive");
    expect(await pc.signsIn(pc.tablet)).toBeNull();
    // a hand-over is no removal: nothing is kept against the key it ended, and nothing is owed
    expect(pc.services.devices.isTombstoned(pc.tablet.signIn.key)).toBe(false);
    expect(existsSync(join(pc.fixture.stateDir, ACCOUNT_LIST_OWED_FILE))).toBe(false);
    expect([published.mock.calls.length, announced.mock.calls.length]).toEqual([0, 0]);
  });

  test("a device this PC holds a removal against stays out by whichever of its keys it is in by", async () => {
    const pc = await pinnedToBirth();
    pc.services.devices.removeAccountKey(pc.tablet.signIn.key, ACCOUNT, { id: "a".repeat(32), issuedAt: new Date().toISOString() });
    await pc.pull();
    expect(await pc.signsIn(pc.tablet)).toBeNull();
    await pc.born.handOver(pc.tablet);
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(pc.rowOf(pc.tablet.member.key)).toBeNull();
    expect(await pc.signsIn(pc.tablet, "member")).toBeNull();
    expect(pc.list.role(pc.tablet.member.key)).toBeNull();
  });

  test("a carried key that never handed over is let in only while the account's snapshot names it too", async () => {
    const pc = await pinnedToBirth();
    expect(await pc.signsIn(pc.tablet)).toBe("drive");
    const open = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await open.auth(asSignIn(pc.serverId, pc.tablet));
    // the tablet's sign-in ends at the account service: the list still holds its key, and nobody signs a removal
    pc.service.removeDevice(ACCOUNT, pc.tablet.signIn.key);
    await pc.pull();
    expect(await bounded(open.serverError, 2000)).toBe("auth_revoked");
    expect(await pc.signsIn(pc.tablet)).toBeNull();
    expect(pc.list.status().devices).toBe(2);
    expect(pc.services.devices.isTombstoned(pc.tablet.signIn.key)).toBe(false);
    // the phone, which handed over, is the list's alone
    expect(await pc.signsIn(pc.phone, "member")).toBe("drive");
    // local, and undone by the same word: the service names it again (as Step 2 lets a key in again after a wait)
    const registry = (pc.service as unknown as { registry(account: string): { devices: Map<string, { removed: boolean }>; version: number } }).registry(ACCOUNT);
    registry.devices.get(pc.tablet.signIn.key)!.removed = false;
    registry.version += 1;
    await pc.pull();
    pc.time.advance(JOIN_HOLD_MS + 1_000);
    expect(await pc.signsIn(pc.tablet)).toBe("drive");
  });
});

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
import { bounded, relayAccountFixture, relayConnection, TestClock } from "../relay/test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT_LIST_OWED_FILE } from "./list-follow.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { asSignIn, birthPlan, migratingDevice, MigratedList, type MigratingPhone } from "./migrate.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

const DAY_MS = 86_400_000;

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
  /** Time passes with the PC running: both of its clocks move, and its record takes the stretch. */
  const run = (ms: number) => { time.advance(ms); witness.step(); };
  run(DAY_MS + 60_000);
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

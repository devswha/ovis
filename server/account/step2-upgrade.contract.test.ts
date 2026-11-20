import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { DEVICE_COOKIE } from "../auth.ts";
import { relayIdentityPath, rotateRelayIdentity } from "../relay/identity.ts";
import { mergeSiblingState } from "../state-merge.ts";
import { relayConnection, relayFixture } from "../relay/test-helpers.ts";
import { legacyOrigin } from "./admission-order.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { ask, memberRow, phone } from "./pairing.test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";

const ACTIVATION_FILE = "account-activation.json";
const DAY = 24 * 60 * 60_000;
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

async function upgrade(options: { bound?: boolean; created?: number; established?: boolean } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-upgrade-"));
  closes.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const member = await memberRow(ACCOUNT);
  const token = `pre-upgrade-${member.row.id}`;
  const created_at = new Date(options.created ?? Date.now()).toISOString();
  const { account, ...unbound } = member.row;
  const row = { ...(options.bound === false ? unbound : { ...unbound, account }), created_at,
    token_hash: createHash("sha256").update(token).digest("hex"),
    ...(options.established ? { origin: legacyOrigin(created_at) } : {}) };
  writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ gate_closed_at: created_at, devices: [row] }), { mode: 0o600 });
  if (options.established) PcAccountState.open(stateDir).migrate(account, true);
  const service = new FakeAccountService();
  service.opensAll = true;
  const identity = rotateRelayIdentity(stateDir);
  const serverId = await registerSnapshotPc(service, { stateDir }, identity);
  const device = { id: row.id, keys: member.key.keys, publicKey: member.key.spki };
  return { stateDir, row, device, service, token, start(fetch = service.fetch, options?: Parameters<typeof relayFixture>[1]) {
    const fixture = relayFixture(false, { stateDir, accountOpensAll: true, token: "owner-only",
      accountService: { url: "https://account.test", fetch }, ...options });
    closes.push(() => {
      for (const close of fixture.closes.splice(0)) close();
      fixture.app.stop();
    });
    return { fixture, serverId, ...fixture.app.context.services };
  } };
}

const offline = async () => { throw new TypeError("offline"); };

test.each(["offline", "a service outage"] as const)("a first activation during %s keeps the old cookie and relay working", async failure => {
  const pc = await upgrade();
  const { fixture, serverId, accountMailbox } = pc.start(async request => {
    if (failure === "offline") throw new TypeError("offline");
    return new URL(request instanceof Request ? request.url : request).pathname === "/v1/pc/snapshot"
      ? new Response(null, { status: 503 }) : await pc.service.fetch(request);
  });
  await accountMailbox.pull();
  const response = await globalThis.fetch(`http://127.0.0.1:${fixture.app.port}/api/devices`, {
    headers: { cookie: `${DEVICE_COOKIE}=${pc.token}`, "x-forwarded-for": "100.64.0.9" },
  });
  expect(response.status).toBe(200);
  const link = await relayConnection(fixture, { serverId });
  await link.auth(pc.device);
  expect((await ask(link, "/api/devices")).status).toBe(200);
});

test.each(["damaged", "missing"] as const)("a %s activation file after first startup keeps the boot wait", async how => {
  const pc = await upgrade();
  const first = pc.start();
  const before = first.devices.match(pc.token);
  first.fixture.app.stop();
  const path = join(pc.stateDir, ACTIVATION_FILE);
  if (how === "damaged") writeFileSync(path, "{not JSON", { mode: 0o600 });
  else rmSync(path, { force: true });

  const reopened = pc.start();

  expect([before?.id ?? null, reopened.devices.match(pc.token)]).toEqual([pc.device.id, null]);
  expect(reopened.devices.catchingUp(pc.device.id)).toBe(true);
});

test("a PC already running Step 2 keeps the boot wait; a genuine first activation does not", async () => {
  const existing = await upgrade({ established: true });
  const fresh = await upgrade();

  expect([existing.start().devices.match(existing.token), fresh.start().devices.match(fresh.token)?.id]).toEqual([null, fresh.device.id]);
});

test("a reconciled snapshot ends first activation for good, even across restart", async () => {
  const pc = await upgrade();
  const first = pc.start();
  const before = first.devices.match(pc.token);
  first.fixture.app.stop();
  const pending = pc.start();
  const recoveredBeforeRead = pending.devices.match(pc.token);
  expect(await pending.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(pending.devices.match(pc.token)?.id).toBe(pc.device.id);
  pending.fixture.app.stop();

  const after = pc.start();

  expect([before?.id, recoveredBeforeRead?.id, after.devices.match(pc.token)]).toEqual([pc.device.id, pc.device.id, null]);
});

test.each([false, true])("a future legacy timestamp keeps credential access on a bound=%s PC, not Step 2 grants", async bound => {
  const pc = await upgrade({ bound, created: Date.now() + 2 * DAY });
  const { devices, fixture, serverId } = pc.start();
  expect(devices.failsClosed).toBe(false);
  expect(devices.admits(pc.device.publicKey)).toBe(false);
  expect(devices.match(pc.token)?.id).toBe(pc.device.id);
  const response = await fetch(`http://127.0.0.1:${fixture.app.port}/api/devices`, {
    headers: { cookie: `${DEVICE_COOKIE}=${pc.token}`, "x-forwarded-for": "100.64.0.9" },
  });
  expect(response.status).toBe(200);
  const link = await relayConnection(fixture, { serverId });
  await link.auth(pc.device);
  expect((await ask(link, "/api/devices")).status).toBe(200);
});

test("a future legacy timestamp cannot infer a re-pair over a subsequent local Revoke", async () => {
  const now = Date.now();
  const pc = await upgrade({ created: now + 2 * DAY });
  writeFileSync(join(pc.stateDir, "account-tombstones.json"), JSON.stringify({ v: 1, tombstones: [{
    key: pc.device.publicKey, account: ACCOUNT, record_id: "local", removed_at: new Date(now).toISOString(),
  }] }), { mode: 0o600 });

  const first = pc.start();
  expect(first.devices.match(pc.token)).toBeNull();
  first.fixture.app.stop();
  const wall = spyOn(Date, "now").mockReturnValue(now + 3 * DAY);
  closes.push(() => wall.mockRestore());
  const { devices } = pc.start();

  expect(devices.isTombstoned(pc.device.publicKey)).toBe(true);
  expect(devices.match(pc.token)).toBeNull();
});

test("a clock-ahead legacy row cannot say It's me after the clock catches up without a restamp", async () => {
  const now = Date.now();
  const pc = await upgrade({ created: now - 2 * DAY });
  const pending = await phone();
  const first = pc.start();
  pc.service.registerDevice(ACCOUNT, pending.spki, "New phone");
  expect(await first.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const originalNotice = first.devices.openNotices().find(entry => entry.key === pending.spki);
  if (!originalNotice?.row) throw new Error("Expected an open admission notice for the new phone");
  await first.fixture.app.stop();

  // Reopen with the legacy timestamp already quarantined by a previous start.
  const created_at = new Date(now + 2 * DAY).toISOString();
  writeFileSync(join(pc.stateDir, "devices.json"), JSON.stringify({ gate_closed_at: pc.row.created_at, devices: [{
    ...pc.row, created_at, origin: legacyOrigin(created_at), untrusted_created_at: created_at,
  }] }), { mode: 0o600 });
  const wall = spyOn(Date, "now").mockReturnValue(now + 3 * DAY);
  closes.push(() => wall.mockRestore());
  const { devices } = pc.start(offline);
  expect(devices.openNotices().some(entry => entry.id === originalNotice.id)).toBe(true);
  expect(devices.itsMe(pc.device.id, originalNotice.id, pc.device.publicKey)).toBe(false);
  expect(devices.openNotices().some(entry => entry.id === originalNotice.id)).toBe(true);
  expect(devices.failsClosed).toBe(false);
});

test("a real Step-1 sibling merge does not cost the PC its own offline legacy cookie", async () => {
  const local = await upgrade();
  const sibling = await upgrade();
  const importedToken = "sibling-cookie";
  writeFileSync(join(sibling.stateDir, "devices.json"), JSON.stringify({ gate_closed_at: sibling.row.created_at, devices: [{
    ...sibling.row, token_hash: createHash("sha256").update(importedToken).digest("hex"),
  }] }), { mode: 0o600 });
  mergeSiblingState(local.stateDir, sibling.stateDir);

  const { devices } = local.start(async () => { throw new TypeError("offline"); });

  expect(devices.list(null).some(row => row.id === sibling.device.id)).toBe(true);
  expect([devices.match(local.token)?.id, devices.match(importedToken)]).toEqual([local.device.id, null]);
});

test("first offline activation keeps the local cookie when only the Step 1 sibling held the account", async () => {
  const local = await upgrade({ bound: false });
  const sibling = await upgrade();
  rmSync(relayIdentityPath(sibling.stateDir));
  const before = local.start(offline, { accountOpensAll: false });
  expect(before.devices.match(local.token)?.id).toBe(local.device.id);
  await before.fixture.app.stop();

  const { devices } = local.start(offline, { siblingStateDir: sibling.stateDir });

  expect(devices.account()).toBe(ACCOUNT);
  expect(devices.list(null).some(row => row.id === sibling.device.id)).toBe(true);
  expect(devices.match(local.token)?.id).toBe(local.device.id);
});

test("a future timestamp from an imported Step 1 row does not shut out a normal local phone", async () => {
  const local = await upgrade();
  const sibling = await upgrade({ created: Date.now() + 2 * DAY });
  const before = local.start(offline, { accountOpensAll: false, siblingStateDir: sibling.stateDir });
  expect(before.devices.match(local.token)?.id).toBe(local.device.id);
  expect(before.devices.list(null).some(row => row.id === sibling.device.id)).toBe(true);
  await before.fixture.app.stop();

  const { devices } = local.start(offline);

  expect(devices.failsClosed).toBe(false);
  expect(devices.accountError).toBeNull();
  expect(devices.match(local.token)?.id).toBe(local.device.id);
  expect(devices.sessionRow(sibling.device.id)).toBeNull();
});

test("identity reset followed by an unbound restart cannot carry first activation into a new binding", async () => {
  const pc = await upgrade();
  const step1 = pc.start(offline, { accountOpensAll: false });
  const browser = step1.devices.pair(step1.devices.startPairing().code, "Local browser", "drive");
  if (!browser) throw new Error("Expected a local browser paired in Step 1");
  await step1.fixture.app.stop();
  const first = pc.start(offline);
  const oldBinding = PcAccountState.open(pc.stateDir).binding()?.bind_id;
  expect(first.devices.match(browser.token)?.id).toBe(browser.device.id);
  await first.relay.resetIdentity();
  await first.fixture.app.stop();
  const unbound = pc.start(offline);
  expect(unbound.devices.account()).toBeNull();
  expect(unbound.devices.match(browser.token)?.id).toBe(browser.device.id);
  const next = await phone();
  const state = PcAccountState.open(pc.stateDir);

  state.bind(ACCOUNT, next.spki).commit();

  expect(state.binding()?.bind_id).not.toBe(oldBinding);
  expect(unbound.devices.catchingUp(browser.device.id)).toBe(true);
  expect(unbound.devices.match(browser.token)).toBeNull();
});

test("a later account binding does not inherit an unbound PC's first activation", async () => {
  const pc = await upgrade({ bound: false });
  const first = pc.start();
  expect(first.devices.match(pc.token)?.id).toBe(pc.device.id);
  first.fixture.app.stop();
  PcAccountState.open(pc.stateDir).bind(ACCOUNT, pc.device.publicKey).commit();

  const { devices } = pc.start(async () => { throw new TypeError("offline"); });

  expect(devices.catchingUp(pc.device.id)).toBe(true);
  expect(devices.match(pc.token)).toBeNull();
});

test.each(["single", "all"] as const)("a clock-only fault permits the owner's local %s Revoke", async kind => {
  const pc = await upgrade({ created: Date.now() + 2 * DAY });
  const { devices, fixture } = pc.start();
  const base = `http://127.0.0.1:${fixture.app.port}`;
  const path = `/api/devices/${kind === "all" ? "revoke-all" : pc.device.id}`;
  const method = kind === "all" ? "POST" : "DELETE";
  const guard = { origin: base, "x-herdr-machine": "1" };
  const revoke = (headers: HeadersInit) => fetch(base + path, { method, headers });
  expect(devices.match(pc.token)?.id).toBe(pc.device.id);

  const local = await revoke({ ...guard, authorization: "Bearer owner-only" });

  expect(local.status, local.status >= 400 ? await local.text() : undefined).toBe(kind === "all" ? 200 : 204);
  expect(devices.match(pc.token)).toBeNull();
  expect(devices.failsClosed).toBe(false);
  await fixture.app.stop();
  expect(pc.start().devices.match(pc.token)).toBeNull();
});

test("a clock-ahead cookie does not authorize remote removal of its own device", async () => {
  const pc = await upgrade({ created: Date.now() + 2 * DAY });
  const { devices, fixture } = pc.start();
  const base = `http://127.0.0.1:${fixture.app.port}`;

  const response = await fetch(`${base}/api/devices/${pc.device.id}`, { method: "DELETE", headers: {
    origin: base, "x-herdr-machine": "1", "x-forwarded-for": "100.64.0.9", cookie: `${DEVICE_COOKIE}=${pc.token}`,
  } });

  expect(response.status).toBe(403);
  expect(devices.match(pc.token)?.id).toBe(pc.device.id);
});

test("the owner's clock-fault Revoke keeps the key tombstoned after rolling back to Step 1", async () => {
  const pc = await upgrade({ created: Date.now() + 2 * DAY });
  const { devices, fixture } = pc.start(offline);
  const base = `http://127.0.0.1:${fixture.app.port}`;
  expect(devices.match(pc.token)?.id).toBe(pc.device.id);
  expect(devices.clockOnlyFault()).toBe(true);
  const revoke = await fetch(`${base}/api/devices/${pc.device.id}`, { method: "DELETE", headers: {
    origin: base, "x-herdr-machine": "1", authorization: "Bearer owner-only",
  } });
  expect(revoke.status).toBe(204);
  await fixture.app.stop();

  const rollback = pc.start(offline, { accountOpensAll: false });

  expect(rollback.devices.isTombstoned(pc.device.publicKey)).toBe(true);
  expect(rollback.devices.match(pc.token)).toBeNull();
});

test("install opt-out still lets a local code pair after a Step 2 legacy clock fault", async () => {
  const pc = await upgrade({ created: Date.now() + 2 * DAY });
  const first = pc.start(offline);
  expect(first.devices.clockOnlyFault()).toBe(true);
  await first.fixture.app.stop();
  const prior = process.env["OVIS_ACCOUNT_OPENS_ALL"];
  process.env["OVIS_ACCOUNT_OPENS_ALL"] = "0";
  try {
    const { devices } = pc.start(offline, { accountOpensAll: undefined });
    expect(devices.opensAll()).toBe(false);
    expect(devices.match(pc.token)?.id).toBe(pc.device.id);

    const paired = devices.pair(devices.startPairing().code, "Second local phone", "drive");

    expect(paired?.device.label).toBe("Second local phone");
    expect(paired && devices.match(paired.token)?.id).toBe(paired?.device.id);
  } finally {
    if (prior === undefined) delete process.env["OVIS_ACCOUNT_OPENS_ALL"];
    else process.env["OVIS_ACCOUNT_OPENS_ALL"] = prior;
  }
});

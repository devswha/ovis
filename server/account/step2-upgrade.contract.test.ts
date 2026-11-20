import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { DEVICE_COOKIE } from "../auth.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
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
  const token = "pre-upgrade-cookie";
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
  return { stateDir, row, device, service, token, start(fetch = service.fetch) {
    const fixture = relayFixture(false, { stateDir, accountOpensAll: true, token: "owner-only",
      accountService: { url: "https://account.test", fetch } });
    closes.push(() => {
      for (const close of fixture.closes.splice(0)) close();
      fixture.app.stop();
    });
    return { fixture, serverId, ...fixture.app.context.services };
  } };
}

test.each(["offline", "a service outage"] as const)("a first activation during %s keeps the old cookie and relay working", async failure => {
  const pc = await upgrade();
  const { fixture, serverId, accountMailbox } = pc.start(async request => {
    if (failure === "offline") throw new TypeError("offline");
    return new URL(request.url).pathname === "/v1/pc/snapshot"
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
  expect(devices.failsClosed).toBe(true);
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
  const pc = await upgrade({ created: now + 2 * DAY });
  const pending = await phone();
  const first = pc.start();
  first.fixture.app.stop();
  const wall = spyOn(Date, "now").mockReturnValue(now + 3 * DAY);
  closes.push(() => wall.mockRestore());
  const { devices, accountMailbox } = pc.start();
  pc.service.registerDevice(ACCOUNT, pending.spki, "New phone");

  await accountMailbox.readSnapshot();

  const notice = devices.openNotices().find(entry => entry.key === pending.spki);
  expect(notice !== undefined && devices.itsMe(pc.device.id, notice.id, pc.device.publicKey)).toBe(false);
  expect(devices.failsClosed).toBe(true);
});

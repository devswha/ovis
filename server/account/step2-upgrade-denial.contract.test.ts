import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDeviceId, newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { parseSnapshotPage } from "../../shared/account-snapshot.ts";
import { createServer } from "../index.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { relayConnection, TestClock } from "../relay/test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { ask, phone } from "./pairing.test-helpers.ts";
import { credentialStatus, hasReleaseFixtures, v057Fixture } from "./step2-upgrade-v057.test-helpers.ts";

const root = mkdtempSync(join(tmpdir(), "upgrade-denial-"));
const available = hasReleaseFixtures();
let release: Awaited<ReturnType<typeof v057Fixture>>;
beforeAll(async () => { if (available) release = await v057Fixture(join(root, "release")); }, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const day = 86_400_000;

async function fixture(history: "original" | "rollback", signer: "legacy" | "listed" = "legacy") {
  const stateDir = mkdtempSync(join(root, "pc-"));
  const service = new FakeAccountService();
  service.opensAll = true;
  const serverId = await registerSnapshotPc(service, { stateDir }, rotateRelayIdentity(stateDir));
  const owner = await phone();
  const victim = await phone();
  const member = signer === "legacy" ? owner : await phone();
  service.registerDevice(ACCOUNT, owner.spki, "Older signer");
  service.registerDevice(ACCOUNT, victim.spki, "Legacy target");
  const now = Date.now();
  let online = false;
  let omitKey: string | undefined;
  const start = () => createServer({
    stateDir, port: 0, hostname: "127.0.0.1", token: "matrix-owner", tailscaleOwner: null, sidecar: false,
    accountOpensAll: true, accountService: { url: "https://account.test", fetch: async request => {
      if (!online) return Promise.reject(new TypeError("fixture offline"));
      const response = await service.fetch(request);
      if (omitKey && new URL(request.url).pathname === "/v1/pc/snapshot" && response.ok) {
        const page = parseSnapshotPage(await response.json());
        return Response.json({ ...page, devices: page.devices.filter(row => row.key !== omitKey) });
      }
      return response;
    } },
  });
  const initial = release(stateDir);
  let cookie: string;
  try {
    const { devices } = initial.context.services;
    const paired = devices.pairRelay(devices.startPairing(now - 3_000).code, "Local member", member.spki, now - 3_000);
    if (!paired || !devices.linkAccountKey(paired.device.id, member.spki, member.spki, ACCOUNT)) throw new Error("Release pairing failed");
    const browser = devices.pair(devices.startPairing(now - 1_000).code, "Unrelated browser", "drive", now - 1_000);
    if (!browser) throw new Error("Release browser pairing failed");
    cookie = browser.token;
    expect(await credentialStatus(initial.port, cookie)).toBe(200);
  } finally { await initial.stop(); }
  if (history === "rollback") await start().stop();
  const old = release(stateDir);
  let targetId: string;
  const closes: (() => void)[] = [];
  try {
    const { devices } = old.context.services;
    const ahead = now + 2 * day;
    const paired = devices.pairRelay(devices.startPairing(ahead).code, "Legacy target", victim.spki, ahead);
    if (!paired || !devices.linkAccountKey(paired.device.id, victim.spki, victim.spki, ACCOUNT)) throw new Error("Release target pairing failed");
    targetId = paired.device.id;
    const link = await relayConnection({ stateDir, app: old, closes, close: () => {} }, { serverId }, release.RelaySession);
    await link.auth({ id: targetId, keys: victim.keys, publicKey: victim.spki });
    expect((await ask(link, "/api/devices")).status).toBe(200);
    expect(await credentialStatus(old.port, cookie)).toBe(200);
  } finally {
    for (const close of closes) close();
    await old.stop();
  }
  const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, signer: owner.spki, signer_no: 1,
    target: victim.spki, target_no: 2, nonce: newRecordId(), signed_at: new Date(now).toISOString() }, owner.keys.privateKey);
  return { stateDir, service, serverId, owner, victim, targetId, cookie, record, start,
    omit: (key: string) => { omitKey = key; },
    connect: () => { online = true; }, disconnect: () => { online = false; } };
}

test.skipIf(!available).each([
  ["original", "none"], ["rollback", "none"], ["original", "present"], ["rollback", "present"],
] as const)(
  "service-produced target-only block: history=%s independent-freeze=%s", async (history, freeze) => {
    const independent = freeze === "present";
    const pc = await fixture(history);
    const app = pc.start();
    try {
      expect(await credentialStatus(app.port, pc.cookie)).toBe(200);
      if (independent) {
        const other = await phone();
        const no = pc.service.registerDevice(ACCOUNT, other.spki, "Independent blocked key");
        const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, signer: pc.owner.spki, signer_no: 1,
          target: other.spki, target_no: no, nonce: newRecordId(), signed_at: new Date().toISOString() }, pc.owner.keys.privateKey);
        expect((await pc.service.fetch(new Request("https://account.test/v1/safety-records", {
          method: "POST", headers: { authorization: `Bearer ${pc.service.issueToken(ACCOUNT)}` },
          body: JSON.stringify({ record }),
        }))).status).toBe(200);
      }
      const response = await pc.service.fetch(new Request("https://account.test/v1/safety-records", {
        method: "POST", headers: { authorization: `Bearer ${pc.service.issueToken(ACCOUNT)}` },
        body: JSON.stringify({ record: pc.record }),
      }));
      expect(response.status).toBe(200);
      pc.connect();
      expect(await app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      expect({
        targetDenied: app.context.services.devices.isTombstoned(pc.victim.spki),
        survivor: await credentialStatus(app.port, pc.cookie),
      }).toEqual({ targetDenied: true, survivor: independent ? 401 : 200 });
      expect(app.context.services.devices.sessionRow(pc.targetId)).toBeNull();
    } finally { await app.stop(); }
    pc.disconnect();
    const restarted = pc.start();
    try {
      expect(await credentialStatus(restarted.port, pc.cookie)).toBe(independent ? 401 : 200);
      expect(restarted.context.services.devices.isTombstoned(pc.victim.spki)).toBe(true);
      expect(restarted.context.services.devices.sessionRow(pc.targetId)).toBeNull();
    } finally { await restarted.stop(); }
  }, 15_000,
);

async function rebind(pc: Awaited<ReturnType<typeof fixture>>, app: ReturnType<typeof createServer>, omitted: string) {
  expect(app.context.services.devices.clearAccountBinding("left_on_pc", "pc")).toBe(true);
  pc.omit(omitted);
  const base = `http://127.0.0.1:${app.port}`;
  const post = (path: string, body: object) => fetch(base + path, { method: "POST",
    headers: { origin: base, authorization: "Bearer matrix-owner", "x-herdr-machine": "1" }, body: JSON.stringify(body) });
  expect((await post("/api/account/relay-account", { account: ACCOUNT })).status).toBe(204);
  expect((await pc.service.fetch(new Request(`https://account.test/v1/pcs/${pc.serverId}/admit`, {
    method: "POST", headers: { authorization: `Bearer ${pc.service.issueToken(ACCOUNT, { twoStep: true })}` }, body: "{}",
  }))).status).toBe(200);
  expect((await post("/api/account/one-press", { account: ACCOUNT })).status).toBe(200);
}

test.skipIf(!available).each(["signer", "target"] as const)(
  "a previous binding's %s pin cannot authorize a target-only block", async missing => {
    const pc = await fixture("original");
    const app = pc.start();
    try {
      pc.connect();
      const { devices, accountMailbox } = app.context.services;
      expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      await rebind(pc, app, missing === "signer" ? pc.owner.spki : pc.victim.spki);
      expect(await devices.applyBlock(pc.record, "mailbox")).toMatchObject({ outcome: "refused", reason: "unknown_target" });
      expect(devices.isTombstoned(pc.victim.spki)).toBe(false);
      expect(app.context.services.safetyLog?.waitingBlocks().map(entry => entry.record.id)).toContain(pc.record.id);
    } finally { await app.stop(); }
  }, 15_000,
);

test.skipIf(!available).each(["proof-present", "proof-later"] as const)(
  "rollback target gets an exact-key denial without acquiring authority: %s", async proof => {
    const pc = await fixture("rollback");
    const app = pc.start();
    try {
      const { devices, accountMailbox, safetyLog } = app.context.services;
      expect(devices.sessionRow(pc.targetId)?.key).toBe(pc.victim.spki);
      expect(devices.isAccountApproverSession(pc.targetId, pc.victim.spki)).toBe(false);
      if (proof === "proof-present") {
        pc.connect();
        expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      }
      const receipt = await devices.applyBlock(pc.record, "mailbox");
      if (proof === "proof-later") {
        expect(receipt).toMatchObject({ outcome: "refused", reason: "unknown_target" });
        expect(safetyLog?.waitingBlocks().map(entry => entry.record.id)).toContain(pc.record.id);
        const shown = await fetch(`http://127.0.0.1:${app.port}/api/devices`, { headers: { authorization: "Bearer matrix-owner" } });
        const { devices: rows } = await shown.json() as { devices: { id: string; not_me_waiting?: true }[] };
        expect(rows.filter(row => row.not_me_waiting).map(row => row.id)).toEqual([pc.targetId]);
        pc.connect();
        expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      }
      expect(safetyLog?.receipt(pc.record.id)?.outcome).toBe("applied");
      expect(devices.isTombstoned(pc.victim.spki)).toBe(true);
      expect(devices.sessionRow(pc.targetId)).toBeNull();
      expect(await credentialStatus(app.port, pc.cookie)).toBe(200);
    } finally { await app.stop(); }
  }, 15_000,
);

test.skipIf(!available).each(["hold", "expired", "service-off", "live"] as const)(
  "target-only denial checks the list signer's owning store: %s", async standing => {
    const pc = await fixture("original", "listed");
    const app = pc.start();
    const clock = new TestClock();
    const epoch = Date.now();
    const wall = spyOn(Date, "now").mockImplementation(() => epoch + clock.now());
    try {
      const { devices, accountMailbox } = app.context.services;
      devices.useClock(clock);
      pc.connect();
      expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      if (standing !== "hold") clock.advance(JOIN_HOLD_MS + 1);
      if (standing === "expired") {
        clock.advance(61 * day);
        expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      }
      if (standing === "service-off") {
        pc.service.opensAll = false;
        pc.service.reportsStep2Off = true;
        await accountMailbox.readSnapshot();
      }
      // Do not call sessionRow on the signer first: access must inspect expiry itself.
      const receipt = await devices.applyBlock(pc.record, "mailbox");
      expect(receipt.outcome).toBe(standing === "live" ? "applied" : "refused");
      expect(devices.isTombstoned(pc.victim.spki)).toBe(standing === "live");
      expect(devices.sessionRow(accountDeviceId(pc.serverId, pc.owner.spki))?.key ?? null)
        .toBe(standing === "live" ? pc.owner.spki : null);
      expect(await credentialStatus(app.port, pc.cookie)).toBe(200);
    } finally {
      wall.mockRestore();
      await app.stop();
    }
  }, 15_000,
);

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDeviceId } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { createServer } from "../index.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { relayConnection } from "../relay/test-helpers.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { ask, phone } from "./pairing.test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";
import { credentialStatus, v057Fixture } from "./step2-upgrade-v057.test-helpers.ts";

const boots = ["online", "offline-first", "offline-second"] as const;
const folders = ["one", "two"] as const;
const clocks = ["normal", "ahead", "revoked-ahead-corrected"] as const;
const histories = ["none", "saved-step2-off", "rollback-pair"] as const;
const cells = boots.flatMap(boot => folders.flatMap(folder => clocks.flatMap(clock => histories.map(history =>
  [boot, folder, clock, history] as const))));
const day = 86_400_000;
const root = mkdtempSync(join(tmpdir(), "ovis-upgrade-matrix-"));
let startRelease: Awaited<ReturnType<typeof v057Fixture>>;
beforeAll(async () => { startRelease = await v057Fixture(join(root, "release")); }, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function localPhone(app: ReturnType<typeof createServer>, label: string, now: number) {
  const { devices } = app.context.services;
  const paired = devices.pair(devices.startPairing(now).code, label, "drive", now);
  if (!paired) throw new Error(`v0.5.7 could not pair ${label}`);
  return paired.token;
}

test.each(cells)("boot=%s folders=%s clock=%s history=%s", async (boot, folder, clock, history) => {
  const stateDir = mkdtempSync(join(root, "cell-"));
  const active = join(stateDir, "active");
  const other = join(stateDir, "sibling");
  mkdirSync(active);
  if (folder === "two") mkdirSync(other);
  const service = new FakeAccountService();
  const identity = rotateRelayIdentity(active);
  const serverId = await registerSnapshotPc(service, { stateDir: active }, identity);
  const trusted = await phone();
  const revoked = await phone();
  const newcomer = await phone();
  service.registerDevice(ACCOUNT, trusted.spki, "Existing relay phone");
  const now = Date.now();
  const ahead = now + 2 * day;
  const cookies: Record<string, string> = {};
  let relayId: string;
  let revokedId: string | undefined;
  const old = startRelease(active);
  try {
    const { devices } = old.context.services;
    const paired = devices.pairRelay(devices.startPairing(now).code, "Existing relay phone", trusted.spki, now);
    if (!paired || !devices.linkAccountKey(paired.device.id, trusted.spki, trusted.spki, ACCOUNT)) throw new Error("v0.5.7 account link failed");
    relayId = paired.device.id;
    expect(devices.sessionRow(relayId)?.key).toBe(trusted.spki);
    cookies.original = localPhone(old, "Existing browser phone", clock === "ahead" ? ahead : now);
    if (clock === "revoked-ahead-corrected") {
      const gone = devices.pairRelay(devices.startPairing(now).code, "Owner revoked", revoked.spki, now);
      if (!gone) throw new Error("v0.5.7 could not pair the second relay phone");
      revokedId = gone.device.id;
      expect(devices.sessionRow(revokedId)?.key).toBe(revoked.spki);
      const wall = spyOn(Date, "now").mockReturnValue(ahead);
      try {
        const base = `http://127.0.0.1:${old.port}`;
        const response = await fetch(`${base}/api/devices/${revokedId}`, { method: "DELETE", headers: {
          origin: base, "x-herdr-machine": "1", authorization: "Bearer matrix-owner",
        } });
        expect(response.status).toBe(204);
      } finally { wall.mockRestore(); }
      expect(devices.isTombstoned(revoked.spki)).toBe(true);
    }
    expect(await credentialStatus(old.port, cookies.original)).toBe(200);
  } finally { await old.stop(); }

  const start = (online: boolean) => createServer({
    port: 0, hostname: "127.0.0.1", stateDir: active, token: "matrix-owner", sidecar: false,
    tailscaleOwner: null, accountOpensAll: true, ...(folder === "two" ? { siblingStateDir: other } : {}),
    accountService: { url: "https://account.test", fetch: async request => {
      if (!online) throw new TypeError("matrix PC offline");
      return await service.fetch(request);
    } },
  });

  if (history === "saved-step2-off") {
    service.opensAll = true;
    const optedOut = start(true);
    try {
      if (clock === "normal") expect(await optedOut.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      service.opensAll = false;
      service.reportsStep2Off = true;
      await optedOut.context.services.accountMailbox.readSnapshot();
    } finally { await optedOut.stop(); }
    expect(PcAccountState.open(active).serviceStep2Off()).toBe(true);
  } else if (history === "rollback-pair") {
    const activating = start(false);
    await activating.stop();
    const rollback = startRelease(active);
    try {
      cookies.rollback = localPhone(rollback, "Phone paired during rollback", now + 1);
      for (const token of Object.values(cookies)) expect(await credentialStatus(rollback.port, token)).toBe(200);
    } finally { await rollback.stop(); }
  }

  if (boot === "offline-second") {
    const first = start(false);
    await first.stop();
  }
  if (boot !== "online" || history === "saved-step2-off" || clock !== "normal") {
    service.registerDevice(ACCOUNT, newcomer.spki, "Eligible but not admitted on this PC");
  }
  service.opensAll = history !== "saved-step2-off";
  const upgraded = start(boot === "online");
  const closes: (() => void)[] = [];
  try {
    const { accountMailbox, devices } = upgraded.context.services;
    if (boot === "online") await accountMailbox.readSnapshot();
    const credentials = Object.fromEntries(await Promise.all(Object.entries(cookies).map(async ([label, token]) =>
      [label, await credentialStatus(upgraded.port, token)])));
    let relayStatus: number | null = null;
    if (devices.sessionRow(relayId)?.key === trusted.spki) {
      const link = await relayConnection({ stateDir: active, app: upgraded, closes, close: () => {} }, { serverId });
      await link.auth({ id: relayId, keys: trusted.keys, publicKey: trusted.spki });
      relayStatus = (await ask(link, "/api/devices")).status;
    }
    // A listed candidate cannot use the legacy exception, and an unpaired cookie never opens the gate.
    expect({
      credentials, relayStatus,
      unknownCookie: await credentialStatus(upgraded.port, "never-paired"),
      newAccountSession: devices.sessionRow(accountDeviceId(serverId, newcomer.spki)),
      revokedSession: revokedId === undefined ? null : devices.sessionRow(revokedId),
      tombstone: revokedId === undefined || devices.isTombstoned(revoked.spki),
    }, devices.accountError ?? undefined).toEqual({
      credentials: Object.fromEntries(Object.keys(cookies).map(label => [label, 200])),
      relayStatus: 200, unknownCookie: 401, newAccountSession: null,
      revokedSession: null, tombstone: true,
    });
  } finally {
    for (const close of closes) close();
    await upgraded.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 20_000);

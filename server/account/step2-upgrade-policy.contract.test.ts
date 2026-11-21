import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDeviceId, newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { createServer } from "../index.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, relayConnection } from "../relay/test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { ask, phone } from "./pairing.test-helpers.ts";
import { credentialStatus, hasReleaseFixtures, v057Fixture } from "./step2-upgrade-v057.test-helpers.ts";

const root = mkdtempSync(join(tmpdir(), "upgrade-policy-"));
const available = hasReleaseFixtures();
let release: Awaited<ReturnType<typeof v057Fixture>>;
beforeAll(async () => { if (available) release = await v057Fixture(join(root, "release")); }, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(!available).each(["lock", "local-block", "service-freeze", "held-key"] as const)(
  "release standing policy survives upgrade, ending, and offline restart: %s", async policy => {
    const stateDir = mkdtempSync(join(root, "pc-"));
    const service = new FakeAccountService();
    service.opensAll = true;
    const serverId = await registerSnapshotPc(service, { stateDir }, rotateRelayIdentity(stateDir));
    const owner = await phone();
    const target = await phone();
    const listed = await phone();
    service.registerDevice(ACCOUNT, owner.spki, "Owner");
    service.registerDevice(ACCOUNT, target.spki, "Target");
    service.registerDevice(ACCOUNT, listed.spki, "Listed phone");
    const epoch = Date.now();
    let time = epoch;
    const wall = spyOn(Date, "now").mockImplementation(() => time);
    let online = true;
    const accountService = { url: "https://account.test", fetch: (request: Request) =>
      online ? service.fetch(request) : Promise.reject(new TypeError("fixture offline")) };
    const old = release(stateDir);
    let cookie: string;
    let olderCookie: string;
    let targetId: string;
    try {
      const { devices } = old.context.services;
      const member = devices.pairRelay(devices.startPairing(epoch - 3_000).code, "Owner", owner.spki, epoch - 3_000);
      if (!member || !devices.linkAccountKey(member.device.id, owner.spki, owner.spki, ACCOUNT)) throw new Error("Release member failed");
      const older = devices.pair(devices.startPairing(epoch - 4_000).code, "Older browser", "drive", epoch - 4_000);
      if (!older) throw new Error("Release older browser failed");
      olderCookie = older.token;
      const targetRow = devices.pairRelay(devices.startPairing(epoch - 2_000).code, "Target", target.spki, epoch - 2_000);
      if (!targetRow || !devices.linkAccountKey(targetRow.device.id, target.spki, target.spki, ACCOUNT)) throw new Error("Release target failed");
      targetId = targetRow.device.id;
      const paired = devices.pair(devices.startPairing(epoch - 1_000).code, "Newer browser", "drive", epoch - 1_000);
      if (!paired) throw new Error("Release browser failed");
      cookie = paired.token;
      expect(await credentialStatus(old.port, cookie)).toBe(200);
      expect(await credentialStatus(old.port, olderCookie)).toBe(200);
    } finally { await old.stop(); }
    const screen = () => {
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      return { desktopOwner: { input: stream.readable, write: () => {} }, writer };
    };
    const initialScreen = screen();
    const released = release(stateDir, { accountOpensAll: true, accountService, desktopOwner: initialScreen.desktopOwner });
    const post = (app: ReturnType<typeof createServer>, path: string, body: object) => {
      const origin = `http://127.0.0.1:${app.port}`;
      return fetch(origin + path, { method: "POST", headers: {
        origin, "x-herdr-machine": "1", authorization: "Bearer matrix-owner",
      }, body: JSON.stringify(body) });
    };
    const confirm = async (app: ReturnType<typeof createServer>, writer: WritableStreamDefaultWriter<Uint8Array>, response: Response) => {
      expect(response.status).toBe(202);
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("confirm" in body) || typeof body.confirm !== "string") throw new Error("Missing screen confirmation");
      const answer = app.context.services.localConfirms?.answer(body.confirm);
      await writer.write(new TextEncoder().encode(`${JSON.stringify({ approve: body.confirm })}\n`));
      expect(await answer).toBe("approved");
    };
    const block = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, signer: owner.spki, signer_no: 1,
      target: target.spki, target_no: 2, nonce: newRecordId(), signed_at: new Date(epoch).toISOString() }, owner.keys.privateKey);
    const listedId = accountDeviceId(serverId, listed.spki);
    let baseline: number[] = [];
    const compared = policy === "service-freeze" ? 1 : 2;
    let lock: string | undefined;
    try {
      expect(await released.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      switch (policy) {
        case "lock":
          await confirm(released, initialScreen.writer, await post(released, "/api/account/lock", {}));
          lock = released.context.services.safetyLog?.state().locks[0]?.record.id;
          expect(lock).toBeDefined();
          break;
        case "local-block": {
          const response = await post(released, "/api/account/records", { records: [block] });
          expect(response.status).toBe(200);
          expect(released.context.services.devices.isTombstoned(target.spki)).toBe(true);
          break;
        }
        case "service-freeze":
          expect((await service.fetch(new Request("https://account.test/v1/safety-records", {
            method: "POST", headers: { authorization: `Bearer ${service.issueToken(ACCOUNT)}` }, body: JSON.stringify({ record: block }),
          }))).status).toBe(200);
          expect(await released.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
          break;
        case "held-key":
          expect(released.context.services.devices.sessionRow(listedId)).toBeNull();
          break;
      }
      // v0.5.7 opt-in refused every keyless cookie after a snapshot block; head places an older cookie before the cut.
      // That cookie's widening is a hub decision, so the service-freeze oracle compares the cut cookie only.
      baseline = [await credentialStatus(released.port, cookie), await credentialStatus(released.port, olderCookie)].slice(0, compared);
      expect(baseline[0]).toBe(policy === "held-key" ? 200 : 401);
      if (policy === "lock") expect(baseline[1]).toBe(401);
    } finally {
      await released.stop();
      initialScreen.writer.releaseLock();
    }
    const nextScreen = screen();
    const start = () => createServer({ stateDir, port: 0, hostname: "127.0.0.1", token: "matrix-owner",
      tailscaleOwner: null, sidecar: false, accountOpensAll: true, accountService, desktopOwner: nextScreen.desktopOwner });
    online = false;
    const upgraded = start();
    try {
      expect([await credentialStatus(upgraded.port, cookie), await credentialStatus(upgraded.port, olderCookie)].slice(0, compared)).toEqual(baseline);
      if (policy === "held-key") expect(upgraded.context.services.devices.sessionRow(listedId)).toBeNull();
      else if (policy === "lock") await confirm(upgraded, nextScreen.writer, await post(upgraded, "/api/account/unlock", { lock }));
      else {
        const lift = await signSafetyRecord({ v: 1, kind: "lift", account: ACCOUNT, signer: owner.spki, signer_no: 1,
          target: block.id, signed_at: new Date(epoch).toISOString() }, owner.keys.privateKey);
        for (const record of [block, lift]) expect((await service.fetch(new Request("https://account.test/v1/safety-records", {
          method: "POST", headers: { authorization: `Bearer ${service.issueToken(ACCOUNT)}` }, body: JSON.stringify({ record }),
        }))).status).toBe(200);
      }
    } finally {
      await upgraded.stop();
      nextScreen.writer.releaseLock();
    }
    const restarted = createServer({ stateDir, port: 0, hostname: "127.0.0.1", token: "matrix-owner",
      tailscaleOwner: null, sidecar: false, accountOpensAll: true, accountService });
    try {
      const statuses = async () => [await credentialStatus(restarted.port, cookie), await credentialStatus(restarted.port, olderCookie)].slice(0, compared);
      expect(await statuses()).toEqual(baseline);
      online = true;
      expect(await restarted.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      // The legacy member cannot order itself before a legacy-cut row, so its lift leaves that deny standing.
      expect(await statuses()).toEqual(baseline);
      if (policy !== "held-key" && targetId) expect(restarted.context.services.devices.sessionRow(targetId)).toBeNull();
      if (policy === "held-key") {
        expect(restarted.context.services.devices.sessionRow(listedId)).toBeNull();
        time += JOIN_HOLD_MS + 1;
        const closes: (() => void)[] = [];
        try {
          const link = await relayConnection({ stateDir, app: restarted, closes, close: () => {} }, { serverId });
          await bounded(link.auth({ id: listedId, publicKey: listed.spki, keys: listed.keys }));
          expect((await ask(link, "/api/devices")).status).toBe(200);
        } finally { for (const close of closes) close(); }
      }
    } finally {
      await restarted.stop();
      wall.mockRestore();
    }
  }, 20_000,
);

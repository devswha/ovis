import { AccountMailbox } from "./mailbox.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId, exportAccountKey, newRecordId, signAccountRecord, signSafetyRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { FrameType } from "../../shared/relay-mux.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, deferred, relayAccountFixture, relayConnection, relayDevice } from "../relay/test-helpers.ts";
import { ask, phone } from "./pairing.test-helpers.ts";

const ACCOUNT = "acct_1";
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

async function server(accountOpensAll: boolean) {
  const service = new FakeAccountService();
  service.opensAll = true;
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.push(() => fixture.close());
  const { services } = fixture.app.context;
  rotateRelayIdentity(fixture.stateDir);
  const identity = services.relay.currentIdentity();
  if (!identity) throw new Error("the fixture has no relay identity");
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  service.registerDevice(ACCOUNT, await exportAccountKey(pair.publicKey), "Laptop");
  return { service, services, member, identity, token, fixture };
}

describe("S2-24 the server wires the whole read only under the release flag (G1, P24)", () => {
  test("G1: with OVIS_ACCOUNT_OPENS_ALL on, the PC's mailbox reads and commits the account's snapshot", async () => {
    const { service, services } = await server(true);
    expect(services.devices.account()).toBe(ACCOUNT);
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(service.requests.some((request) => request.includes("/v1/pc/snapshot"))).toBe(true);
  });

  test("T15, P6: a mailed signed add waits across failed reads and settle until the whole read commits", async () => {
    const { services, service, identity, token, member } = await server(true);
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const key = await exportAccountKey(pair.publicKey);
    service.registerDevice(ACCOUNT, key, "Tablet");
    const record = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key, signer: member.publicKey, label: "Tablet", role: "drive", issued_at: "2026-11-01T00:00:00.000Z", id: newRecordId() }, member.keys.privateKey);
    expect((await service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ server_ids: [identity.server_id], record }) }))).ok).toBe(true);
    service.opensAll = false;
    await services.accountMailbox.pull();
    await services.accountMailbox.settle();
    expect(services.devices.hasKey(key)).toBe(false);
    service.opensAll = true;
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(services.devices.hasKey(key)).toBe(true);
  });

  for (const delivery of ["mailed while locked", "handed before a read"] as const) {
    test(`T15, P14, P23: ${delivery} add is decided only by the whole read`, async () => {
      const { services, service, identity, token, member, fixture } = await server(true);
      const { spki: key } = await phone();
      const record = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key, signer: member.publicKey,
        label: "Tablet", role: "drive", issued_at: "2026-11-01T00:00:00.000Z", id: newRecordId() }, member.keys.privateKey);
      if (delivery === "mailed while locked") {
        const log = services.safetyLog;
        if (!log) throw new Error("Expected a safety log");
        const lock = log.appendLock({ account: ACCOUNT });
        expect(lock.outcome).toBe("applied");
        expect((await service.fetch(new Request("https://account.test/v1/records", { method: "POST", headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ server_ids: [identity.server_id], record }) }))).ok).toBe(true);
        await services.accountMailbox.pull();
        expect(services.devices.hasKey(key)).toBe(false);
        expect(log.appendUnlock(lock.id, { account: ACCOUNT }).outcome).toBe("applied");
      } else {
        service.opensAll = false;
        const link = await relayConnection(fixture, { serverId: identity.server_id });
        await link.auth(member);
        expect((await ask(link, "/api/account/records", { method: "POST", body: { records: [record] } })).status).toBe(200);
        await services.accountMailbox.settle();
        expect(services.devices.hasKey(key)).toBe(false);
        service.opensAll = true;
      }
      expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      expect(services.devices.hasKey(key)).toBe(delivery === "handed before a read");
    });
  }

  test("T60: the mailbox acknowledges a block only after the PC has its numbered receipt", async () => {
    const { services, service, identity, member, fixture } = await server(true);
    const target = await relayDevice(fixture);
    const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: target.publicKey, target_no: 2,
      signer: member.publicKey, signer_no: 1, signed_at: "2026-11-01T00:00:00.000Z", nonce: newRecordId() }, member.keys.privateKey);
    const acknowledged: unknown[] = [];
    const mailbox = new AccountMailbox({ devices: services.devices, identity: () => identity, service: "https://account.test",
      fetch: async (request) => {
        if (new URL(request.url).pathname !== "/v1/pc/mailbox") return service.fetch(request);
        const { ack } = await request.json();
        if (ack === 1) acknowledged.push(services.safetyLog?.receipt(record.id));
        return Response.json({ records: ack === null ? [{ seq: 1, record }] : [] });
      },
    });
    await mailbox.pull();
    expect(acknowledged).toEqual([{ outcome: "applied", id: record.id, n: 1 }]);
    expect(services.devices.has(target.id)).toBe(false);
  });

  test("T52, P14: a handed lift requests a read but a snapshot without it keeps the freeze", async () => {
    const { services, service, identity, member, fixture } = await server(true);
    const target = await relayDevice(fixture);
    const at = "2026-11-01T00:00:00.000Z";
    const block = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: target.publicKey, target_no: 2,
      signer: member.publicKey, signer_no: 1, signed_at: at, nonce: newRecordId() }, member.keys.privateKey);
    const lift = await signSafetyRecord({ v: 1, kind: "lift", account: ACCOUNT, target: block.id,
      signer: member.publicKey, signer_no: 1, signed_at: at }, member.keys.privateKey);
    expect((await services.devices.applyBlock(block, "handed")).outcome).toBe("applied");
    const link = await relayConnection(fixture, { serverId: identity.server_id });
    await link.auth(member);
    const requests = () => service.requests.filter((path) => path.includes("/v1/pc/snapshot")).length;
    const before = requests();
    const answer = await ask(link, "/api/account/records", { method: "POST", body: { records: [lift] } });
    await services.accountMailbox.settle();
    expect(requests()).toBe(before + 1);
    expect(answer.body.results).toEqual([{ id: lift.id, outcome: "refused", code: "read_pending" }]);
    expect(services.safetyLog?.state().blocks.map(({ record }) => record.id)).toEqual([block.id]);
  });

  test("T60: only a negotiated refusal with the signer's valid proof carries its PC receipts", async () => {
    const { services, service, member, identity, fixture } = await server(true);
    service.registerDevice(ACCOUNT, member.publicKey, "Signer");
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const target = await relayDevice(fixture);
    const block = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: target.publicKey, target_no: 2,
      signer: member.publicKey, signer_no: 1, signed_at: "2026-11-01T00:00:00.000Z", nonce: newRecordId() }, member.keys.privateKey);
    const receipt = await services.devices.applyBlock(block, "handed");
    expect(receipt.outcome).toBe("applied");
    expect(services.devices.revoke(member.id)).toBe(true);
    const id = accountDeviceId(identity.server_id, member.publicKey);
    const refusal = async (keys: CryptoKeyPair, features: readonly string[]) => {
      const link = await relayConnection(fixture, { serverId: identity.server_id });
      const reply = deferred<unknown>();
      link.onFrame = (frame) => { if (frame.type === FrameType.SESSION_ERROR) reply.resolve(frame.payload); };
      void link.auth({ ...member, keys, id }, features).catch(() => {});
      return bounded(reply.promise);
    };
    const plain = { code: "auth_failed", message: "auth_failed" };
    expect(await refusal(member.keys, [])).toEqual(plain);
    expect(await refusal(target.keys, ["account-opens-all-1"])).toEqual(plain);
    expect(await refusal(member.keys, ["account-opens-all-1"])).toEqual({ ...plain, receipts: [receipt] });
  });

  test("P24: with the flag off the PC never asks for a snapshot", async () => {
    const { service, services } = await server(false);
    expect(await services.accountMailbox.readSnapshot()).toBeNull();
    await services.accountMailbox.pull();
    expect(service.requests.some((request) => request.includes("/v1/pc/snapshot"))).toBe(false);
  });
});

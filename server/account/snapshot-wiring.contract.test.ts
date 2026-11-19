import { afterEach, describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { exportAccountKey } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { relayAccountFixture } from "../relay/test-helpers.ts";

const ACCOUNT = "acct_1";
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

async function server(accountOpensAll: boolean) {
  const service = new FakeAccountService();
  service.opensAll = true;
  const { fixture } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.push(() => fixture.close());
  const { services } = fixture.app.context;
  const identity = services.relay.currentIdentity();
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  service.registerDevice(ACCOUNT, await exportAccountKey(pair.publicKey), "Laptop");
  return { service, services };
}

describe("S2-24 the server wires the whole read only under the release flag (G1, P24)", () => {
  test("G1: with OVIS_ACCOUNT_OPENS_ALL on, the PC's mailbox reads and commits the account's snapshot", async () => {
    const { service, services } = await server(true);
    expect(services.devices.account()).toBe(ACCOUNT);
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(service.requests.some((request) => request.includes("/v1/pc/snapshot"))).toBe(true);
  });

  test("P24: with the flag off the PC never asks for a snapshot", async () => {
    const { service, services } = await server(false);
    expect(await services.accountMailbox.readSnapshot()).toBeNull();
    await services.accountMailbox.pull();
    expect(service.requests.some((request) => request.includes("/v1/pc/snapshot"))).toBe(false);
  });
});

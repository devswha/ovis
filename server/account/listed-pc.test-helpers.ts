import { expect } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId, exportAccountKey } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { relayAccountFixture } from "../relay/test-helpers.ts";

export const ACCOUNT = "acct_1";

/** A bound PC whose whole read has admitted one account row. */
export async function createListedPc(onClose: (close: () => void) => void) {
  const service = new FakeAccountService();
  service.opensAll = true;
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  onClose(() => fixture.close());
  rotateRelayIdentity(fixture.stateDir);
  const { services } = fixture.app.context;
  const identity = services.relay.currentIdentity()!;
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${service.issueToken(ACCOUNT)}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = await exportAccountKey(keys.publicKey);
  service.registerDevice(ACCOUNT, spki, "Laptop");
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const device = { keys, publicKey: spki, id: accountDeviceId(identity.server_id, spki) };
  return { fixture, member, device, service, serverId: identity.server_id };
}

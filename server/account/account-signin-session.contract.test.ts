import { afterEach, describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId, exportAccountKey } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { FrameType, type MuxFrame, ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, relayAccountFixture, relayConnection } from "../relay/test-helpers.ts";

const ACCOUNT = "acct_1";
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

/** A PC in ACCOUNT with the release flag on, whose whole read has listed one more device of the account. */
async function listedPc() {
  const service = new FakeAccountService();
  service.opensAll = true;
  const { fixture } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.push(() => fixture.close());
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
  return { fixture, device, serverId: identity.server_id };
}

async function refusal(pc: Awaited<ReturnType<typeof listedPc>>, features: readonly string[]) {
  const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
  let failed: Extract<MuxFrame, { type: typeof FrameType.SESSION_ERROR }>["payload"] | undefined;
  link.onFrame = (frame) => { if (frame.type === FrameType.SESSION_ERROR) failed = frame.payload; };
  void link.auth(pc.device, features).catch(() => undefined);
  await bounded(link.serverError);
  return failed;
}

describe("S2-25 an account-joined sign-in over the relay (S25)", () => {
  test("S25: the whole read admits the listed device as an account row, held until its notice is out", async () => {
    const pc = await listedPc();
    expect(pc.fixture.app.context.services.devices.has(pc.device.id)).toBe(true);
  });

  test("S25: an app that offered the account feature is refused held, with its hold state", async () => {
    const pc = await listedPc();
    expect(await refusal(pc, [ACCOUNT_OPENS_ALL_FEATURE])).toEqual({ code: "held", message: "This device waits for its join hold on this PC", hold: { reason: "join_hold", until: null } });
  });

  test("S25: an old-app hello gets today's code for the same refusal", async () => {
    const pc = await listedPc();
    expect(await refusal(pc, [])).toEqual({ code: "auth_failed", message: "auth_failed" });
  });
});

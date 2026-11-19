import { afterEach, describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ACCOUNT_OPENS_ALL_MUX_FEATURE } from "../../shared/account-devices-api.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { FrameType, type MuxFrame } from "../../shared/relay-mux.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, relayAccountFixture, relayConnection } from "../relay/test-helpers.ts";

const ACCOUNT = "acct_1";
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

/** A PC in ACCOUNT with the release flag on, started with one legacy member row and no whole read yet. */
async function startedPc() {
  const service = new FakeAccountService();
  service.opensAll = true;
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.push(() => fixture.close());
  rotateRelayIdentity(fixture.stateDir);
  const identity = fixture.app.context.services.relay.currentIdentity()!;
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${service.issueToken(ACCOUNT)}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  return { fixture, member, serverId: identity.server_id };
}

async function signIn(pc: Awaited<ReturnType<typeof startedPc>>, features: readonly string[]) {
  const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
  let failed: Extract<MuxFrame, { type: typeof FrameType.SESSION_ERROR }>["payload"] | undefined;
  let ok = false;
  link.onFrame = (frame) => {
    if (frame.type === FrameType.SESSION_ERROR) failed = frame.payload;
    if (frame.type === FrameType.AUTH_OK) ok = true;
  };
  await bounded(link.auth(pc.member, features).then(() => undefined, () => undefined));
  return ok ? "ok" : failed;
}

describe("S2-27 a devices.json row not paired at this PC waits for the first whole read after a start (T41, T42)", () => {
  test("T41: a legacy row's proved sign-in is refused catching_up until a whole read; an old app gets today's code", async () => {
    const pc = await startedPc();
    expect(await signIn(pc, [ACCOUNT_OPENS_ALL_MUX_FEATURE])).toEqual({ code: "held", message: "This PC waits for the account's list before letting this device in", hold: { reason: "catching_up" } });
    expect(await signIn(pc, [])).toEqual({ code: "auth_failed", message: "auth_failed" });
    expect(pc.fixture.app.context.services.devices.sessionRow(pc.member.id)).toBeNull();
  });

  test("T42: the first whole read ends the wait for a row the admission guard passes", async () => {
    const pc = await startedPc();
    expect(await pc.fixture.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(await signIn(pc, [ACCOUNT_OPENS_ALL_MUX_FEATURE])).toBe("ok");
  });
});

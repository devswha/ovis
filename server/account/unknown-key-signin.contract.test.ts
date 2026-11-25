/**
 * A sign-in by a key this PC in an account holds no row for (a device the account let in that this PC has not read
 * yet): while no read of the account that began after the key first asked here has finished, a client that knows the
 * account codes is told the PC is catching up, and waits; once such a read finished without the key, it is refused.
 * Whom the PC lets in does not change: the key gets in only by a row a read brought.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { ACCOUNT_OPENS_ALL_FEATURE, FrameType, type MuxFrame } from "../../shared/relay-mux.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, relayAccountFixture, relayConnection } from "../relay/test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";

const ACCOUNT = "acct_1";
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

/** A PC in ACCOUNT whose account service gives no snapshot until `ready`. */
async function pcInAccount() {
  const service = new FakeAccountService();
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, {
    accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch },
    prepare: (stateDir) => { const pc = PcAccountState.open(stateDir); pc.migrate(ACCOUNT, true); pc.admit("remote", "code", null, Date.now()); },
    origin: (at) => ({ from: "remote", how: "code", by: null, admit_no: 1, at }),
  });
  closes.push(() => fixture.close());
  rotateRelayIdentity(fixture.stateDir);
  const identity = fixture.app.context.services.relay.currentIdentity()!;
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${service.issueToken(ACCOUNT)}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  // the start's own pull is over before the test signs in, so no read is under way
  await fixture.app.context.services.accountMailbox.pull();
  return { fixture, member, service, serverId: identity.server_id, ready: () => { service.opensAll = true; } };
}

/** A device key this PC has never seen, signing in under an id of its own. */
async function stranger() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  return { keys, publicKey, id: randomBytes(8).toString("hex") };
}

async function signIn(pc: Awaited<ReturnType<typeof pcInAccount>>, device: Awaited<ReturnType<typeof stranger>>, features: readonly string[]) {
  const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
  let failed: Extract<MuxFrame, { type: typeof FrameType.SESSION_ERROR }>["payload"] | undefined;
  let ok = false;
  link.onFrame = (frame) => {
    if (frame.type === FrameType.SESSION_ERROR) failed = frame.payload;
    if (frame.type === FrameType.AUTH_OK) ok = true;
  };
  await bounded(link.auth(device, features).then(() => undefined, () => undefined), 20_000);
  return ok ? "ok" : failed;
}

const CATCHING_UP = { code: "held", message: "This PC waits for the account's list before letting this device in", hold: { reason: "catching_up" } } as const;

test("a key with no row, while no read of the account has finished since it first asked, waits: catching_up", async () => {
  const pc = await pcInAccount();
  const device = await stranger();
  pc.ready();
  // the read this sign-in starts does not get through (the account service away): nothing was read since the key asked
  const away = spyOn(pc.fixture.app.context.services.accountMailbox, "pull").mockImplementation(() => Promise.reject(new Error("The account service did not answer")));
  try {
    expect(await signIn(pc, device, [ACCOUNT_OPENS_ALL_FEATURE])).toEqual(CATCHING_UP);
    // and so while no read gets through
    expect(await signIn(pc, device, [ACCOUNT_OPENS_ALL_FEATURE])).toEqual(CATCHING_UP);
  } finally { away.mockRestore(); }
});

test("a key with no row is refused once a read that began after it first asked finished without it", async () => {
  const pc = await pcInAccount();
  const device = await stranger();
  pc.ready();
  expect(await signIn(pc, device, [ACCOUNT_OPENS_ALL_FEATURE])).toMatchObject({ code: "auth_failed" });
});

test("a read that began before the key first asked does not refuse it: only one after it does", async () => {
  const pc = await pcInAccount();
  const device = await stranger();
  const mailbox = pc.fixture.app.context.services.accountMailbox;
  pc.ready();
  // a read finished just before the key asked, and none can start for the next minute
  await mailbox.pull();
  await mailbox.pullForRefusedSignIn(0);
  const started = spyOn(mailbox, "pull");
  try { expect(await signIn(pc, device, [ACCOUNT_OPENS_ALL_FEATURE])).toEqual(CATCHING_UP); }
  finally { started.mockRestore(); }
});

test("a client that does not know the account codes is refused as before, and so is a PC in no account", async () => {
  const pc = await pcInAccount();
  expect(await signIn(pc, await stranger(), [])).toMatchObject({ code: "auth_failed" });
});

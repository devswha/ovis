import { expect, spyOn, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import { AddPcWaitOver, listThisPc } from "./addThisPc.ts";
import { AccountService, AccountServiceError } from "./service.ts";
import { memoryAccountStore, memoryLock } from "./store.ts";

const account = "acct_owner";
const origin = "https://account.ovis.sh";
async function setup() {
  const fake = new FakeAccountService();
  fake.opensAll = true;
  fake.completions = true;
  const store = memoryAccountStore();
  await store.set("session", { account, service: origin, provider: "github", access_token: fake.issueToken(account, { twoStep: true }), refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
  const directory = new AccountService({ store, lock: memoryLock(), fetch: fake.fetch });
  const { publicKey } = generateKeyPair();
  const serverId = deriveServerId(publicKey);
  const entry = { label: "desk", public_key: bytesToHex(publicKey), relay: "wss://relay.ovis.sh" };
  return { fake, directory, publicKey, serverId, entry };
}

test("a resumed wait does not recreate a join request declined on another device", async () => {
  const { directory, publicKey, serverId, entry } = await setup();
  await directory.putPc(serverId, entry);
  await directory.deletePc(serverId);
  expect(await directory.listPcs()).toHaveLength(0);
  const url = encodeOffer({ v: 1, server_id: serverId, server_public_key: exportPublicKey(publicKey), relay: entry.relay, name: entry.label }, "https://app.ovis.sh");
  const answer = async (input: RequestInfo | URL) => {
    switch (new URL(String(input), "http://localhost").pathname) {
      case "/api/health": return Response.json({ web_ui: { boot_id: "boot", revision: null, server_id: serverId } });
      case "/api/account/status": return Response.json({ account: null });
      case "/api/relay/link": return Response.json({ url });
      default: return Response.json({});
    }
  };
  const spy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
  setTransport({ ...nativeTransport, fetch: answer });
  try {
    await listThisPc(directory, { relistMs: 540_000, for: { serverId, account, running: () => true } }).catch((error: unknown) => {
      if (!(error instanceof AddPcWaitOver || error instanceof AccountServiceError && error.status === 409)) throw error;
    });
    expect((await directory.listPcs()).length, "directory rows after renewing a declined wait").toBe(0);
  } finally { setTransport(nativeTransport); spy.mockRestore(); }
});

test("Add on a stale card cannot confirm a listing another device already removed", async () => {
  const { fake, directory, serverId, entry } = await setup();
  const response = await fake.fetch(`${origin}/v1/pcs/${serverId}`, { method: "PUT", headers: { authorization: `Bearer ${fake.issueToken(account, { device: true })}`, "content-type": "application/json" }, body: JSON.stringify(entry) });
  expect(response.status).toBe(200);
  const [card] = await directory.listUnconfirmedPcs();
  expect(card?.server_id).toBe(serverId);
  await directory.deletePc(serverId);
  expect(await directory.listUnconfirmedPcs()).toHaveLength(0);
  await directory.confirmPc(card!).catch((error: unknown) => { if (!(error instanceof AccountServiceError)) throw error; });
  expect((await directory.listPcs()).length, "member listings after confirming a removed card").toBe(0);
});

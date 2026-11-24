import { expect, it } from "bun:test";

import type { RelayDevice } from "../relay/device.ts";
import { MemoryDeviceStore } from "../relay/device.test.ts";
import { leaveAccount } from "./leave.ts";
import type { AccountService } from "./service.ts";
import { memoryAccountStore, type AccountSession } from "./store.ts";

const ACCOUNT = "acct_owner";
const PC = "12".repeat(16);

const session = (name: string): AccountSession => ({ service: "https://account.example", account: ACCOUNT, provider: "github", access_token: `access-${name}`, refresh_token: `refresh-${name}`, expires_at: Date.now() + 3600_000, sign_in_id: `sign-in-${name}` });

/** The account service as leaveAccount meets it: the account lists `pcs`, takes every record, and `signedOut` runs as the sign-in ends there. */
function serviceListing(pcs: readonly string[], signedOut: () => Promise<void> = async () => {}): AccountService {
  const forSignIn = { listPcs: async () => pcs.map((server_id) => ({ server_id })), postRecord: async () => {}, signOut: signedOut };
  return { forSignIn: () => forSignIn } as unknown as AccountService;
}

/** A pairing with `pc` by `key`, as the PC confirmed it a member of the account. */
const pairing = (key: { readonly private_key: CryptoKey; readonly public_spki: string }, deviceId: string): RelayDevice => ({
  server_id: PC, device_id: deviceId, private_key: key.private_key, public_spki: key.public_spki, label: "Phone", server_public_key: "pc-key", relay: "wss://relay.example", account: ACCOUNT,
});

it("forgets the pairing it left by its row: a pairing another tab made with that PC meanwhile stays", async () => {
  const accountStore = memoryAccountStore();
  const key = await accountStore.key();
  const from = session("a");
  await accountStore.set("session", from);
  const relayStore = new MemoryDeviceStore();
  await relayStore.update(PC, () => pairing(key, "row-old"));
  const read = relayStore.list.bind(relayStore);
  const fresh = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  // another tab pairs this PC again right after the leave read the pairings: a device-only pairing with a key of its own
  relayStore.list = async () => {
    const seen = await read();
    await relayStore.update(PC, () => ({ ...pairing({ private_key: fresh.privateKey, public_spki: "fresh-key" }, "row-new"), account: undefined }));
    return seen;
  };
  await leaveAccount({ service: serviceListing([PC]), accountStore, relayStore, session: from });
  expect((await relayStore.get(PC))?.device_id).toBe("row-new");
});

it("clears the account store only while it holds the key that left: a sign-in and key made meanwhile stay", async () => {
  const accountStore = memoryAccountStore();
  await accountStore.key();
  const from = session("a");
  await accountStore.set("session", from);
  let replacement: string | undefined;
  // while the sign-in ends, another tab forgot the departing key, signed in again and made a key of its own
  const service = serviceListing([], async () => {
    await accountStore.clear();
    replacement = (await accountStore.key()).public_spki;
    await accountStore.set("session", session("b"));
  });
  await leaveAccount({ service, accountStore, relayStore: new MemoryDeviceStore(), session: from });
  expect(await accountStore.get("session")).toMatchObject({ sign_in_id: "sign-in-b" });
  expect((await accountStore.key()).public_spki).toBe(replacement!);
});

it("keeps the account key where another account's saved list still holds it, and ends only this sign-in", async () => {
  const accountStore = memoryAccountStore();
  const key = await accountStore.key();
  const from = session("a");
  await accountStore.set("session", from);
  let asked: string | undefined;
  await leaveAccount({ service: serviceListing([]), accountStore, relayStore: new MemoryDeviceStore(), session: from, keeps: async (held) => { asked = held; return true; } });
  expect(asked).toBe(key.public_spki);
  expect((await accountStore.key()).public_spki).toBe(key.public_spki);
  expect(await accountStore.get("session")).toBeUndefined();
});

import { expect, it } from "bun:test";
import { newRecordId, signSafetyRecord, type BlockRecord } from "../../../shared/account-records.ts";
import { keepUnsent, postKept, unsentBlocks } from "./unsentBlocks.ts";
import { AccountService, AccountServiceError, AccountServiceUnreachableError } from "./service.ts";
import { leaveAccount } from "./leave.ts";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { MemoryDeviceStore } from "../relay/device.test.ts";
import { memoryAccountStore, newKey, type AccountSession } from "./store.ts";

const session: AccountSession = { service: "https://account.example", account: "acct", provider: "github", sign_in_id: "this-sign-in", access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000 };

async function block(): Promise<BlockRecord> {
  const own = await newKey();
  return await signSafetyRecord({
    v: 1, kind: "block", account: "acct", target: (await newKey()).public_spki, target_no: 3, signer: own.public_spki, signer_no: 1,
    signed_at: new Date().toISOString(), nonce: newRecordId(),
  }, own.private_key);
}

it("S32-1: kept before any delivery, and dropped once the service confirms it", async () => {
  const store = memoryAccountStore();
  await store.set("session", session);
  const record = await block();
  await keepUnsent(store, session, [record]);
  expect((await unsentBlocks(store, session)).flatMap((kept) => kept.records)).toEqual([record]);
  expect(await postKept(store, session, [record], async () => {})).toBe("sent");
  expect(await unsentBlocks(store, session)).toEqual([]);
});

it("S32-1: a post a retry may change (no answer, 5xx, 401, 408, 429) keeps the exact record and throws", async () => {
  for (const failure of [new AccountServiceUnreachableError({ cause: new TypeError("down") }), new AccountServiceError(503, "unavailable", "busy"), new AccountServiceError(401, "unauthorized", "x"), new AccountServiceError(408, "timeout", "x"), new AccountServiceError(429, "too_many", "x"), new DOMException("slow", "TimeoutError")]) {
    const store = memoryAccountStore();
  await store.set("session", session);
    const record = await block();
    await keepUnsent(store, session, [record]);
    await expect(postKept(store, session, [record], async () => { throw failure; })).rejects.toBe(failure);
    expect((await unsentBlocks(store, session)).flatMap((kept) => kept.records)).toEqual([record]);
  }
});

it("S32-1: a final refusal leaves the queue: target_removed reads as done, any other 4xx as refused", async () => {
  for (const [failure, outcome] of [
    [new AccountServiceError(409, "target_removed", "gone"), "done"],
    [new AccountServiceError(403, "signer_not_older", "x"), "refused"],
    [new AccountServiceError(400, "record_invalid", "x"), "refused"],
  ] as const) {
    const store = memoryAccountStore();
  await store.set("session", session);
    const record = await block();
    await keepUnsent(store, session, [record]);
    expect(await postKept(store, session, [record], async () => { throw failure; })).toBe(outcome);
    expect(await unsentBlocks(store, session)).toEqual([]);
  }
});

it("S32-1: of a partly accepted set, only the records still unconfirmed stay", async () => {
  const store = memoryAccountStore();
  await store.set("session", session);
  const [taken, left] = [await block(), await block()];
  await keepUnsent(store, session, [taken, left]);
  await expect(postKept(store, session, [taken, left], async (record) => { if (record === left) throw new AccountServiceError(503, "unavailable", "busy"); })).rejects.toThrow();
  expect((await unsentBlocks(store, session)).flatMap((kept) => kept.records)).toEqual([left]);
  // the in-session retry sends the original set again: what the service takes now leaves, by record id
  expect(await postKept(store, session, [taken, left], async () => {})).toBe("sent");
  expect(await unsentBlocks(store, session)).toEqual([]);
});

it("S32-1: a later sign-in to the same account takes the queue on with the same records; another account never sees it", async () => {
  const store = memoryAccountStore();
  await store.set("session", session);
  const record = await block();
  await keepUnsent(store, session, [record]);
  expect((await unsentBlocks(store, { ...session, sign_in_id: "a-later-sign-in" })).flatMap((kept) => kept.records)).toEqual([record]);
  expect(await unsentBlocks(store, { ...session, account: "other" })).toEqual([]);
  // a post under the other account's sign-in removes nothing of this account's
  expect(await postKept(store, { ...session, account: "other" }, [record], async () => {})).toBe("sent");
  expect(Object.keys(await store.get("unsent_blocks") ?? {})).toEqual([record.id]);
});

it("S32-1: leaving the account keeps every unsent block: only the service's answer takes one away", async () => {
  const service = new FakeAccountService();
  const store = memoryAccountStore();
  const a = { ...session, service: "https://account.example", account: "acct", access_token: service.issueToken("acct") };
  await store.set("session", a);
  await keepUnsent(store, a, [await block()]);
  await store.update("unsent_blocks", (current) => ({ ...current, theirs: { account: "acct", sign_in_id: "b", records: [] } }));
  await leaveAccount({ service: new AccountService({ store, fetch: service.fetch }), accountStore: store, relayStore: new MemoryDeviceStore(), session: a });
  expect(Object.keys(await store.get("unsent_blocks") ?? {}).sort()).toEqual(["theirs", ...Object.keys(await store.get("unsent_blocks") ?? {}).filter((id) => id !== "theirs")].sort());
  expect(Object.keys(await store.get("unsent_blocks") ?? {})).toHaveLength(2);
});

it("S32-1: a failed post never writes its records back into a queue that a sign-out cleared meanwhile", async () => {
  const store = memoryAccountStore();
  await store.set("session", session);
  const record = await block();
  await keepUnsent(store, session, [record]);
  await expect(postKept(store, session, [record], async () => {
    // this sign-in's queue goes with its sign-out; another sign-in's stays
    await store.set("unsent_blocks", { theirs: { account: session.account, sign_in_id: "another", records: [record] } });
    throw new AccountServiceError(503, "unavailable", "busy");
  })).rejects.toThrow();
  expect(Object.keys(await store.get("unsent_blocks") ?? {})).toEqual(["theirs"]);
});

it("S32-1: nothing is kept for a sign-in that is no longer the stored one", async () => {
  const store = memoryAccountStore();
  await store.set("session", { ...session, sign_in_id: "a-later-sign-in" });
  expect(await keepUnsent(store, session, [await block()])).toBe(false);
  expect(await store.get("unsent_blocks")).toBeUndefined();
  await store.set("session", session);
  expect(await keepUnsent(store, session, [await block()])).toBe(true);
});

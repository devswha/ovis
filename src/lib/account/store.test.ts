import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fakeIndexedDB, type FakeIndexedDB } from "../indexedDB.fake.ts";
import { AccountService } from "./service.ts";
import { ACCOUNT_SESSION_EVENT, indexedAccountStore } from "./store.ts";

describe("the browser's account store", () => {
  const saved = { indexedDB: Object.getOwnPropertyDescriptor(globalThis, "indexedDB"), window: Object.getOwnPropertyDescriptor(globalThis, "window") };
  let db: FakeIndexedDB;
  let announced: number;
  beforeEach(() => {
    db = fakeIndexedDB();
    const page = new EventTarget();
    page.addEventListener(ACCOUNT_SESSION_EVENT, () => { announced += 1; });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: db.factory });
    Object.defineProperty(globalThis, "window", { configurable: true, value: page });
    announced = 0;
  });
  afterEach(() => {
    for (const name of ["indexedDB", "window"] as const) {
      const descriptor = saved[name];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  it("writes nothing and announces no change when the sign-in is only read", async () => {
    await indexedAccountStore.set("session", { service: "https://account.ovis.sh", account: "acct-a", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000, sign_in_id: "sign-in-a" });
    announced = 0;
    const service = new AccountService({ store: indexedAccountStore });
    expect((await service.session())?.sign_in_id).toBe("sign-in-a");
    await service.session();
    expect(announced).toBe(0);
  });
});

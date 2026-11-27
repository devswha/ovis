import { expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { verifyAccountRecord } from "../../../shared/account-records.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { AccountService, SignedOutError } from "../account/service.ts";
import { noteAct, readSeenPcs } from "../account/seenPcs.ts";
import { memoryAccountStore, type AccountSession } from "../account/store.ts";
import { mergeKeySlot } from "../account/mergeKeys.ts";
import { createAccountController } from "./accountController.ts";
import type { ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";
import type { RelayTransport } from "./transport.ts";

const SERVICE = "https://account.ovis.sh";
const FROM = "acct_old";
const INTO = "acct_new";
const CURRENT = "c".repeat(16);
const OLD = "b".repeat(16);
const NOW = Date.now();

test.each([["switch"], ["token"], ["refresh"]] as const)("cleanup waits for the old account and every remembered row (%s)", async (detected) => {
  const browser = createShellTestPage();
  const store = memoryAccountStore();
  const devices: ShellDeviceStore = { get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false, update: async () => { throw new Error("no saved pairing"); } };
  const signIn = async (account: string) => {
    const generation = await AccountService.signInGeneration(store);
    const session: AccountSession = { service: SERVICE, provider: "github", account, sign_in_generation: generation, sign_in_id: account,
      access_token: account, refresh_token: account, expires_at: NOW + 3_600_000 };
    expect(await AccountService.storeSignIn(store, session)).toBe(true);
    return await store.key();
  };
  let merged = false;
  const fetch = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const refresh = request.method === "POST";
    const old = request.headers.get("authorization") === `Bearer ${FROM}` || (refresh && (await request.json()).refresh_token === FROM);
    return old && merged ? Response.json({ error: { code: detected === "refresh" && !refresh ? "unauthorized" : "account_merged" } }, { status: 401 }) : Response.json({ pcs: [] });
  };
  const controller = createAccountController({
    container: Object.create(null), entryUrl: "https://app.ovis.sh/", store: devices, accountStore: store, accountService: SERVICE,
    accountFetch: fetch,
    renderApp: () => ({ render() {}, unmount() {} }),
  }, { active: () => false, changed: async () => {}, outdated: () => new Set() });
  try {
    const old = await signIn(FROM);
    const first = generateKeyPair().publicKey;
    const second = generateKeyPair().publicKey;
    const empty = generateKeyPair().publicKey;
    for (const pc of [first, second, empty]) await noteAct(FROM, bytesToHex(pc), "paired");
    const slot = mergeKeySlot({ service: SERVICE, account: FROM });
    if (detected !== "switch") {
      merged = true;
      await expect(new AccountService({ store, fetch }).listPcs()).rejects.toBeInstanceOf(SignedOutError);
      expect((await store.get("merge_keys"))?.[slot]).toMatchObject({ merged: true, key: old });
    }
    const key = await signIn(INTO);
    expect(key.public_spki).not.toBe(old.public_spki);
    const open = async (pc: Uint8Array, row: "drive" | "watch" | "absent") => {
      let posted = 0;
      const opened = {
        deviceKey: key.public_spki, deviceId: CURRENT,
        fetch: async (path: string, init?: RequestInit) => {
          if (path === "/api/account/status") return Response.json({ account: INTO, before_merge: row === "absent" ? [] : [OLD] });
          if (path === "/api/devices") return Response.json({ devices: [
            { id: CURRENT, current: true, account: INTO, account_key: key.public_spki, role: "drive" },
            ...(row === "absent" ? [] : [{ id: OLD, before_merge: true, account_key: old.public_spki, role: row }]),
          ] });
          if (path !== "/api/account/records" || typeof init?.body !== "string") return new Response(null, { status: 404 });
          posted++;
          const { records: [record] } = JSON.parse(init.body);
          expect(record).toMatchObject({ kind: "remove", signer: old.public_spki, key: old.public_spki, account: FROM });
          expect(await verifyAccountRecord(record)).toBe(true);
          return Response.json({ results: [{ id: record.id, outcome: "applied" }] });
        },
      } as RelayTransport;
      await controller.sessionOpened(opened, exportPublicKey(pc));
      return posted;
    };
    expect(await open(first, "drive")).toBe(1);
    if (detected === "switch") expect(readSeenPcs(INTO).pcs).toEqual({});
    expect((await store.get("merge_keys"))?.[slot]?.key?.public_spki).toBe(old.public_spki);
    merged = true;
    expect(await open(second, "watch")).toBe(0);
    expect(Object.keys(readSeenPcs(INTO).pcs).sort()).toEqual([first, second, empty].map(bytesToHex).sort());
    expect(await open(second, "drive")).toBe(1);
    expect((await store.get("merge_keys"))?.[slot]?.key?.public_spki).toBe(old.public_spki);
    expect(await open(empty, "absent")).toBe(0);
    expect((await store.get("merge_keys"))?.[slot]).toBeUndefined();
    expect(await open(first, "drive")).toBe(0);
  } finally {
    controller.dispose();
    browser.dispose();
  }
});

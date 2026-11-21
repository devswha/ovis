import { afterEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { listThisPc } from "../../src/lib/account/addThisPc.ts";
import { myPcs } from "../../src/lib/account/myPcs.ts";
import { AccountService } from "../../src/lib/account/service.ts";
import { memoryAccountStore } from "../../src/lib/account/store.ts";
import { dashboardModel } from "../../src/lib/relay/dashboard.ts";
import { nativeTransport, setTransport } from "../../src/lib/transport.ts";
import { pairingPc, setUpFor } from "./pairing.test-helpers.ts";

const ACCOUNT = "acct_refresh";
const SERVICE = "https://account.test";
const RELAY = "wss://relay.test";
const LISTING = "a".repeat(32);
const RELIST_MS = 9 * 60_000;
const INVITATION_MS = 10 * 60_000;
const closes: (() => Promise<void>)[] = [];

afterEach(async () => {
  setTransport(nativeTransport);
  for (const close of closes.splice(0)) await close();
});

async function fixture(mode: "bind" | "complete" | "pending" | "refusal") {
  const pc = await pairingPc({ server: { accountOpensAll: true } });
  let passSetup: Promise<Response> | undefined;
  closes.push(async () => { try { await passSetup; } finally { await pc.close(); } });
  pc.account.opensAll = true;
  const identity = pc.app.context.services.relay.currentIdentity();
  if (identity === undefined || identity === null) throw new TypeError("The relay fixture needs its identity");
  const serverId = identity.server_id;
  const path = `/v1/pcs/${serverId}`;
  const now = Date.now();
  const added = new Date(now - 2 * INVITATION_MS).toISOString();
  let invitedAt = added;
  const store = memoryAccountStore();
  await store.set("session", { account: ACCOUNT, provider: "github", service: SERVICE, access_token: pc.account.issueToken(ACCOUNT), refresh_token: "fixture", expires_at: now + 3_600_000 });
  const seed = new AccountService({ store, fetch: pc.account.fetch });
  await seed.putPc(serverId, { label: "Desk", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: RELAY });
  await setUpFor(pc, ACCOUNT);

  const otherStore = memoryAccountStore();
  await otherStore.set("session", { account: ACCOUNT, provider: "github", service: SERVICE, access_token: pc.account.issueToken(ACCOUNT, { twoStep: true }), refresh_token: "other-fixture", expires_at: now + 3_600_000 });
  const admit = new AccountService({ store: otherStore, fetch: pc.account.fetch });
  const binds = mode === "bind" || mode === "complete";
  let raced = false;
  const changes: string[] = [];
  const directory = new AccountService({ store, fetch: async (input, init) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/v1/pcs" && request.method === "GET") {
      const response = await pc.account.fetch(request);
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("pcs" in body) || !Array.isArray(body.pcs)) throw new TypeError("The account fake did not return its PC directory");
      const pcs: readonly unknown[] = body.pcs;
      return Response.json({ pcs: pcs.map((entry) =>
        typeof entry === "object" && entry !== null && "server_id" in entry && entry.server_id === serverId
          ? { ...entry, added_at: added, listing_id: LISTING, invited_at: invitedAt }
          : entry,
      ) });
    }
    if (pathname === path || pathname === `${path}/refresh`) {
      changes.push(`${request.method} ${pathname}`);
      if (binds && !raced) {
        raced = true;
        expect(pc.devices.account()).toBeNull();
        await admit.admitPc(serverId);
        const bound = await pc.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: ACCOUNT } });
        expect(bound.status).toBe(200);
      }
      if (pathname === `${path}/refresh`) {
        expect(await request.json()).toEqual({ listing_id: LISTING });
        if (mode === "refusal" || mode === "complete") return Response.json({ error: { code: "listing_changed" } }, { status: 409 });
        invitedAt = new Date(now).toISOString();
        return Response.json({ invited_at: invitedAt });
      }
      const answer = await pc.account.fetch(request);
      if (binds && request.method === "DELETE") await pc.app.context.services.accountMailbox.readSnapshot();
      return answer;
    }
    return pc.account.fetch(request);
  } });
  const base = `http://127.0.0.1:${pc.app.port}`;
  const fetchPc = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), base);
    const reply = fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: base } });
    if (url.pathname === "/api/account/relay-account") passSetup = reply;
    return reply;
  };
  setTransport({ ...nativeTransport, fetch: Object.assign(fetchPc, { preconnect: fetch.preconnect }) });
  return { pc, directory, changes, now, added, serverId, refresh: `POST ${path}/refresh` };
}

test.each(["bind", "complete"] as const)("refresh races a real one-press %s without removing the binding", async (mode) => {
  const f = await fixture(mode);

  const listed = await listThisPc(f.directory, { relistMs: RELIST_MS });
  await f.pc.app.context.services.accountMailbox.readSnapshot();

  expect(f.pc.devices.account()).toBe(ACCOUNT);
  expect(f.changes).toEqual([f.refresh]);
  expect(listed).toMatchObject({ membership: { account: ACCOUNT, enrolling: false } });
});

test("refreshing a pending invitation keeps its listing age and renews its dashboard countdown", async () => {
  const f = await fixture("pending");
  const dashboard = async () => {
    const rows = myPcs(await f.directory.listPcs(), [], { now: f.now }).map((pc) => ({ ...pc, relay: pc.join?.relay ?? null }));
    return dashboardModel(rows, { label: "Phone", now: f.now }, RELAY);
  };
  expect((await dashboard()).attention[0]?.expiresAt).toBeNull();

  await listThisPc(f.directory, { relistMs: RELIST_MS });

  expect(f.changes).toEqual([f.refresh]);
  const row = (await dashboard()).attention[0];
  expect(row).toMatchObject({ server_id: f.serverId, expiresAt: f.now + INVITATION_MS });
  expect((await f.directory.listPcs())[0]?.added_at).toBe(f.added);
});

test("a changed-listing response never triggers legacy removal or recreates the row", async () => {
  const f = await fixture("refusal");

  await expect(listThisPc(f.directory, { relistMs: RELIST_MS })).rejects.toMatchObject({ code: "listing_changed" });

  expect(f.changes).toEqual([f.refresh]);
});

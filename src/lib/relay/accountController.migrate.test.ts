import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AccountList, AccountListView } from "../account/accountList.ts";
import { pageAnswers } from "../account/listMigrate.ts";
import { memoryAccountStore, newKey, type AccountSession, type AccountStore } from "../account/store.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { ACCOUNT_LIST_FEATURE } from "../../../shared/relay-mux.ts";
import { createAccountController } from "./accountController.ts";
import type { RelayDevice, ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";
import type { RelayTransport } from "./transport.ts";

const SERVICE = "https://account.ovis.sh";
const DAY = 86400;
const session = (account: string): AccountSession => ({ service: SERVICE, account, provider: "github", access_token: `access-${account}`, refresh_token: `refresh-${account}`, expires_at: Date.now() + 3_600_000, sign_in_id: `sign-in-${account}`, signed_in_at: Date.now() });
const settle = async (): Promise<void> => { for (let turn = 0; turn < 30; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };

/** A PC: its relay key as a relay offer carries it, and as a list names it (64 hex). */
function pcKeys() {
  const pair = generateKeyPair();
  return { offerKey: exportPublicKey(pair.publicKey), endpoint: Array.from(pair.publicKey, (byte) => byte.toString(16).padStart(2, "0")).join(""), serverId: deriveServerId(pair.publicKey) };
}

/** A session the shell opened: what was asked over it, and the PC's answers by `METHOD path`. */
function sessionOf(given: { readonly pinned?: boolean; readonly key?: string; readonly answers?: Record<string, unknown> }) {
  const asked: { method: string; path: string; body: unknown }[] = [];
  let closed = false;
  const opened = {
    server: { version: "1", relayProtocol: 1, features: given.pinned === true ? [ACCOUNT_LIST_FEATURE] : [] },
    deviceKey: given.key,
    fetch: async (path: string, init?: RequestInit) => {
      asked.push({ method: init?.method ?? "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      const said = given.answers?.[`${init?.method ?? "GET"} ${path}`];
      return said === undefined ? Response.json({ error: { code: "not_found" } }, { status: 404 }) : Response.json(said);
    },
    close: () => { closed = true; },
  };
  return { opened: opened as unknown as RelayTransport, asked, closed: () => closed };
}

/** A list in the view the test sets, recording what is asked of it. */
function listIn(view: () => AccountListView, naming: AccountList["naming"] = undefined) {
  const listeners: ((view: AccountListView) => void)[] = [];
  let synced = 0;
  const list = {
    sync: async () => { synced += 1; return view(); }, follows: async () => false, view, subscribe: (listener: (view: AccountListView) => void) => { listeners.push(listener); return () => {}; },
    holdsPc: () => false, pcOfKey: () => null, due: () => null, shadow: async () => null, dropNames: async () => {}, forget: async () => {}, adopt: async () => view(),
    writer: () => null, placeAt: () => null, holdsEntry: () => false, gossip: () => null, pageAfter: () => null,
    kept: async () => null, keep: async () => { throw new Error("nothing is signed here"); }, unkeep: async () => {}, waiting: async () => null, cancel: async () => "gone" as const, shown: () => Math.floor(Date.now() / 1000),
    ...(naming === undefined ? {} : { naming }),
  } as AccountList;
  return { list, tell: () => { for (const listener of listeners) listener(view()); }, synced: () => synced };
}

describe("the shell's sessions and the move of an account onto its list", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  let accountStore: AccountStore;
  const made: { dispose(): void }[] = [];
  beforeEach(() => { browser = createShellTestPage(); accountStore = memoryAccountStore(); });
  afterEach(() => { for (const each of made.splice(0)) each.dispose(); browser.dispose(); });

  const controller = (list: AccountList, store: ShellDeviceStore, open?: (offer: unknown, options: Record<string, unknown>) => Promise<RelayTransport>, pcs: unknown[] = []) => {
    const made_ = createAccountController({
      container: Object.create(null), entryUrl: "https://app.ovis.sh/", store, accountStore, accountService: SERVICE, accountList: list,
      ...(open === undefined ? {} : { open: open as never }),
      accountFetch: async (input) => new URL(new Request(input).url).pathname === "/v1/pcs" ? Response.json({ pcs }) : Response.json({ error: { code: "not_found" } }, { status: 404 }),
      renderApp: () => ({ render() {}, unmount() {} }),
    }, { active: () => true, changed: async () => {}, outdated: () => new Set() });
    made.push(made_);
    return made_;
  };
  const signIn = async (account: string): Promise<string> => {
    const signedIn = session(account);
    await accountStore.set("session", signedIn);
    const key = await newKey();
    await accountStore.set("signin_key", { account, sign_in_id: signedIn.sign_in_id!, key, no: 2 });
    return key.public_spki;
  };
  const empty: ShellDeviceStore = { get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false, update: async () => { throw new Error("no pairing here"); } };

  it("a device that follows its moved list names it, with its vouch, to a PC that follows none", async () => {
    const signedIn = await signIn("acct-named");
    const pc = pcKeys();
    const following = (): AccountListView => ({ account: "acct-named", reached: true, status: { at: "following", list: "5c".repeat(32), standing: "in", head: 4, read_at: 1, trouble: null }, devices: [], pcs: [] });
    let named: unknown = null;
    const { list } = listIn(following, async (given) => { named = given; return { naming: { list: "5c".repeat(32), key: "member", signature: "s".repeat(86) }, vouches: [] }; });
    const account = controller(list, empty);
    const unpinned = sessionOf({ key: signedIn });
    await account.sessionOpened(unpinned.opened, pc.offerKey);
    expect(named).toEqual({ session: signedIn, endpoint: pc.endpoint, signIn: signedIn });
    expect(unpinned.asked.map((one) => `${one.method} ${one.path}`)).toEqual(["POST /api/account/list/name"]);
    // a PC that took account-list-1 follows a list already: it is named nothing
    const pinned = sessionOf({ key: signedIn, pinned: true });
    await account.sessionOpened(pinned.opened, pc.offerKey);
    expect(pinned.asked).toEqual([]);
  });

  it("a device in no moved list, and one with no list, says nothing to any PC", async () => {
    const signedIn = await signIn("acct-quiet");
    const pc = pcKeys();
    for (const status of [{ at: "off" as const }, { at: "none" as const, why: "not_new" as const }]) {
      const { list } = listIn(() => ({ account: "acct-quiet", reached: true, status, devices: [], pcs: [] }), async () => null);
      const account = controller(list, empty);
      const one = sessionOf({ key: signedIn });
      await account.sessionOpened(one.opened, pc.offerKey);
      expect(one.asked).toEqual([]);
    }
  });

  it("while it waits on its PCs, each PC its record knows is asked over a session of its own, and the list read again", async () => {
    await signIn("acct-asks");
    const pc = pcKeys();
    const at = Math.floor(Date.now() / 1000) - 40 * DAY;
    globalThis.localStorage.setItem("ovis:seen-pcs:acct-asks", JSON.stringify({ v: 1, account: "acct-asks", pcs: { [pc.endpoint]: { since: at, last: at, how: "paired" } } }));
    const paired = { server_id: pc.serverId, device_id: "dev-1", private_key: (await newKey()).private_key, public_spki: "spki", label: "Phone", server_public_key: pc.offerKey, relay: "wss://relay.test" } as RelayDevice;
    const store: ShellDeviceStore = { ...empty, get: async (id) => (id === pc.serverId ? paired : undefined), list: async () => [paired] };
    const said = { account: "acct-asks", pinned: null, admits: [], removed: [] };
    const asking = sessionOf({ answers: { "GET /api/account/list/witness": said } });
    const opened: unknown[] = [];
    const waiting = (): AccountListView => ({ account: "acct-asks", reached: true, status: { at: "none", why: "moving", move: { why: "pcs_silent", wait: 60, asks: [pc.endpoint] } }, devices: [], pcs: [] });
    const { list, tell, synced } = listIn(waiting);
    const account = controller(list, store, async (offer) => { opened.push(offer); return asking.opened; });
    await account.refresh(true);
    await settle();
    tell();
    await settle();
    expect(opened).toHaveLength(1);
    expect(asking.asked.map((one) => `${one.method} ${one.path}`)).toEqual(["GET /api/account/list/witness"]);
    expect(asking.closed()).toBe(true);
    expect(pageAnswers.get("acct-asks", pc.endpoint)).toEqual(said);
    expect(synced()).toBeGreaterThan(0);
    // asked once: a second word from the list asks it no second time in this run
    tell();
    await settle();
    expect(opened).toHaveLength(1);
  });

  it("asks a PC through the account with this sign-in's key where the directory names it, before any saved pairing", async () => {
    const signedIn = await signIn("acct-through");
    const pc = pcKeys();
    const at = Math.floor(Date.now() / 1000) - 40 * DAY;
    globalThis.localStorage.setItem("ovis:seen-pcs:acct-through", JSON.stringify({ v: 1, account: "acct-through", pcs: { [pc.endpoint]: { since: at, last: at, how: "paired" } } }));
    const paired = { server_id: pc.serverId, device_id: "dev-1", private_key: (await newKey()).private_key, public_spki: "spki", label: "Phone", server_public_key: pc.offerKey, relay: "wss://relay.test" } as RelayDevice;
    const store: ShellDeviceStore = { ...empty, get: async (id) => (id === pc.serverId ? paired : undefined), list: async () => [paired] };
    const asking = sessionOf({ answers: { "GET /api/account/list/witness": { account: "acct-through", pinned: null, admits: [], removed: [] } } });
    const opened: { offer: { server_id: string; server_public_key: string }; options: Record<string, unknown> }[] = [];
    const waiting = (): AccountListView => ({ account: "acct-through", reached: true, status: { at: "none", why: "moving", move: { why: "pcs_silent", wait: 60, asks: [pc.endpoint] } }, devices: [], pcs: [] });
    const { list, tell } = listIn(waiting);
    const row = { server_id: pc.serverId, label: "Desk", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: null, public_key: pc.endpoint, relay: "wss://relay.test", new_until: null, admitted_at: null, admitted_before_you: false };
    const account = controller(list, store, async (offer, options) => { opened.push({ offer: offer as never, options }); return asking.opened; }, [row]);
    await account.refresh(true);
    await settle();
    tell();
    await settle();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.offer).toMatchObject({ server_id: pc.serverId, server_public_key: pc.offerKey });
    expect(opened[0]!.options.accountOpensAll).toBe(true);
    expect(await (opened[0]!.options.store as ShellDeviceStore).get(pc.serverId)).toMatchObject({ public_spki: signedIn });
  });

  it("a carried device whose hand-over is not placed yet signs in to a PC of its list with its sign-in key, the key the list holds for it (R-E)", async () => {
    const signedIn = await signIn("acct-carried");
    const pc = pcKeys();
    const list = "5c".repeat(32);
    const row = (key: string, self: boolean) => ({ key, self, power: "full" as const, role: "drive" as const, until: null, carried: true, name: null });
    let selfKey = signedIn;
    const following = (): AccountListView => ({
      account: "acct-carried", reached: true, status: { at: "following", list, standing: "in", head: 4, read_at: 1, trouble: null },
      devices: [row(selfKey, true)], pcs: [{ endpoint: pc.endpoint, server_id: pc.serverId, how: "carried", allows: false, name: null, seq: 2, by: null, new_until: null, new_at: null } as never],
    });
    const { list: held } = listIn(following);
    const account = controller(held, empty);
    await account.refresh(true);
    await settle();
    expect(account.listKey?.public_spki).toBe(signedIn);
    expect(account.listHolds(pc.serverId)).toBe(true);
    expect(account.listSays(pc.serverId)).toBe("holds");
    // after its hand-over, the key the list holds for it is its account key
    selfKey = (await accountStore.key()).public_spki;
    expect(account.listKey?.public_spki).toBe(selfKey);
    // and a key the list holds for no device of its own opens nothing by the list
    selfKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5lhuexKpDRsxAK4WTOjTQTjBurzk0iGngvCpNGetUiwtppuB-SgVWvMwkHCQe6FNPoAzLJZntcFyjzv0sk82Bg";
    expect(account.listKey).toBeNull();
  });
});

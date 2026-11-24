import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AccountList, AccountListView } from "../account/accountList.ts";
import type { DirectoryPc } from "../account/service.ts";
import { generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { memoryAccountStore, newKey, type AccountSession, type AccountStore } from "../account/store.ts";
import { createAccountController } from "./accountController.ts";
import type { ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";
import type { RelayTransport } from "./transport.ts";

const SERVICE = "https://account.ovis.sh";
const OFF: AccountListView = { account: null, status: { at: "off" }, reached: true, devices: [], pcs: [] };
const row = (id: string): DirectoryPc => ({ server_id: id, label: "Desk", added_at: "2026-11-24T00:00:00.000Z", last_seen_at: null, public_key: null, relay: null, new_until: null, admitted_at: null, admitted_before_you: false });
const session = (account: string): AccountSession => ({ service: SERVICE, account, provider: "github", access_token: `access-${account}`, refresh_token: `refresh-${account}`, expires_at: Date.now() + 3_600_000, sign_in_id: `sign-in-${account}`, signed_in_at: Date.now() });
/** The waits of the code under test, run one at a time by the test: no clock passes. */
function useFakeWaits() {
  const real = globalThis.setTimeout;
  const pending: (() => void)[] = [];
  globalThis.setTimeout = ((run: () => void, ms?: number) => {
    if (ms === undefined || ms < 1000) return real(run, ms);
    pending.push(run);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  return { next: async (): Promise<void> => { pending.shift()?.(); }, restore: (): void => { globalThis.setTimeout = real; } };
}

const empty: ShellDeviceStore = {
  get: async () => undefined, list: async () => [],
  remove: async () => {}, removeRow: async () => false,
  update: async () => { throw new Error("No pairing is made here"); },
};

/** a list that only records what the shell asks of it */
function recordingList(): { list: AccountList; calls: string[]; heard: (() => void)[] } {
  const calls: string[] = [];
  const heard: (() => void)[] = [];
  const list: AccountList = {
    sync: async () => { calls.push("sync"); return OFF; },
    follows: async () => false,
    view: () => OFF,
    subscribe: (listener) => { heard.push(() => listener(OFF)); return () => {}; },
    holdsPc: () => false,
    pcOfKey: () => null,
    due: () => null,
    shadow: async (account, directory, opens) => { calls.push(`shadow ${account} ${directory.map((pc) => pc.server_id).join(",")} opens:${[...opens ?? []].join(",")}`); return null; },
    dropNames: async (account) => { calls.push(`dropNames ${account}`); },
    forget: async (account) => { calls.push(`forget ${account}`); },
    adopt: async (offer) => { calls.push(`adopt ${offer.list} ${offer.seq}`); return OFF; },
    writer: () => null,
    holdsEntry: () => false,
    gossip: () => null,
    pageAfter: () => null,
  };
  return { list, calls, heard };
}

describe("the hosted shell and the account's signed list", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  let accountStore: AccountStore;
  let directory: DirectoryPc[];
  let asked: string[];
  beforeEach(() => {
    browser = createShellTestPage();
    accountStore = memoryAccountStore();
    directory = [row("a1".repeat(16))];
    asked = [];
  });
  afterEach(() => browser.dispose());

  const settle = async (): Promise<void> => { for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
  const controller = (accountList?: AccountList | null, changed: () => void = () => {}) => createAccountController({
    container: Object.create(null), entryUrl: "https://app.ovis.sh/", store: empty, accountStore, accountService: SERVICE,
    accountFetch: async (input) => {
      const { pathname } = new URL(new Request(input).url);
      asked.push(pathname);
      return pathname === "/v1/pcs" ? Response.json({ pcs: directory }) : Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 });
    },
    renderApp: () => ({ render() {}, unmount() {} }),
    ...(accountList === undefined ? {} : { accountList }),
  }, { active: () => true, changed: async () => { changed(); }, outdated: () => new Set() });
  const signIn = async (account: string, no: number | null = 1): Promise<void> => {
    const signedIn = session(account);
    await accountStore.set("session", signedIn);
    await accountStore.set("signin_key", { account, sign_in_id: signedIn.sign_in_id!, key: await newKey(), no });
  };

  it("reads the list once per sign-in, after the directory, and holds each directory read against it", async () => {
    await signIn("acct-one");
    const { list, calls, heard } = recordingList();
    const account = controller(list);
    await account.refresh(true);
    await settle();
    expect(calls).toEqual(["sync", `shadow acct-one ${"a1".repeat(16)} opens:`]);
    // a later read of the directory compares again, and reads the list no second time: that is the list's own clock
    directory = [row("a1".repeat(16)), row("b2".repeat(16))];
    await account.refresh(false, true);
    await settle();
    expect(calls.slice(2)).toEqual([`shadow acct-one ${"a1".repeat(16)},${"b2".repeat(16)} opens:`]);
    // the list moved: compared again with the directory last read
    for (const tell of heard) tell();
    await settle();
    expect(calls.slice(3)).toEqual([`shadow acct-one ${"a1".repeat(16)},${"b2".repeat(16)} opens:`]);
    // another sign-in: its list is read at once
    await signIn("acct-two");
    await account.refresh(false, true);
    await settle();
    expect(calls.slice(4)).toEqual(["sync", `shadow acct-two ${"a1".repeat(16)},${"b2".repeat(16)} opens:`]);
  });

  it("reads the list again after a sign-out, so that nothing of the ended sign-in stays in view, and forgets what opens its names", async () => {
    await signIn("acct-one");
    const { list, calls } = recordingList();
    const account = controller(list);
    await account.refresh(true);
    await settle();
    calls.length = 0;
    account.signOut();
    await settle();
    // once, when the sign-in is gone from the store: not while it is still there. What opens the list's names goes
    // as the PCs' names do, and the copy stays: the device is still a member
    expect([...calls].sort()).toEqual(["dropNames acct-one", "sync"]);
    expect(await accountStore.get("session")).toBeUndefined();
  });

  it("changes nothing it draws or sends by the list: the same rows and the same requests with one and with none", async () => {
    await signIn("acct-one");
    const withList = controller(recordingList().list);
    await withList.refresh(true);
    await settle();
    const [drawn, sent] = [withList.state, [...asked]];
    asked = [];
    const without = controller(null);
    await without.refresh(true);
    await settle();
    expect(drawn).toMatchObject({ kind: "signed-in", error: null, pcs: [{ server_id: "a1".repeat(16) }] });
    expect(without.state).toEqual(drawn!);
    expect(without.directory).toEqual(withList.directory);
    expect(asked).toEqual(sent);
  });

  it("draws the PCs its list holds for a device that is in it, from the first draw on, and again when the list moves", async () => {
    await signIn("acct-one");
    const keys = [generateKeyPair().publicKey, generateKeyPair().publicKey, generateKeyPair().publicKey];
    const [held, rogue, unreached] = keys.map((key) => ({ endpoint: Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join(""), server_id: deriveServerId(key) }));
    const routed = (pc: { endpoint: string; server_id: string }): DirectoryPc => ({ ...row(pc.server_id), label: "The service's name", public_key: pc.endpoint, relay: "wss://relay.test", last_seen_at: new Date().toISOString() });
    directory = [routed(held!), routed(rogue!)];
    const listed = (pc: { endpoint: string; server_id: string }, label: string) => ({ ...pc, how: "added" as const, allows: true, name: { label, os: null }, seq: 1, by: null, new_at: null });
    const { list, heard } = recordingList();
    let view: AccountListView = { account: "acct-one", reached: true, status: { at: "following", list: "5c".repeat(32), standing: "in", head: 2, read_at: 1, trouble: null }, devices: [], pcs: [listed(held!, "Desk")] };
    // the list is read from this device's own store and the account service: it answers after the directory does
    let read = false;
    list.view = () => read ? view : OFF;
    list.sync = async () => { await settle(); read = true; return view; };
    list.follows = async () => true;
    const drawn: string[][] = [];
    const account = controller(list, () => { const { state } = account; if (state?.kind === "signed-in" && state.pcs !== null) drawn.push(state.pcs.map((pc) => pc.server_id)); });
    await account.refresh(true);
    await settle();
    // never drawn by the account service's word alone: from the first draw on, the PC that only the directory names is marked
    expect(drawn.length).toBeGreaterThan(0);
    const marks = (pcs: readonly { server_id: string; byList?: true; notInList?: true }[]) => pcs.map((pc) => [pc.server_id, pc.byList === true ? "list" : pc.notInList === true ? "outside" : "plain"]);
    const rowsNow = () => marks((account.state as { pcs: { server_id: string; byList?: true; notInList?: true }[] }).pcs);
    expect(drawn.every((rows) => rows.length === 2)).toBe(true);
    expect(rowsNow().sort()).toEqual([[held!.server_id, "list"], [rogue!.server_id, "outside"]].sort());
    expect((account.state as { pcs: { server_id: string }[] }).pcs.find((pc) => pc.server_id === held!.server_id)).toMatchObject({ name: "Desk", byList: true, accountOpen: true, join: { relay: "wss://relay.test" } });
    expect((account.state as { list?: string }).list).toBeUndefined();
    // the list moved: a PC came in that the account service does not say how to reach
    view = { ...view, pcs: [...view.pcs, listed(unreached!, "Laptop")] };
    for (const tell of heard) tell();
    await settle();
    const laptop = (account.state as { pcs: { server_id: string; name: string; byList?: true; join?: unknown }[] }).pcs.find((pc) => pc.server_id === unreached!.server_id)!;
    expect([laptop.name, laptop.byList, laptop.join]).toEqual(["Laptop", true, undefined]);
    // put out of the list, this device goes by the account service's directory again, as a device of an account with no list does
    view = { ...view, status: { at: "following", list: "5c".repeat(32), standing: "out", head: 3, read_at: 1, trouble: null }, pcs: [] };
    for (const tell of heard) tell();
    await settle();
    expect(rowsNow().sort()).toEqual([[held!.server_id, "plain"], [rogue!.server_id, "plain"]].sort());
    // a copy that only a newer app reads: the directory's PCs, every one marked, and the view says why
    view = { ...view, status: { at: "newer_save" }, pcs: [] };
    for (const tell of heard) tell();
    await settle();
    expect([rowsNow().sort(), (account.state as { list?: string }).list]).toEqual([[[held!.server_id, "outside"], [rogue!.server_id, "outside"]].sort(), "newer"]);
    // read again, the line goes
    view = { ...view, status: { at: "following", list: "5c".repeat(32), standing: "in", head: 4, read_at: 1, trouble: null }, pcs: [listed(held!, "Desk")] };
    for (const tell of heard) tell();
    await settle();
    expect((account.state as { list?: string }).list).toBeUndefined();
  });

  it("asks the PC a member just let it in at for its place in the list, and takes the first one it is handed", async () => {
    await signIn("acct-one");
    const { list, calls } = recordingList();
    const waiting: AccountListView = { account: "acct-one", status: { at: "not_in", list: "5c".repeat(32), why: "not_mine", claim: "claimed" }, reached: true, devices: [], pcs: [] };
    let view = waiting;
    list.view = () => view;
    list.adopt = async (offer) => { calls.push(`adopt ${offer.list} ${offer.seq} ${offer.hash}`); view = OFF; return OFF; };
    const account = controller(list);
    const asked: string[] = [];
    const answers: unknown[] = [{ pcs: [] }, { pcs: [], list: { id: "5c".repeat(32), seq: 4, hash: "ab".repeat(32) } }];
    const opened = { server: { features: [] }, fetch: async (path: string) => { asked.push(path); return Response.json(answers.shift() ?? { pcs: [] }); }, close() {} } as unknown as RelayTransport;
    const timers = useFakeWaits();
    try {
      await account.enroll(opened, "a1".repeat(16), true, true);
      await settle();
      expect(calls.filter((call) => call.startsWith("adopt"))).toEqual([]);
      await timers.next();
      await settle();
    } finally { timers.restore(); }
    expect(asked).toEqual(["/api/account/introduction", "/api/account/introduction"]);
    expect(calls.filter((call) => call.startsWith("adopt"))).toEqual([`adopt ${"5c".repeat(32)} 4 ${"ab".repeat(32)}`]);
  });

  it("asks a PC for no place where the device does not wait to be let into a list, or the pairing was made with a code", async () => {
    await signIn("acct-one");
    const { list, calls } = recordingList();
    const account = controller(list);
    const asked: string[] = [];
    const opened = { server: { features: [] }, fetch: async (path: string) => { asked.push(path); return Response.json({ pcs: [], list: { id: "5c".repeat(32), seq: 4, hash: "ab".repeat(32) } }); }, close() {} } as unknown as RelayTransport;
    // it follows no list and waits for none
    await account.enroll(opened, "a1".repeat(16), true, true);
    // it waits, and the pairing is not one a member's approval made
    list.view = () => ({ account: "acct-one", status: { at: "not_in", list: "5c".repeat(32), why: "not_mine", claim: "claimed" }, reached: true, devices: [], pcs: [] });
    await account.enroll(opened, "a1".repeat(16), true, false);
    await settle();
    expect([asked, calls.filter((call) => call.startsWith("adopt"))]).toEqual([[], []]);
  });

  it("follows no list where a test gives its own account store or fetch and no list", async () => {
    await signIn("acct-one");
    const account = controller();
    await account.refresh(true);
    await settle();
    expect(asked.filter((path) => path.startsWith("/v2/"))).toEqual([]);
  });
});

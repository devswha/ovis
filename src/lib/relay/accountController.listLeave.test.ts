import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { listView } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { listWorld, type WorldDevice } from "../account/accountList.test-helpers.ts";
import { allowDevice } from "../account/listAllow.ts";
import { accountList } from "../account/accountList.ts";
import { removeFromList } from "../account/listRemoveDevice.ts";
import { memoryListLock } from "../account/listStore.ts";
import { createAccountController } from "./accountController.ts";
import type { ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";

const empty: ShellDeviceStore = {
  get: async () => undefined, list: async () => [],
  remove: async () => {}, removeRow: async () => false,
  update: async () => { throw new Error("No pairing is made here"); },
};
const kinds = (texts: readonly string[]): string[] => texts.map((text) => readBody(entryFromText(text).body).kind);
const noWait = { wait: async () => {} };

/** Waits a bounded while for what the controller started by itself. */
async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let turns = 0; turns < 400; turns += 1) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("it did not happen");
}

/** An account whose first device let a second in; the second is the page under test. */
async function twoDevices() {
  // the shell judges its sign-in by the real clock: the world starts now
  const w = listWorld("acct_owner", Date.now());
  const first = await w.device({ label: "Dana's phone" });
  await first.list.sync();
  const second = await w.device({ label: "Dana's tablet" });
  await second.list.sync();
  const offer = await allowDevice(first.list, { key: (await second.keys()).key, label: "Dana's tablet", os: "android" }, noWait);
  if (!offer.allowed) throw new Error(offer.why);
  await second.list.adopt(offer.offer);
  return { w, first, second };
}

describe("the hosted shell and a device's place in its account's signed list", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  beforeEach(() => { browser = createShellTestPage(); });
  afterEach(() => browser.dispose());

  /** What the shells under test asked of the account service, as `METHOD path`. */
  let asked: string[] = [];
  /** The account service ended this device's sign-in: its directory answers 401 (a linked device the list put out). */
  let directoryEnded = false;
  beforeEach(() => { asked = []; directoryEnded = false; });
  /** The shell of `device`'s page: its account store and its list (`list`: another page's view of it); the directory the shell reads is empty. */
  const shellOf = (device: WorldDevice, list = device.list) => createAccountController({
    container: Object.create(null), entryUrl: "https://app.ovis.sh/", store: empty, accountStore: device.store, accountService: device.session.service,
    accountFetch: async (input, init) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      asked.push(`${request.method} ${pathname}`);
      if (pathname === "/v1/pcs") return directoryEnded ? Response.json({ error: { code: "unauthorized", message: "Signed out" } }, { status: 401 }) : Response.json({ pcs: [] });
      if (pathname === "/v1/signout/all") return new Response(null, { status: 204 });
      return Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 });
    },
    renderApp: () => ({ render() {}, unmount() {} }),
    accountList: list,
  }, { active: () => true, changed: async () => {}, outdated: () => new Set() });

  it("a device in the list puts itself out at sign-out, then forgets its account key, its encryption key and its copy", async () => {
    const { w, second } = await twoDevices();
    const shell = shellOf(second);
    await shell.refresh(true);
    const own = (await second.keys()).key;
    shell.signOut();
    await until(async () => (await second.lists.get("copy", w.account)) === undefined);
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove"]);
    expect(readBody(entryFromText(w.held().entries[2]!).body).ends).toBe(own);
    expect([await second.store.get("session"), await second.store.get("enc_key")]).toEqual([undefined, undefined]);
    expect((await second.keys()).key).not.toBe(own);
    expect(shell.state).toEqual({ kind: "signed-out", error: null });
  });

  it("signs out all the same where the list does not take its removal, forgets its key, and says that the account still lists it", async () => {
    const { w, second } = await twoDevices();
    const shell = shellOf(second);
    await shell.refresh(true);
    w.fake.tamperList(w.held().id, { stopped: true });
    const own = (await second.keys()).key;
    shell.signOut();
    await until(() => shell.state?.kind === "signed-out" && shell.state.error !== null);
    expect(shell.state).toEqual({ kind: "signed-out", error: "The account service cannot change the list right now. To remove a device, use Revoke on each PC." });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
    expect((await second.keys()).key).not.toBe(own);
  });

  it("a device another member removed forgets its key and its sign-in, and says why", async () => {
    const { w, first, second } = await twoDevices();
    const shell = shellOf(second);
    await shell.refresh(true);
    const own = (await second.keys()).key;
    expect(await removeFromList(first.list, { keys: [own], pcs: [] }, noWait)).toEqual({ removed: true });
    await second.list.sync();
    await until(() => shell.state?.kind === "signed-out");
    await until(async () => (await second.lists.get("copy", w.account)) === undefined);
    expect(shell.state).toEqual({ kind: "signed-out", error: null, notice: "This device was removed from your account. To use it again, sign in and allow it from another device." });
    expect(await second.store.get("session")).toBeUndefined();
    expect((await second.keys()).key).not.toBe(own);
  });

  it("a device that leaves puts itself out of the list before anything else, and stays in it when the list cannot take that", async () => {
    const { w, second } = await twoDevices();
    const shell = shellOf(second);
    await shell.refresh(true);
    w.fake.tamperList(w.held().id, { stopped: true });
    expect(await shell.leave()).toEqual({ left: false, message: "The account service cannot change the list right now. To remove a device, use Revoke on each PC." });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
    expect(await second.store.get("session")).toBeDefined();
  });

  it("sign out every device on a list account puts every other device out of the list first, then signs out", async () => {
    const { w, first, second } = await twoDevices();
    const shell = shellOf(first);
    await shell.refresh(true);
    await first.list.sync();
    const other = (await second.keys()).key;
    await shell.signOutEverywhere();
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove", "epoch"]);
    expect(readBody(entryFromText(w.held().entries[2]!).body).ends).toBe(other);
    expect(asked).toContain("POST /v1/signout/all");
  });

  it("sign out every device keeps this device's key and its place in the list, opens nothing by the list while signed out, and needs no Allow after signing in again", async () => {
    const { w, first } = await twoDevices();
    const shell = shellOf(first);
    await shell.refresh(true);
    await first.list.sync();
    const key = (await first.keys()).key;
    const enc = (await first.keys()).enc.key;
    expect(shell.listKey?.public_spki).toBe(key);
    await shell.signOutEverywhere();
    // signed out, still the one member the person holds: its key, its encryption key and its copy of the list stay
    expect(await first.store.get("session")).toBeUndefined();
    expect([(await first.keys()).key, (await first.keys()).enc.key]).toEqual([key, enc]);
    expect(await first.lists.get("copy", w.account)).toBeDefined();
    expect(listView(w.held().state).devices.filter((row) => row.ended === null).map((row) => row.key)).toEqual([key]);
    // while signed out the list opens no PC: there is no member key to open with
    await first.list.sync().catch(() => undefined);
    expect([shell.listKey, first.list.view().status]).toEqual([null, { at: "off" }]);
    // a new sign-in on it: the same member, in the list at once, with no Allow and no claim
    const again = { ...first.session, access_token: w.fake.issueToken(w.account), sign_in_id: "sign-in-again", signed_in_at: w.clock.now };
    await first.store.set("session", again);
    const view = await first.list.sync();
    expect(view.status).toMatchObject({ at: "following", standing: "in" });
    expect(view.devices.filter((row) => row.self).map((row) => row.key)).toEqual([key]);
    expect(first.sent.filter((each) => each.route.startsWith("POST ") && each.route.endsWith("/claims"))).toEqual([]);
    await shell.refresh(true);
    expect(shell.listKey?.public_spki).toBe(key);
  });

  it("sign out every device signs nobody out where the list does not take the removal, and says so", async () => {
    const { w, first } = await twoDevices();
    const shell = shellOf(first);
    await shell.refresh(true);
    await first.list.sync();
    w.fake.tamperList(w.held().id, { stopped: true });
    asked = [];
    expect(await shell.signOutEverywhere()).toBe("The account service cannot change the list right now. To remove a device, use Revoke on each PC.");
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
    expect(asked).not.toContain("POST /v1/signout/all");
    expect(await first.store.get("session")).toBeDefined();
  });

  it("sign out every device signs nobody out while a request signed for an Allow waits at this head, and says an earlier change waits", async () => {
    const { w, first } = await twoDevices();
    const shell = shellOf(first);
    await shell.refresh(true);
    const laptop = await w.device({ label: "Laptop" });
    await laptop.list.sync();
    w.fake.tamperList(w.held().id, { headMoved: true });
    expect(await allowDevice(first.list, { key: (await laptop.keys()).key, label: "Laptop", os: "android" }, noWait)).toMatchObject({ allowed: false, why: "busy" });
    w.fake.untamperList(w.held().id);
    await first.list.sync();
    asked = [];
    expect(await shell.signOutEverywhere()).toBe("An earlier change is still waiting: try it again or cancel it first.");
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
    expect(asked).not.toContain("POST /v1/signout/all");
  });

  it("sign out every device says how many left when a device came in between the parts of the removal, and signs nobody out", async () => {
    const { w, first, second } = await twoDevices();
    const others = [second];
    for (let index = 0; index < 15; index += 1) {
      const device = await w.device({ label: `Tablet ${index + 1}` });
      await device.list.sync();
      const offer = await allowDevice(first.list, { key: (await device.keys()).key, label: `Tablet ${index + 1}`, os: "android" }, noWait);
      if (!offer.allowed) throw new Error(offer.why);
      await device.list.adopt(offer.offer);
      others.push(device);
    }
    const shell = shellOf(first);
    await shell.refresh(true);
    await first.list.sync();
    // once the first part is placed, the last device of the account lets a newcomer in before this device reads its part back
    let placed = 0;
    first.wire.answer = async (request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/entries") || placed++ > 0) return null;
      const answered = await w.fake.fetch(request);
      const newcomer = await w.device({ label: "Newcomer" });
      await newcomer.list.sync();
      const last = others.at(-1)!;
      await last.list.sync();
      const offer = await allowDevice(last.list, { key: (await newcomer.keys()).key, label: "Newcomer", os: "android" }, noWait);
      if (!offer.allowed) throw new Error(offer.why);
      return answered;
    };
    asked = [];
    expect(await shell.signOutEverywhere()).toBe("15 of 16 other devices left your account, then Newcomer came in since you asked. Ask again to go on.");
    expect(asked).not.toContain("POST /v1/signout/all");
  });

  it("M3: a sign-out on a page that cannot read its own list store forgets nothing it cannot see, and says so", async () => {
    const { w, second } = await twoDevices();
    const page = accountList({ service: second.service, accountStore: second.store, listStore: second.lists, lock: memoryListLock(), now: () => w.clock.now });
    const unread = { ...page, follows: async (): Promise<boolean> => { throw new DOMException("The store did not open", "UnknownError"); } };
    const shell = shellOf(second, unread);
    const own = (await second.keys()).key;
    shell.signOut();
    await until(() => shell.state?.kind === "signed-out" && shell.state.error !== null);
    expect(shell.state).toEqual({ kind: "signed-out", error: "This device signed out, but it could not read what it keeps of your account's list, so your account may still list it." });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
    expect((await second.keys()).key).toBe(own);
    expect(await second.lists.get("copy", w.account)).toBeDefined();
  });

  it("M3: sign out every device does not go on where this device cannot read its own list store", async () => {
    const { w, first } = await twoDevices();
    const unread = { ...first.list, view: () => ({ ...first.list.view(), account: null, status: { at: "off" as const } }), follows: async (): Promise<boolean> => { throw new DOMException("The store did not open", "UnknownError"); } };
    const shell = shellOf(first, unread);
    await shell.refresh(true);
    asked = [];
    expect(await shell.signOutEverywhere()).toBe("No device was signed out: the other devices could not be removed from your account. Try again.");
    expect(asked).not.toContain("POST /v1/signout/all");
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
  });

  it("M1: a sign-out whose own removal no read could show finishes here, and says the account may still list this device", async () => {
    const { w, second } = await twoDevices();
    const shell = shellOf(second);
    await shell.refresh(true);
    const own = (await second.keys()).key;
    let ended = false;
    second.wire.answer = (request) => {
      if (ended) return Response.json({ error: { code: "unauthorized", message: "Signed out" } }, { status: 401 });
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")) ended = true;
      return null;
    };
    shell.signOut();
    await until(() => shell.state?.kind === "signed-out" && shell.state.error !== null);
    expect(shell.state).toEqual({ kind: "signed-out", error: "This device signed out. Whether your account still lists it is not known yet: check its devices from another device." });
    await until(async () => (await second.lists.get("copy", w.account)) === undefined);
    expect((await second.keys()).key).not.toBe(own);
  });

  it("M1: a leave whose own removal no read could show finishes here, and says the account may still list this device", async () => {
    const { w, second } = await twoDevices();
    const shell = shellOf(second);
    await shell.refresh(true);
    const own = (await second.keys()).key;
    let ended = false;
    second.wire.answer = (request) => {
      if (ended) return Response.json({ error: { code: "unauthorized", message: "Signed out" } }, { status: 401 });
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")) ended = true;
      return null;
    };
    directoryEnded = true;
    expect(await shell.leave()).toEqual({ left: true, message: "This device left the account. Whether your account still lists it is not known yet: check its devices from another device." });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove"]);
    expect((await second.keys()).key).not.toBe(own);
    expect(await second.lists.get("copy", w.account)).toBeUndefined();
  });

  it("Codex 6: a leave whose own removal counted finishes on this device when the account service ended its sign-in with it", async () => {
    const { w, second } = await twoDevices();
    const shell = shellOf(second);
    await shell.refresh(true);
    const own = (await second.keys()).key;
    // the service signs a linked device out in the removal's own transaction: what comes after needs a sign-in it no longer has
    second.wire.answer = (request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")) directoryEnded = true;
      return null;
    };
    expect((await shell.leave()).left).toBe(true);
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove"]);
    expect(await second.store.get("session")).toBeUndefined();
    expect((await second.keys()).key).not.toBe(own);
    expect(await second.lists.get("copy", w.account)).toBeUndefined();
  });

  it("Codex 6: a device another member removed while it was away reads its removal before its directory, which no longer answers it", async () => {
    const { w, first, second } = await twoDevices();
    const own = (await second.keys()).key;
    expect(await removeFromList(first.list, { keys: [own], pcs: [] }, noWait)).toEqual({ removed: true });
    // a new start of the app on the removed device: its directory read is refused, its list still reads
    directoryEnded = true;
    const page = accountList({ service: second.service, accountStore: second.store, listStore: second.lists, lock: memoryListLock(), now: () => w.clock.now });
    const shell = createAccountController({
      container: Object.create(null), entryUrl: "https://app.ovis.sh/", store: empty, accountStore: second.store, accountService: second.session.service,
      accountFetch: async (input, init) => {
        const { pathname } = new URL(new Request(input, init).url);
        return pathname === "/v1/pcs" ? Response.json({ error: { code: "unauthorized", message: "Signed out" } }, { status: 401 }) : Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 });
      },
      renderApp: () => ({ render() {}, unmount() {} }),
      accountList: page,
    }, { active: () => true, changed: async () => {}, outdated: () => new Set() });
    await shell.refresh(true);
    await until(() => shell.state?.kind === "signed-out" && shell.state.notice !== undefined);
    expect(shell.state).toEqual({ kind: "signed-out", error: null, notice: "This device was removed from your account. To use it again, sign in and allow it from another device." });
    expect((await second.keys()).key).not.toBe(own);
  });

  it("Codex 7: sign out every device asks again, and signs nobody out, when a device came in that its question did not name", async () => {
    const { w, first, second } = await twoDevices();
    const shell = shellOf(first);
    await shell.refresh(true);
    await first.list.sync();
    const named = [(await second.keys()).key];
    // a member lets another device in after the question was drawn
    const third = await w.device({ label: "Kitchen tablet" });
    await third.list.sync();
    const offer = await allowDevice(second.list, { key: (await third.keys()).key, label: "Kitchen tablet", os: "android" }, noWait);
    expect(offer.allowed).toBe(true);
    asked = [];
    const said = await shell.signOutEverywhere(undefined, named);
    expect(said).toBe("Kitchen tablet came into your account since you asked. Nobody was signed out: ask again.");
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "device"]);
    expect(asked).not.toContain("POST /v1/signout/all");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { listWorld, type WorldDevice } from "../account/accountList.test-helpers.ts";
import { allowDevice } from "../account/listAllow.ts";
import { removeFromList } from "../account/listRemove.ts";
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
  const w = listWorld();
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

  /** The shell of `device`'s page: its account store and its list; the directory the shell reads is empty. */
  const shellOf = (device: WorldDevice) => createAccountController({
    container: Object.create(null), entryUrl: "https://app.ovis.sh/", store: empty, accountStore: device.store, accountService: device.session.service,
    accountFetch: async (input) => (new URL(new Request(input).url).pathname === "/v1/pcs" ? Response.json({ pcs: [] }) : Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 })),
    renderApp: () => ({ render() {}, unmount() {} }),
    accountList: device.list,
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
});

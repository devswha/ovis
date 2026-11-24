import { describe, expect, it } from "bun:test";
import { signListEntry } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { allowDevice } from "./listAllow.ts";
import { deviceListKeys } from "./listKeys.ts";
import { forgetMembership, inList, leaveList, tidyOnRead, watchRemoval } from "./listLeave.ts";
import { removeFromList } from "./listRemoveDevice.ts";
import { memoryAccountStore } from "./store.ts";

type World = ReturnType<typeof listWorld>;
const noWait = { wait: async () => {} };
const kinds = (texts: readonly string[]): string[] => texts.map((text) => readBody(entryFromText(text).body).kind);
const placements = (from: WorldDevice) => from.sent.filter((each) => each.route.endsWith("/entries"));

async function twoDevices(w: World = listWorld()) {
  const first = await w.device({ label: "Dana's phone" });
  await first.list.sync();
  const second = await w.device({ label: "Dana's tablet" });
  await second.list.sync();
  const offer = await allowDevice(first.list, { key: (await second.keys()).key, label: "Dana's tablet", os: "android" }, noWait);
  if (!offer.allowed) throw new Error(offer.why);
  await second.list.adopt(offer.offer);
  return { w, first, second };
}

/** Waits a bounded while for what a listener started. */
async function settle(done: () => boolean): Promise<void> {
  for (let turns = 0; turns < 200 && !done(); turns += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("a device that signs out or leaves", () => {
  it("puts itself out of the list, then forgets its account key and its copy: it comes back only as a new member", async () => {
    const { w, second } = await twoDevices();
    const before = await second.keys();
    expect(await leaveList(second.list, w.account, noWait)).toEqual({ removed: true });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove"]);
    expect(readBody(entryFromText(w.held().entries[2]!).body).ends).toBe(before.key);
    await forgetMembership(second.store, second.list, second.session);
    expect([await second.store.get("session"), await second.lists.get("copy", w.account), await second.store.get("enc_key")]).toEqual([undefined, undefined, undefined]);
    const after = await second.keys();
    expect([after.key === before.key, after.enc.key === before.enc.key]).toEqual([false, false]);
    expect(second.list.view().status).toEqual({ at: "off" });
  });

  it("a borrowed browser, which may remove nobody else, puts itself out at sign-out", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const browser = await w.device({ label: "Library browser" });
    await browser.list.sync();
    // the first device lets it in for a day: power bound, role drive, until a day from now
    await first.list.sync();
    const writer = first.list.writer()!;
    const own = await browser.keys();
    const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key === own.key)!;
    const placed = await signListEntry(writer.state, { kind: "device", key: claim.key, power: "bound", role: "drive", until: writer.issued_at + 86_400, enc: claim.enc, card: claim.card, sealed: null, rotates: false },
      { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
    await writer.service.placeEntries(writer.list, [placed.text], []);
    await browser.list.adopt({ list: w.held().id, seq: 1, hash: w.held().head.hash });
    expect(browser.list.writer()).toBeNull();
    expect(await leaveList(browser.list, w.account, noWait)).toEqual({ removed: true });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove"]);
    expect(readBody(entryFromText(w.held().entries[2]!).body).ends).toBe(own.key);
  });

  it("asks nothing of the list for an account that has none, and keeps its key", async () => {
    const w = listWorld();
    w.fake.listAccounts = "";
    const device = await w.device({ label: "Phone" });
    await device.list.sync();
    const key = (await device.keys()).key;
    expect(await leaveList(device.list, w.account, noWait)).toBeNull();
    expect(placements(device)).toHaveLength(0);
    expect((await device.keys()).key).toBe(key);
  });

  it("asks nothing of a list it has not read on this page", async () => {
    const { w, second } = await twoDevices();
    const page = { ...second.list, view: () => ({ account: null, status: { at: "off" as const }, reached: true, devices: [], pcs: [] }) };
    const sent = placements(second).length;
    expect(await leaveList(page, w.account, noWait)).toBeNull();
    expect(placements(second)).toHaveLength(sent);
  });

  it("says why when the list cannot take its removal, and is still in it", async () => {
    const { w, second } = await twoDevices();
    w.fake.tamperList(w.held().id, { stopped: true });
    expect(await leaveList(second.list, w.account, noWait)).toEqual({ removed: false, why: "stopped", retryAfterMs: null });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
  });
});

describe("a device that another member removed", () => {
  it("hears it once from its own copy, and not for a view that shows it in", async () => {
    const { w, first, second } = await twoDevices();
    const heard: string[] = [];
    const stop = watchRemoval(second.list, (account) => heard.push(account));
    await second.list.sync();
    expect(heard).toEqual([]);
    expect(await removeFromList(first.list, { keys: [(await second.keys()).key], pcs: [] }, noWait)).toEqual({ removed: true });
    await second.list.sync();
    w.clock.now += 60_000;
    await second.list.sync();
    expect(heard).toEqual([w.account]);
    stop();
    expect(inList(second.list.view(), w.account)).toBe(false);
  });
});

describe("tidying while the list is read", () => {
  it("ends an invite that is past its time after a read, once, with nobody asking", async () => {
    const { w, first } = await twoDevices();
    const keys = await first.keys();
    const invite = await deviceListKeys(memoryAccountStore());
    const at = Math.floor(w.clock.now / 1000);
    const placed = await signListEntry(w.held().state, { kind: "invite", key: invite.key, exp: at + 900, uses: 1, auto: true, sealed: null }, { key: keys.key, privateKey: keys.signs }, at);
    await first.service.placeEntries(w.held().id, [placed.text], []);
    const stop = tidyOnRead(first.list);
    await first.list.sync();
    expect(kinds(w.held().entries).at(-1)).toBe("invite");
    w.clock.now += 16 * 60_000;
    await first.list.sync();
    await settle(() => kinds(w.held().entries).at(-1) === "epoch");
    expect(kinds(w.held().entries).slice(-3)).toEqual(["invite", "remove", "epoch"]);
    const sent = placements(first).length;
    w.clock.now += 60_000;
    await first.list.sync();
    await settle(() => false);
    expect(placements(first)).toHaveLength(sent);
    stop();
  });
});

import { describe, expect, it } from "bun:test";
import { kindBody, LIST_LEVEL, listView, replayList, signCard, signListEntry, type ListState } from "../../../shared/account-list.ts";
import { entryFromText, entryToText, readBody, signEntry } from "../../../shared/account-list-entry.ts";
import type { AccountListView, ListWriter } from "./accountList.ts";
import { askingPc, listWorld, postPcKeys, type WorldDevice } from "./accountList.test-helpers.ts";
import { allowDevice, type AllowOutcome } from "./listAllow.ts";
import { deviceListKeys, type DeviceListKeys } from "./listKeys.ts";
import {
  cameInThrough, overdueKeys, REMOVE_RESENDS, REMOVE_TRIES, removalRequest, removeFromList, removeSelf, tidyList,
  type RemoveOutcome,
} from "./listRemove.ts";
import { memoryAccountStore } from "./store.ts";

type World = ReturnType<typeof listWorld>;

const following = (view: AccountListView) => {
  if (view.status.at !== "following") throw new Error(`the device is ${view.status.at}`);
  return view.status;
};
const allowed = (outcome: AllowOutcome) => {
  if (!outcome.allowed) throw new Error(`the device was not let in: ${outcome.why}`);
  return outcome.offer;
};
const placements = (from: WorldDevice) => from.sent.filter((each) => each.route.endsWith("/entries"));
const kinds = (texts: readonly string[]): string[] => texts.map((text) => readBody(entryFromText(text).body).kind);
const ends = (text: string): unknown => readBody(entryFromText(text).body).ends;
const noWait = { wait: async () => {} };
const REMOVED: RemoveOutcome = { removed: true };

/** A device of the world let into the list by `by`, which then follows it. */
async function letIn(w: World, by: WorldDevice, label: string): Promise<WorldDevice> {
  const device = await w.device({ label });
  await device.list.sync();
  const offer = allowed(await allowDevice(by.list, { key: (await device.keys()).key, label, os: "android" }, noWait));
  expect(following(await device.list.adopt(offer)).standing).toBe("in");
  return device;
}

/** An account whose first device started its list and let a second in. */
async function twoDevices(w: World = listWorld()) {
  const first = await w.device({ label: "Dana's phone" });
  expect(following(await first.list.sync()).standing).toBe("in");
  const second = await letIn(w, first, "Dana's tablet");
  return { w, first, second };
}

/** `by` adds a PC: the account lists it, it posts its keys, and `by` signs its `pc` entry. */
async function addPc(w: World, by: WorldDevice) {
  const pc = await askingPc();
  const card = await postPcKeys(w.fake.fetch, w.origin, by.session.access_token, pc, w.held().id);
  const keys = await by.keys();
  const added = await signListEntry(w.held().state, { kind: "pc", key: pc.key, endpoint: pc.endpoint, enc: pc.enc, card, sealed: null }, { key: keys.key, privateKey: keys.signs }, Math.floor(w.clock.now / 1000));
  await by.service.placeEntries(w.held().id, [added.text], []);
  return pc;
}

/** `by` places an invite whose `exp` is `seconds` ahead. */
async function placeInvite(w: World, by: WorldDevice, given: { readonly auto: boolean; readonly seconds?: number }): Promise<string> {
  const keys = await by.keys();
  const invite = await deviceListKeys(memoryAccountStore());
  const at = Math.floor(w.clock.now / 1000);
  const placed = await signListEntry(w.held().state, { kind: "invite", key: invite.key, exp: at + (given.seconds ?? 900), uses: 1, auto: given.auto, sealed: null }, { key: keys.key, privateKey: keys.signs }, at);
  await by.service.placeEntries(w.held().id, [placed.text], []);
  return invite.key;
}

describe("a device that is in the list puts another out", () => {
  it("signs a remove of its key and the next epoch in one request, wrapped to whoever stays, and the removed device sees itself out", async () => {
    const { w, first, second } = await twoDevices();
    const gone = (await second.keys()).key;
    expect(await removeFromList(first.list, { keys: [gone], pcs: [] }, noWait)).toEqual(REMOVED);
    const list = w.held();
    expect(kinds(list.entries)).toEqual(["genesis", "device", "remove", "epoch"]);
    expect(ends(list.entries[2]!)).toBe(gone);
    expect(placements(first).at(-1)!.body!.entries).toHaveLength(2);
    // the new epoch's key goes to the first device alone
    const wraps = placements(first).at(-1)!.body!.wraps as { member: string; epoch: number }[];
    expect(wraps.map((wrap) => [wrap.member, wrap.epoch])).toEqual([[(await first.keys()).enc.key, 1]]);
    expect(list.state.epoch).toBe(1);
    // the first device lists itself alone, by its name, which it still opens through the new epoch's key
    expect((await first.list.sync()).devices.map((row) => [row.self, row.name?.label])).toEqual([[true, "Dana's phone"]]);
    // the removed device reads its own removal, and lists nobody
    const out = await second.list.sync();
    expect([following(out).standing, out.devices]).toEqual(["out", []]);
  });

  it("never lets the key back in: an Allow of the same key is refused, and nothing is signed", async () => {
    const { w, first, second } = await twoDevices();
    const gone = await second.keys();
    expect(await removeFromList(first.list, { keys: [gone.key], pcs: [] }, noWait)).toEqual(REMOVED);
    const entries = w.held().entries.length;
    expect(await allowDevice(first.list, { key: gone.key, label: "Dana's tablet", os: "android" }, noWait)).toMatchObject({ allowed: false, why: "removed" });
    expect(w.held().entries).toHaveLength(entries);
  });

  it("answers removed for a key that is out already, and places nothing", async () => {
    const { w, first, second } = await twoDevices();
    const gone = (await second.keys()).key;
    expect(await removeFromList(first.list, { keys: [gone], pcs: [] }, noWait)).toEqual(REMOVED);
    const sent = placements(first).length;
    expect(await removeFromList(first.list, { keys: [gone], pcs: [] }, noWait)).toEqual(REMOVED);
    expect([placements(first).length, w.held().entries.length]).toEqual([sent, 4]);
  });

  it("puts a PC out with what it came in through, and tells the account service no name", async () => {
    const { w, first, second } = await twoDevices();
    const pc = await addPc(w, second);
    expect(await removeFromList(first.list, { keys: [(await second.keys()).key], pcs: [pc.endpoint] }, noWait)).toEqual(REMOVED);
    const list = w.held();
    expect(kinds(list.entries).slice(-3)).toEqual(["remove", "remove", "epoch"]);
    expect(listView(list.state).pcs.map((row) => row.removed !== null)).toEqual([true]);
    expect(JSON.stringify(first.sent)).not.toContain("tablet");
  });

  it("is refused for a device of power full that is not in the list, and a device that follows none", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Phone" });
    await first.list.sync();
    const stranger = await w.device({ label: "Stranger" });
    await stranger.list.sync();
    expect(await removeFromList(stranger.list, { keys: [(await first.keys()).key], pcs: [] }, noWait)).toEqual({ removed: false, why: "no_list", retryAfterMs: null });
    expect(placements(stranger)).toHaveLength(0);
  });
});

describe("what came in through a key", () => {
  it("is everything that key let in, and whatever those let in in turn, in the order it came", async () => {
    const { w, first, second } = await twoDevices();
    const third = await letIn(w, second, "Laptop");
    const fourth = await letIn(w, third, "Desk browser");
    const pc = await addPc(w, second);
    const [k2, k3, k4] = await Promise.all([second.keys(), third.keys(), fourth.keys()]).then((all) => all.map((keys) => keys.key));
    const state = w.held().state;
    expect(cameInThrough(state, k2!, (await first.keys()).key)).toEqual([
      { kind: "device", key: k3!, seq: 2, via: k2! },
      { kind: "device", key: k4!, seq: 3, via: k3! },
      { kind: "pc", endpoint: pc.endpoint, seq: 4, via: k2! },
    ]);
  });

  it("leaves out this device and what came in through it, and what is out already", async () => {
    const { w, first, second } = await twoDevices();
    const third = await letIn(w, second, "Laptop");
    const fourth = await letIn(w, third, "Desk browser");
    const [k1, k2, k3] = await Promise.all([first.keys(), second.keys(), third.keys()]).then((all) => all.map((keys) => keys.key));
    // from the third device, which the second let in: it trusts itself, and what it let in
    expect(cameInThrough(w.held().state, k2!, k3!)).toEqual([]);
    expect(await removeFromList(first.list, { keys: [(await fourth.keys()).key], pcs: [] }, noWait)).toEqual(REMOVED);
    expect(cameInThrough(w.held().state, k2!, k1!).map((arrival) => arrival.kind === "pc" ? arrival.endpoint : arrival.key)).toEqual([k3!]);
  });

  it("holds a PC that joined with an invite as come in through whoever placed the invite", async () => {
    const { w, first, second } = await twoDevices();
    const invite = await placeInvite(w, second, { auto: true });
    const state = w.held().state;
    // the invite itself goes void with its placer; no PC has joined with it yet
    expect(cameInThrough(state, (await second.keys()).key, (await first.keys()).key)).toEqual([]);
    expect(listView(state).invites.map((row) => [row.key, row.by])).toEqual([[invite, (await second.keys()).key]]);
  });

  it("names a key with no name that a member added, and a removal ends it", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Phone" });
    await first.list.sync();
    const keys = await first.keys();
    const nameless = await deviceListKeys(memoryAccountStore());
    // a member's entry that adds a key and whose kind does nothing (its card is another key's): the key is a signer
    // with no name, which nobody honest writes, and a person must still see and end it
    const list = w.held();
    const wrongCard = await signCard({ key: nameless.key, enc: nameless.enc.key, list: "00".repeat(32), endpoint: null, invite: null }, nameless.signs);
    const body = kindBody({ issued_at: Math.floor(w.clock.now / 1000), list: list.id, prev: list.head.hash, seq: 1, signer: keys.key },
      { kind: "device", key: nameless.key, power: "full", role: "drive", until: null, enc: nameless.enc.key, card: wrongCard, sealed: null, rotates: false });
    const entry = entryToText(await signEntry(body, keys.signs));
    const replayed = await replayList([...list.entries, entry], LIST_LEVEL, { saved: null, given: list.id });
    const state = replayed.member!.state;
    expect(listView(state).signers.map((row) => row.key)).toEqual([nameless.key]);
    expect(cameInThrough(state, keys.key, null)).toEqual([{ kind: "signer", key: nameless.key, seq: 1, via: keys.key }]);
    const writer = writerOn(state, keys, w.clock.now);
    const request = await removalRequest(writer, { keys: [nameless.key], pcs: [] }, { epoch: false, tidy: false });
    expect(request!.entries.map(ends)).toEqual([nameless.key]);
  });
});

/** A writer over a state this test made, for what is signed and never placed. */
function writerOn(state: ListState, keys: DeviceListKeys, now: number): ListWriter {
  const at = Math.floor(now / 1000);
  return { account: state.account, list: state.list, state, keys, epochs: new Map(), clock: at, issued_at: at, service: null as never };
}

describe("a list that moves, or a service that is busy, under a removal", () => {
  it("reads and signs again when the head moved under it, and puts the device out once", async () => {
    const { w, first, second } = await twoDevices();
    let raced = false;
    first.wire.answer = async (request) => {
      if (raced || request.method !== "POST" || !new URL(request.url).pathname.endsWith("/entries")) return null;
      raced = true;
      await addPc(w, first);
      return null;
    };
    expect(await removeFromList(first.list, { keys: [(await second.keys()).key], pcs: [] }, noWait)).toEqual(REMOVED);
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "pc", "remove", "epoch"]);
  });

  it("gives up after its tries where the head keeps moving, and says so", async () => {
    const { w, first, second } = await twoDevices();
    const before = w.held().entries.length;
    w.fake.tamperList(w.held().id, { headMoved: true });
    expect(await removeFromList(first.list, { keys: [(await second.keys()).key], pcs: [] }, noWait)).toEqual({ removed: false, why: "busy", retryAfterMs: null });
    expect([placements(first).length, w.held().entries.length]).toEqual([REMOVE_TRIES + 1, before]);
  });

  it("sends the same request again while the service rebuilds the list, the same signatures", async () => {
    const { w, first, second } = await twoDevices();
    const from = placements(first).length;
    w.fake.tamperList(w.held().id, { rebuilding: true });
    const waits: number[] = [];
    const outcome = await removeFromList(first.list, { keys: [(await second.keys()).key], pcs: [] }, { wait: async (ms) => { waits.push(ms); w.fake.untamperList(w.held().id); } });
    expect(outcome).toEqual(REMOVED);
    const sent = placements(first).slice(from);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
    expect(waits).toEqual([1000]);
  });

  it("gives up on a service that keeps rebuilding, and on one that cannot change the list, with nobody put out", async () => {
    const { w, first, second } = await twoDevices();
    const from = placements(first).length;
    const gone = (await second.keys()).key;
    w.fake.tamperList(w.held().id, { rebuilding: true });
    expect(await removeFromList(first.list, { keys: [gone], pcs: [] }, noWait)).toMatchObject({ removed: false, why: "busy" });
    expect(placements(first).length - from).toBe(REMOVE_RESENDS);
    w.fake.untamperList(w.held().id);
    w.fake.tamperList(w.held().id, { stopped: true });
    expect(await removeFromList(first.list, { keys: [gone], pcs: [] }, noWait)).toEqual({ removed: false, why: "stopped", retryAfterMs: null });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
  });

  it("does not take the account service's answer for the device being out: an answer with nothing placed puts nobody out", async () => {
    const { w, first, second } = await twoDevices();
    first.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")
      ? Response.json({ list: w.held().id, head: { seq: 3, hash: "ab".repeat(32) }, placed: 2, now: 1 }) : null;
    expect(await removeFromList(first.list, { keys: [(await second.keys()).key], pcs: [] }, noWait)).toEqual({ removed: false, why: "busy", retryAfterMs: null });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
  });

  it("says that the account service was not reached, and signs nothing more", async () => {
    const { first, second } = await twoDevices();
    first.wire.answer = (request) => (request.method === "POST" ? Promise.reject(new TypeError("offline")) : null);
    expect(await removeFromList(first.list, { keys: [(await second.keys()).key], pcs: [] }, noWait)).toMatchObject({ removed: false, why: "unreached" });
  });
});

describe("a device that puts itself out", () => {
  it("signs a remove of its own key and no epoch, and a device that stays opens the next one when it tidies", async () => {
    const { w, first, second } = await twoDevices();
    const own = (await second.keys()).key;
    expect(await removeSelf(second.list, () => second.list.writer(), noWait)).toEqual(REMOVED);
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove"]);
    expect(ends(w.held().entries[2]!)).toBe(own);
    // the first device sees nobody could seal under the current epoch, holds its key, and opens the next
    const tried = new Set<string>();
    await first.list.sync();
    expect(await tidyList(first.list, tried, noWait)).toEqual(REMOVED);
    expect(kinds(w.held().entries)).toEqual(["genesis", "device", "remove", "epoch"]);
    const wraps = placements(first).at(-1)!.body!.wraps as { member: string }[];
    expect(wraps.map((wrap) => wrap.member)).toEqual([(await first.keys()).enc.key]);
    expect(await tidyList(first.list, tried, noWait)).toBeNull();
  });
});

describe("tidying up what is over its time", () => {
  it("ends an invite a PC joins with by itself once it is past its exp unused, and opens the next epoch", async () => {
    const { w, first } = await twoDevices();
    const invite = await placeInvite(w, first, { auto: true });
    const tried = new Set<string>();
    await first.list.sync();
    expect(await tidyList(first.list, tried, noWait)).toBeNull();
    w.clock.now += 16 * 60_000;
    await first.list.sync();
    expect(await tidyList(first.list, tried, noWait)).toEqual(REMOVED);
    const list = w.held();
    expect(kinds(list.entries).slice(-2)).toEqual(["remove", "epoch"]);
    expect(ends(list.entries.at(-2)!)).toBe(invite);
    expect(await tidyList(first.list, tried, noWait)).toBeNull();
  });

  it("ends a plain invite past its exp, which held no key of the epoch, and opens none", async () => {
    const { w, first } = await twoDevices();
    const invite = await placeInvite(w, first, { auto: false });
    w.clock.now += 16 * 60_000;
    await first.list.sync();
    expect(await tidyList(first.list, new Set(), noWait)).toEqual(REMOVED);
    expect(kinds(w.held().entries).slice(-2)).toEqual(["invite", "remove"]);
    expect(ends(w.held().entries.at(-1)!)).toBe(invite);
  });

  it("tries an invite once, whatever the service answers", async () => {
    const { w, first } = await twoDevices();
    await placeInvite(w, first, { auto: true });
    w.clock.now += 16 * 60_000;
    await first.list.sync();
    w.fake.tamperList(w.held().id, { stopped: true });
    const tried = new Set<string>();
    expect(await tidyList(first.list, tried, noWait)).toMatchObject({ removed: false, why: "stopped" });
    const sent = placements(first).length;
    expect(await tidyList(first.list, tried, noWait)).toBeNull();
    expect(placements(first)).toHaveLength(sent);
  });

  it("goes with a removal: what is over its time leaves in the same request, before the epoch", async () => {
    const { w, first, second } = await twoDevices();
    const invite = await placeInvite(w, first, { auto: true });
    w.clock.now += 16 * 60_000;
    expect(overdueKeys(w.held().state, Math.floor(w.clock.now / 1000))).toEqual([invite]);
    expect(await removeFromList(first.list, { keys: [(await second.keys()).key], pcs: [] }, noWait)).toEqual(REMOVED);
    expect(kinds(w.held().entries).slice(-3)).toEqual(["remove", "remove", "epoch"]);
  });

  it("is nothing a device that is not full does", async () => {
    const { first } = await twoDevices();
    expect(await tidyList({ ...first.list, writer: () => null }, new Set(), noWait)).toBeNull();
  });
});

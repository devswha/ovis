import { describe, expect, it } from "bun:test";
import { kindBody, LIST_LEVEL, listView, replayList, signCard, signListEntry, type ListState } from "../../../shared/account-list.ts";
import { entryFromText, entryToText, readBody, signEntry } from "../../../shared/account-list-entry.ts";
import type { AccountListView, ListWriter } from "./accountList.ts";
import { askingPc, listWorld, postPcKeys, type WorldDevice } from "./accountList.test-helpers.ts";
import { allowDevice, type AllowOutcome } from "./listAllow.ts";
import { deviceListKeys, type DeviceListKeys } from "./listKeys.ts";
import { WRITE_RESENDS } from "./listWrite.ts";
import {
  cameInThrough, overdueKeys, removalRequest, removeFromList, removeSelf, scopeOf, tidyList,
  type RemoveOutcome,
} from "./listRemoveDevice.ts";
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
    expect(await removeFromList(stranger.list, { keys: [(await first.keys()).key], pcs: [] }, noWait)).toEqual({ removed: false, why: "no_list", retryAfterMs: null, placed: 0 });
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
  return { account: state.account, list: state.list, state, keys, epochs: new Map(), clock: at, issued_at: at, adrift: false, service: null as never };
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

  it("sends the same signed request again while its copy shows the head unmoved, signs no second one, and gives up saying so", async () => {
    const { w, first, second } = await twoDevices();
    const before = w.held().entries.length;
    w.fake.tamperList(w.held().id, { headMoved: true });
    expect(await removeFromList(first.list, { keys: [(await second.keys()).key], pcs: [] }, noWait)).toEqual({ removed: false, why: "busy", retryAfterMs: null, placed: 0 });
    // one signature for the place: the same request, sent again, and no new one while the copy shows the same head
    const sent = placements(first).slice(1);
    expect([sent.length, new Set(sent.map((each) => JSON.stringify(each.body))).size, w.held().entries.length]).toEqual([WRITE_RESENDS, 1, before]);
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
    expect(placements(first).length - from).toBe(WRITE_RESENDS);
    w.fake.untamperList(w.held().id);
    w.fake.tamperList(w.held().id, { stopped: true });
    expect(await removeFromList(first.list, { keys: [gone], pcs: [] }, noWait)).toEqual({ removed: false, why: "stopped", retryAfterMs: null, placed: 0 });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
  });

  it("does not take the account service's answer for the device being out: an answer with nothing placed puts nobody out", async () => {
    const { w, first, second } = await twoDevices();
    first.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")
      ? Response.json({ list: w.held().id, head: { seq: 3, hash: "ab".repeat(32) }, placed: 2, now: 1 }) : null;
    expect(await removeFromList(first.list, { keys: [(await second.keys()).key], pcs: [] }, noWait)).toEqual({ removed: false, why: "busy", retryAfterMs: null, placed: 0 });
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
  });

  it("says it does not know yet when the request got no answer and the log cannot be read, and signs nothing more", async () => {
    const { w, first, second } = await twoDevices();
    let away = false;
    first.wire.answer = (request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/entries")) away = true;
      return away ? Promise.reject(new TypeError("offline")) : null;
    };
    const before = w.held().entries.length;
    expect(await removeFromList(first.list, { keys: [(await second.keys()).key], pcs: [] }, noWait)).toMatchObject({ removed: false, why: "unknown" });
    expect(w.held().entries).toHaveLength(before);
  });
});

describe("a device that puts itself out", () => {
  it("signs a remove of its own key and no epoch, and a device that stays opens the next one when it tidies", async () => {
    const { w, first, second } = await twoDevices();
    const own = (await second.keys()).key;
    expect(await removeSelf(second.list, scopeOf(second.list.view())!, noWait)).toEqual(REMOVED);
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

  it("leaves a plain invite past its exp alone: it holds no key of the epoch and lets nobody in (lapsedRemovals' set)", async () => {
    const { w, first } = await twoDevices();
    await placeInvite(w, first, { auto: false });
    w.clock.now += 16 * 60_000;
    await first.list.sync();
    const before = w.held().entries.length;
    expect(await tidyList(first.list, new Set(), noWait)).toBeNull();
    expect(w.held().entries).toHaveLength(before);
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

describe("what the Codex read of P13 found", () => {
  /** `by` lets a borrowed browser in: power bound, role drive, until `seconds` after `by`'s own clock. */
  async function letInBorrowed(w: World, by: WorldDevice, label: string, seconds: number): Promise<WorldDevice> {
    const browser = await w.device({ label });
    await browser.list.sync();
    await by.list.sync();
    const writer = by.list.writer()!;
    const own = (await browser.keys()).key;
    const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key === own)!;
    const placed = await signListEntry(writer.state, { kind: "device", key: claim.key, power: "bound", role: "drive", until: writer.issued_at + seconds, enc: claim.enc, card: claim.card, sealed: null, rotates: false },
      { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
    await writer.service.placeEntries(writer.list, [placed.text], []);
    return browser;
  }

  it("X1: a service clock that runs ahead makes no quiet clean-up put a borrowed browser out before its time", async () => {
    const w = listWorld();
    // this device's own clock runs two hours behind the account service's
    const first = await w.device({ label: "Dana's phone", skew: -2 * 3600_000 });
    await first.list.sync();
    await letInBorrowed(w, first, "Library browser", 3600);
    const before = w.held().entries.length;
    await first.list.sync();
    expect(await tidyList(first.list, new Set(), noWait)).toBeNull();
    expect(w.held().entries).toHaveLength(before);
  });

  it("what came in through a key follows members that are out already, and offers only those still in", async () => {
    const { w, first, second } = await twoDevices();
    const third = await letIn(w, second, "Laptop");
    const fourth = await letIn(w, third, "Desk browser");
    // the laptop alone was removed; the desk browser it let in is still in
    expect(await removeFromList(first.list, { keys: [(await third.keys()).key], pcs: [] }, noWait)).toEqual(REMOVED);
    const keys = await Promise.all([first.keys(), second.keys(), fourth.keys()]).then((all) => all.map((each) => each.key));
    expect(cameInThrough(w.held().state, keys[1]!, keys[0]!).map((arrival) => arrival.kind === "pc" ? arrival.endpoint : arrival.key)).toEqual([keys[2]!]);
  });

  it("X4: the removal asked for and its epoch go in the first request, whatever is over its time; the rest is tidied later", async () => {
    const { w, first, second } = await twoDevices();
    const keys = await first.keys();
    const at = Math.floor(w.clock.now / 1000);
    // fifteen invites that a PC joins with by itself, all past their time
    let state = w.held().state;
    const texts: string[] = [];
    for (let index = 0; index < 15; index += 1) {
      const invite = await deviceListKeys(memoryAccountStore());
      const placed = await signListEntry(state, { kind: "invite", key: invite.key, exp: at + 60, uses: 1, auto: true, sealed: null }, { key: keys.key, privateKey: keys.signs }, at);
      texts.push(placed.text);
      state = placed.state;
    }
    for (const text of texts) await first.service.placeEntries(w.held().id, [text], []);
    w.clock.now += 5 * 60_000;
    const from = placements(first).length;
    expect(await removeFromList(first.list, { keys: [(await second.keys()).key], pcs: [] }, noWait)).toEqual(REMOVED);
    const first_request = placements(first)[from]!.body!.entries as string[];
    expect(first_request.length).toBeLessThanOrEqual(16);
    expect([ends(first_request[0]!), kinds(first_request).at(-1)]).toEqual([(await second.keys()).key, "epoch"]);
  });

  it("a removal in parts says how much of it was done when a later part is refused", async () => {
    const { w, first } = await twoDevices();
    const keys = await first.keys();
    const at = Math.floor(w.clock.now / 1000);
    let state = w.held().state;
    const texts: string[] = [];
    const invites: string[] = [];
    for (let index = 0; index < 17; index += 1) {
      const invite = await deviceListKeys(memoryAccountStore());
      const placed = await signListEntry(state, { kind: "invite", key: invite.key, exp: at + 3600, uses: 1, auto: false, sealed: null }, { key: keys.key, privateKey: keys.signs }, at);
      texts.push(placed.text);
      invites.push(invite.key);
      state = placed.state;
    }
    for (const text of texts) await first.service.placeEntries(w.held().id, [text], []);
    let parts = 0;
    first.wire.answer = (request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/entries")) return null;
      parts += 1;
      return parts === 1 ? null : Response.json({ error: { code: "entry_budget", message: "later" }, now: 1 }, { status: 429, headers: { "retry-after": "60" } });
    };
    const outcome = await removeFromList(first.list, { keys: invites, pcs: [] }, noWait);
    expect(outcome).toMatchObject({ removed: false, why: "budget", placed: 15 });
  });
});

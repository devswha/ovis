import { describe, expect, test } from "bun:test";
import { heldNaming, heldVouches, MIGRATION_ANSWER_SECONDS, MIGRATION_KNOWN_SECONDS, type PcAnswer } from "../../../shared/account-list-migrate.ts";
import { listView } from "../../../shared/account-list.ts";
import { askingPc, listWorld, postPcKeys, type AskingPc, type WorldDevice } from "./accountList.test-helpers.ts";
import { keysForCarriedPc } from "./listCarriedPc.ts";
import { MOVE_AGAIN_SECONDS, pcAnswers, readBirth, readNotice, type PcAnswers } from "./listMigrate.ts";
import type { SeenPcs } from "./seenPcs.ts";

const DAY = 86400;
const OLD = { wall: 30 * DAY, ran: 30 * DAY };

/** A Storage in memory, where a device keeps its record of its PCs (seenPcs.ts). */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => { items.delete(key); },
    setItem: (key, value) => { items.set(key, String(value)); },
  };
}

/** A world of one account that was in use: its devices, each with its own record of its PCs and its own answers from this run. */
function movingWorld() {
  const world = listWorld();
  world.fake.listMigrateAccounts = world.account;
  const json = (body: unknown, bearer: string): RequestInit => ({ headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
  const seconds = () => Math.floor(world.clock.now / 1000);
  /** A device of the account, signed in long ago (no new account's genesis is its to make), with its record and its answers. */
  const member = async (label: string, scale = 1) => {
    const storage = memoryStorage();
    const answers = pcAnswers();
    const device = await world.device({ label, migration: { answers, storage, scale: () => scale } });
    const signIn = (await device.store.get("signin_key"))!.key.public_spki;
    const member = (await device.store.key()).public_spki;
    const record = (pcs: SeenPcs["pcs"], tried?: number) => storage.setItem(`ovis:seen-pcs:${world.account}`, JSON.stringify({ v: 1, account: world.account, pcs, ...(tried === undefined ? {} : { tried }) }));
    const kept = () => JSON.parse(storage.getItem(`ovis:seen-pcs:${world.account}`) ?? "null") as SeenPcs | null;
    return { device, storage, answers, signIn, member, record, kept, label };
  };
  /** A PC the account lists as let in (listed by an own sign-in). */
  const pcOf = async (by: WorldDevice): Promise<AskingPc> => {
    const pc = await askingPc();
    const listed = await world.fake.fetch(`${world.origin}/v1/pcs/${pc.server_id}`, { method: "PUT", ...json({ label: "Desk", public_key: pc.endpoint, relay: "wss://relay.test" }, by.session.access_token) });
    if (!listed.ok) throw new Error(`The account did not list the PC: ${listed.status}`);
    return pc;
  };
  const answer = (admits: readonly { key: string; wall?: number; ran?: number; idle?: number }[], rest: Partial<PcAnswer> = {}): PcAnswer =>
    ({ account: world.account, pinned: null, admits: admits.map((row) => ({ ...OLD, idle: null, ...row })), removed: [], ...rest });
  const birthsSent = (device: WorldDevice) => device.sent.filter((one) => one.route === "POST /v2/lists" && Array.isArray(one.body?.entries));
  return { world, member, pcOf, answer, seconds, birthsSent };
}

type Moving = ReturnType<typeof movingWorld>;
type Member = Awaited<ReturnType<Moving["member"]>>;

/**
 * A phone and a laptop of the account, both let in for a month by one PC each knows by its own pairing. `silent`: a
 * second PC both know as well, listed as let in, that answers nobody in this run.
 */
async function inUse(moving: Moving = movingWorld(), given: { readonly silent?: boolean } = {}) {
  const phone = await moving.member("Phone");
  const laptop = await moving.member("Laptop");
  const pc = await moving.pcOf(phone.device);
  const silent = given.silent === true ? await moving.pcOf(phone.device) : null;
  // signed in more than ten minutes ago: this is an account in use, which no first device's genesis is for
  moving.world.clock.now += 11 * 60_000;
  const at = moving.seconds() - 40 * DAY;
  const pcs: SeenPcs["pcs"] = { [pc.endpoint]: { since: at, last: at, how: "paired" }, ...(silent === null ? {} : { [silent.endpoint]: { since: at, last: at, how: "paired" } }) };
  phone.record(pcs);
  laptop.record(pcs);
  const said = moving.answer([{ key: phone.signIn }, { key: laptop.signIn }]);
  phone.answers.set(moving.world.account, pc.endpoint, said);
  laptop.answers.set(moving.world.account, pc.endpoint, said);
  return { ...moving, phone, laptop, pc, silent };
}

describe("an account that is on no migrate switch, or has no list, behaves as before", () => {
  test("off the migrate switch: no birth, no read of the device list, and the device starts nothing", async () => {
    const moving = movingWorld();
    moving.world.fake.listMigrateAccounts = "";
    const { phone } = await inUse(moving);
    const view = await phone.device.list.sync();
    expect(view.status).toEqual({ at: "none", why: "not_new" });
    expect(moving.birthsSent(phone.device)).toEqual([]);
    expect(phone.device.sent.some((one) => one.route === "GET /v1/devices")).toBe(false);
    expect(phone.kept()?.tried).toBeUndefined();
  });

  test("an account the service keeps no list for is asked nothing more than before", async () => {
    const moving = movingWorld();
    moving.world.fake.listAccounts = "";
    const { phone } = await inUse(moving);
    const view = await phone.device.list.sync();
    expect(view.status).toEqual({ at: "off" });
    expect(phone.device.sent.map((one) => one.route)).toEqual(["GET /v2/lists/mine"]);
  });
});

describe("the first device moves the account onto its list", () => {
  test("every PC it knows let both devices in for a day: one request, the pin after the 201, and the notice", async () => {
    const { phone, laptop, pc, world, birthsSent } = await inUse();
    const view = await phone.device.list.sync();
    expect(birthsSent(phone.device)).toHaveLength(1);
    expect(view.status).toMatchObject({ at: "following", standing: "in", trouble: null });
    const held = world.held();
    const rows = listView(held.state);
    // the phone is in by its member key; the laptop by its sign-in key, carried; the PC carried as an endpoint with no key
    expect(rows.devices.filter((row) => row.ended === null).map((row) => row.key).sort()).toEqual([phone.member, laptop.signIn].sort());
    expect(view.devices.find((row) => row.self)?.key).toBe(phone.member);
    expect(rows.pcs.map((row) => row.endpoint)).toEqual([pc.endpoint]);
    // the birth was let go once it was in the copy; the notice waits to be seen
    expect(readBirth(await phone.device.lists.get("birth" as never, world.account))).toBeNull();
    const notice = readNotice(await phone.device.lists.get("notice" as never, world.account));
    expect(notice).toMatchObject({ list: held.id, first: phone.signIn, devices: [laptop.signIn], pcs: [pc.endpoint], seen: false });
    // the try ended in a start
    expect(phone.kept()?.tried).toBeUndefined();
  });

  test("a lost answer: the device learns from the account service's own word that its birth was placed, and follows it", async () => {
    const { phone, world, birthsSent } = await inUse();
    world.fake.tamperAccount(world.account, { withholdAnswer: true });
    const first = await phone.device.list.sync();
    expect(first.status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    world.fake.untamperAccount(world.account);
    const again = await phone.device.list.sync();
    expect(birthsSent(phone.device)).toHaveLength(1);
    expect(again.status).toMatchObject({ at: "following", standing: "in", list: world.held().id });
  });

  test("a request that never arrived: the very request it kept is sent again, never a second one", async () => {
    const { phone, world, birthsSent } = await inUse();
    let dropped = false;
    phone.device.wire.answer = (request) => {
      if (dropped || request.method !== "POST" || new URL(request.url).pathname !== "/v2/lists") return null;
      dropped = true;
      throw new TypeError("the request never arrived");
    };
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "sending" } });
    phone.device.wire.answer = null;
    const again = await phone.device.list.sync();
    const sent = birthsSent(phone.device);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
    expect(again.status).toMatchObject({ at: "following", standing: "in", list: world.held().id });
  });

  test("a PC it knows that has not answered holds the start back for three days from its first try", async () => {
    const moving = movingWorld();
    const { phone, birthsSent, silent } = await inUse(moving, { silent: true });
    const view = await phone.device.list.sync();
    expect(view.status).toMatchObject({ at: "none", why: "moving", move: { why: "pcs_silent", wait: MIGRATION_ANSWER_SECONDS, asks: [silent!.endpoint] } });
    expect(birthsSent(phone.device)).toEqual([]);
    expect(phone.kept()?.tried).toBe(moving.seconds());
    // its first try was nearly three days ago (a session token outlives no such wait here, so the record says it)
    phone.record(phone.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS + 60);
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "pcs_silent", wait: 60 } });
    phone.record(phone.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    expect(birthsSent(phone.device)).toHaveLength(1);
  });

  test("in the QA twin the device's own waits are turned down by its factor", async () => {
    const moving = movingWorld();
    const phone = await moving.member("Phone", 3600);
    const laptop = await moving.member("Laptop");
    const pc = await moving.pcOf(phone.device);
    const silent = await moving.pcOf(phone.device);
    moving.world.clock.now += 11 * 60_000;
    const at = moving.seconds() - 40 * DAY;
    phone.record({ [pc.endpoint]: { since: at, last: at, how: "paired" }, [silent.endpoint]: { since: at, last: at, how: "paired" } });
    phone.answers.set(moving.world.account, pc.endpoint, moving.answer([{ key: phone.signIn }, { key: laptop.signIn }]));
    // three days are 72 seconds there
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "pcs_silent", wait: 72 } });
    moving.world.clock.now += 72_000;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
  });

  test("a final refusal: the birth is dropped, nothing is sent for an hour, then a plan without the key the refusal named", async () => {
    const { phone, laptop, world, birthsSent } = await inUse();
    // the honest case of the ruling: GET /v1/devices calls the laptop eligible, the birth's carried check does not
    world.fake.removeDevice(world.account, laptop.signIn);
    world.fake.tamperAccount(world.account, { eligibleAgain: [laptop.signIn] });
    const refusedOnce = await phone.device.list.sync();
    expect(refusedOnce.status).toMatchObject({ at: "none", why: "moving", move: { why: "refused" } });
    expect(birthsSent(phone.device)).toHaveLength(1);
    expect(readBirth(await phone.device.lists.get("birth" as never, world.account))).toBeNull();
    world.clock.now += (MOVE_AGAIN_SECONDS - 60) * 1000;
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "none", why: "moving", move: { why: "refused" } });
    expect(birthsSent(phone.device)).toHaveLength(1);
    world.clock.now += 60_000;
    const moved = await phone.device.list.sync();
    expect(birthsSent(phone.device)).toHaveLength(2);
    expect(moved.status).toMatchObject({ at: "following", standing: "in" });
    expect(listView(world.held().state).devices.some((row) => row.key === laptop.signIn)).toBe(false);
  });

  test("a key a PC holds a removal against is never carried, whatever the service lists", async () => {
    const { phone, laptop, pc, world } = await inUse();
    world.fake.tamperAccount(world.account, { eligibleAgain: [laptop.signIn] });
    phone.answers.set(world.account, pc.endpoint, { account: world.account, pinned: null, admits: [{ key: phone.signIn, ...OLD }, { key: laptop.signIn, ...OLD }], removed: [laptop.signIn] });
    expect((await phone.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    expect(listView(world.held().state).devices.some((row) => row.key === laptop.signIn)).toBe(false);
  });
});

/** The phone moved the account; the laptop was carried in. */
async function moved() {
  const setting = await inUse();
  await setting.phone.device.list.sync();
  return setting;
}

describe("a device that was carried in", () => {
  test("its PCs let in the key that started the list: it follows, hands its place to its member key, and says so once", async () => {
    const { laptop, phone, pc, world } = await moved();
    const view = await laptop.device.list.sync();
    expect(view.status).toMatchObject({ at: "following", standing: "in" });
    // the hand-over is placed with the link of its member key to its sign-in key
    const handed = laptop.device.sent.find((one) => one.route === `POST /v2/lists/${world.held().id}/entries`);
    expect(handed?.body?.link).toBeDefined();
    await laptop.device.list.sync();
    const rows = listView(world.held().state).devices.filter((row) => row.ended === null).map((row) => row.key);
    expect(rows.sort()).toEqual([phone.member, laptop.member].sort());
    const notice = readNotice(await laptop.device.lists.get("notice" as never, world.account));
    expect(notice).toMatchObject({ first: phone.signIn, pcs: [pc.endpoint], seen: false });
  });

  test("a list the account service made with a key of its own is refused: the PCs never let that key in", async () => {
    const { laptop, pc, world } = await inUse();
    const forged = await world.fake.forgeBirth(world.account, { endpoints: [pc.endpoint] });
    const view = await laptop.device.list.sync();
    expect(view.status).toMatchObject({ at: "not_in", list: forged, why: "not_mine", refused: { why: "first_signer_unknown", pcs: [pc.endpoint] } });
    expect(laptop.device.sent.some((one) => one.route === `POST /v2/lists/${forged}/entries`)).toBe(false);
  });

  test("a PC it knows follows another list: it refuses and names that PC", async () => {
    const { laptop, pc, world } = await moved();
    laptop.answers.set(world.account, pc.endpoint, { account: world.account, pinned: "ab".repeat(32), admits: [], removed: [] });
    const view = await laptop.device.list.sync();
    expect(view.status).toMatchObject({ at: "not_in", why: "not_mine", refused: { why: "other_list", pcs: [pc.endpoint] } });
  });

  test("a PC it knows has not answered: it waits, and goes by those that did three days after its first try", async () => {
    const moving = movingWorld();
    const setting = await inUse(moving, { silent: true });
    // the phone went by the PC that answered, three days after its own first try
    setting.phone.record(setting.phone.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    await setting.phone.device.list.sync();
    const waiting = await setting.laptop.device.list.sync();
    expect(waiting.status).toMatchObject({ at: "not_in", why: "carried", join: { why: "pcs_silent", wait: MIGRATION_ANSWER_SECONDS, pcs: [setting.silent!.endpoint] } });
    expect(setting.laptop.kept()?.tried).toBe(moving.seconds());
    setting.laptop.record(setting.laptop.kept()!.pcs, moving.seconds() - MIGRATION_ANSWER_SECONDS);
    expect((await setting.laptop.device.list.sync()).status).toMatchObject({ at: "following", standing: "in" });
    expect(setting.laptop.kept()?.tried).toBeUndefined();
  });
});

describe("what a device that follows its moved list says to a PC that follows none", () => {
  test("a naming of the list by its member key, bound to the session's key and the PC, and a vouch of its sign-in key", async () => {
    const { phone, pc, world } = await moved();
    const said = await phone.device.list.naming!({ session: phone.signIn, endpoint: pc.endpoint, signIn: phone.signIn });
    expect(said).not.toBeNull();
    const held = await heldNaming(world.account, pc.endpoint, phone.signIn, said!.naming);
    expect(held).toEqual({ list: world.held().id, key: phone.member, session: phone.signIn });
    expect(await heldVouches(world.account, world.held().id, said!.vouches)).toEqual([{ key: phone.member, device: phone.signIn }]);
  });

  test("a list that was never moved names nothing to any PC", async () => {
    const world = listWorld();
    const phone = await world.device({ label: "Phone" });
    await phone.list.sync();
    const pc = await askingPc();
    expect(await phone.list.naming!({ session: (await phone.keys()).key, endpoint: pc.endpoint, signIn: null })).toBeNull();
  });
});

// keep the imports honest when a test above is narrowed
void MIGRATION_KNOWN_SECONDS;
export type { Member, PcAnswers };

describe("a PC the move carried in with no key, met over a session while it follows the list", () => {
  /** The PC's own answer to `GET /api/account/list/card` over the session (W4), after it posted those keys for the list. */
  const cardWire = (card: { key: string; enc: string; card: string; endpoint: string; list: string }) => async (path: string): Promise<Response> =>
    path === "/api/account/list/card" ? Response.json(card) : Response.json({ error: { code: "not_found" } }, { status: 404 });

  test("a device that paired with it at the PC signs its `pc` entry with the card the PC gave over the session", async () => {
    const { phone, pc, world } = await moved();
    const list = world.held().id;
    const card = await postPcKeys(world.fake.fetch, world.origin, phone.device.session.access_token, pc, list);
    const added = await keysForCarriedPc({ list: phone.device.list, fetch: cardWire({ key: pc.key, enc: pc.enc, card, endpoint: pc.endpoint, list }), account: world.account, endpoint: pc.endpoint, record: phone.kept()!, names: null });
    expect(added).toBe("added");
    const row = listView(world.held().state).pcs.find((one) => one.endpoint === pc.endpoint);
    expect(row).toMatchObject({ key: pc.key, removed: null });
  });

  test("a device that only opened it signs nothing: that PC gets its keys by the number at it", async () => {
    const { phone, pc, world } = await moved();
    const list = world.held().id;
    const card = await postPcKeys(world.fake.fetch, world.origin, phone.device.session.access_token, pc, list);
    const none = { ...phone.kept()!, pcs: { [pc.endpoint]: { since: 1, last: 2, how: "none" as const } } };
    expect(await keysForCarriedPc({ list: phone.device.list, fetch: cardWire({ key: pc.key, enc: pc.enc, card, endpoint: pc.endpoint, list }), account: world.account, endpoint: pc.endpoint, record: none, names: null })).toBe("no_evidence");
    expect(listView(world.held().state).pcs.find((one) => one.endpoint === pc.endpoint)?.key).toBeNull();
  });

  test("a card for another relay key, another list, or one that does not hold, is no card", async () => {
    const { phone, pc, world } = await moved();
    const list = world.held().id;
    const card = await postPcKeys(world.fake.fetch, world.origin, phone.device.session.access_token, pc, list);
    const other = await askingPc();
    for (const shown of [{ endpoint: other.endpoint, list }, { endpoint: pc.endpoint, list: "ab".repeat(32) }]) {
      expect(await keysForCarriedPc({ list: phone.device.list, fetch: cardWire({ key: pc.key, enc: pc.enc, card, ...shown }), account: world.account, endpoint: pc.endpoint, record: phone.kept()!, names: null })).toBe("no_card");
    }
    expect(await keysForCarriedPc({ list: phone.device.list, fetch: cardWire({ key: other.key, enc: pc.enc, card, endpoint: pc.endpoint, list }), account: world.account, endpoint: pc.endpoint, record: phone.kept()!, names: null })).toBe("no_card");
    expect(listView(world.held().state).pcs.find((one) => one.endpoint === pc.endpoint)?.key).toBeNull();
  });
});

describe("the one-time notice of the move", () => {
  test("who made the list and whom it carried in, each by the key that stands for it now, until the person saw it", async () => {
    const { phone, laptop, pc, world } = await moved();
    const first = await phone.device.list.notice!(world.account);
    expect(first).toMatchObject({ list: world.held().id, first: { self: true }, devices: [{ key: laptop.signIn }], pcs: [{ endpoint: pc.endpoint }] });
    // the laptop follows and hands its place on: the phone's notice names it by its member key from then on
    await laptop.device.list.sync();
    await laptop.device.list.sync();
    await phone.device.list.sync({ read: true });
    // a carried device's name is sealed only where the account service names it (GET /v1/devices carries no label yet)
    expect((await phone.device.list.notice!(world.account))?.devices).toEqual([{ key: laptop.member, name: null }]);
    const theirs = await laptop.device.list.notice!(world.account);
    expect(theirs).toMatchObject({ first: { self: false, key: phone.member }, devices: [], pcs: [{ endpoint: pc.endpoint }] });
    await phone.device.list.noticeSeen!(world.account, world.held().id);
    expect(await phone.device.list.notice!(world.account)).toBeNull();
    expect(await laptop.device.list.notice!(world.account)).not.toBeNull();
  });
});

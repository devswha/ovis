import { describe, expect, it } from "bun:test";
import { sealEpoch } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { addListPc, listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { allowDevice } from "./listAllow.ts";
import { removeListPc } from "./listRemove.ts";

type World = ReturnType<typeof listWorld>;

const noWait = { wait: async () => {} };
const placements = (from: WorldDevice) => from.sent.filter((each) => each.route.endsWith("/entries"));
const kinds = (texts: readonly string[]): string[] => texts.map((text) => readBody(entryFromText(text).body).kind);

/** An account with two devices in its list and a PC the first one added. */
async function account(w: World = listWorld()) {
  const first = await w.device({ label: "Dana's phone" });
  await first.list.sync();
  const second = await w.device({ label: "Dana's tablet" });
  await second.list.sync();
  const outcome = await allowDevice(first.list, { key: (await second.keys()).key, label: "Dana's tablet", os: "android" }, noWait);
  if (!outcome.allowed) throw new Error(`the device was not let in: ${outcome.why}`);
  await second.list.adopt(outcome.offer);
  const desk = await addListPc(w, first, "Desk");
  await second.list.sync();
  return { w, first, second, desk };
}

describe("a device puts a PC out of its account's list", () => {
  it("signs the removal and the next epoch in one request, and wraps the new key to those who stay", async () => {
    const { w, first, second, desk } = await account();
    expect(await removeListPc(second.list, desk.endpoint, noWait)).toEqual({ removed: true });
    const [request] = placements(second);
    expect(placements(second).length).toBe(1);
    expect(kinds(request!.body!.entries as string[])).toEqual(["remove", "epoch"]);
    const wrapped = (request!.body!.wraps as { member: string; epoch: number }[]).map((wrap) => [wrap.member, wrap.epoch]);
    expect(wrapped.sort()).toEqual([[(await first.keys()).enc.key, 1], [(await second.keys()).enc.key, 1]].sort());
    // the PC is out for every device, and what the account service's directory still says of it is no word on that
    expect([(await first.list.sync()).pcs, second.list.view().pcs, first.list.holdsPc(desk.endpoint)]).toEqual([[], [], false]);
    // names are sealed again at once, under the epoch the request opened, and both devices read them
    expect(sealEpoch(w.held().state, Math.floor(w.clock.now / 1000))).toMatchObject({ epoch: 1 });
    const laptop = await addListPc(w, first, "Laptop");
    expect((await second.list.sync()).pcs.map((pc) => [pc.endpoint, pc.name?.label])).toEqual([[laptop.endpoint, "Laptop"]]);
  });

  it("says a PC the list does not hold is out, and sends nothing", async () => {
    const { first, second, desk } = await account();
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toEqual({ removed: true });
    const before = placements(second).length;
    expect(await removeListPc(second.list, desk.endpoint, noWait)).toEqual({ removed: true });
    expect(await removeListPc(second.list, "ab".repeat(32), noWait)).toEqual({ removed: true });
    expect(placements(second).length).toBe(before);
  });

  it("signs nothing on a device that is in no list", async () => {
    const { w, desk } = await account();
    const third = await w.device({ label: "Somebody's laptop" });
    await third.list.sync();
    expect(await removeListPc(third.list, desk.endpoint, noWait)).toEqual({ removed: false, why: "no_list", retryAfterMs: null });
    expect(placements(third)).toEqual([]);
  });

  it("reads and signs again when the head moved under it, and gives up after its tries where it keeps moving", async () => {
    const { w, first, second, desk } = await account();
    // another PC came in between this device's read and its request
    second.wire.answer = async (request) => {
      if (request.method !== "POST" || !request.url.endsWith("/entries")) return null;
      second.wire.answer = null;
      await addListPc(w, first, "Laptop");
      return null;
    };
    expect(await removeListPc(second.list, desk.endpoint, noWait)).toEqual({ removed: true });
    expect(placements(second).length).toBe(2);
    expect((await first.list.sync()).pcs.map((pc) => pc.name?.label)).toEqual(["Laptop"]);
    const laptop = first.list.view().pcs[0]!;
    w.fake.tamperList(w.held().id, { headMoved: true });
    expect(await removeListPc(second.list, laptop.endpoint, noWait)).toEqual({ removed: false, why: "busy", retryAfterMs: null });
    expect(first.list.holdsPc(laptop.endpoint)).toBe(true);
  });

  it("does not take the account service's answer for the PC being out", async () => {
    const { w, second, desk } = await account();
    second.wire.answer = (request) => request.method === "POST" && request.url.endsWith("/entries") ? Response.json({ head: w.held().head }) : null;
    expect(await removeListPc(second.list, desk.endpoint, noWait)).toMatchObject({ removed: false, why: "busy" });
    expect(second.list.holdsPc(desk.endpoint)).toBe(true);
  });

  it("says so when the account service cannot change the list, or has taken as many changes as it takes for now", async () => {
    const { w, second, desk } = await account();
    w.fake.tamperList(w.held().id, { stopped: true });
    expect(await removeListPc(second.list, desk.endpoint, noWait)).toMatchObject({ removed: false, why: "stopped" });
    w.fake.untamperList(w.held().id);
    second.wire.answer = (request) => request.method === "POST" && request.url.endsWith("/entries") ? Response.json({ error: { code: "entry_budget", message: "" } }, { status: 429, headers: { "retry-after": "60" } }) : null;
    expect(await removeListPc(second.list, desk.endpoint, noWait)).toEqual({ removed: false, why: "budget", retryAfterMs: 60_000 });
  });
});

import { describe, expect, it } from "bun:test";
import { readAccountRecord } from "../../../shared/account-records.ts";
import { listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { admitWithList, handListToPc, ListAllowError, takeIntroduction, type PcFetch } from "./join.ts";
import type { ListOffer } from "./accountList.ts";
import { MemoryDeviceStore } from "../relay/device.test.ts";
import { memoryAccountStore } from "./store.ts";

const THROUGH = "a1".repeat(16);
const noWait = async (): Promise<void> => {};

/** PC X as an approval meets it: it records what it is sent, and answers the introduction, the records and the list's two calls. */
function pcX(answers: { head?: (body: unknown) => Response; page?: (body: unknown) => Response } = {}) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const fetch: PcFetch = async (path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ path, body });
    if (path === "/api/account/list/head") return answers.head?.(body) ?? Response.json({ error: { code: "not_found" } }, { status: 404 });
    if (path === "/api/account/list/page") return answers.page?.(body) ?? Response.json({ error: { code: "not_found" } }, { status: 404 });
    return new Response(null, { status: 204 });
  };
  return { sent, fetch, paths: () => sent.map((each) => each.path) };
}

/** The place a PC's introduction carries for a device, as that device reads it over its own session. */
async function listOffer(fetch: PcFetch): Promise<ListOffer | null> {
  let offer: ListOffer | null = null;
  await takeIntroduction({ fetch, key: await memoryAccountStore().key(), label: "Tablet", store: new MemoryDeviceStore(), relay: "wss://relay.test", onList: (handed) => { offer = handed; } });
  return offer;
}

async function admit(from: WorldDevice, joining: { key: string; label: string; os: "android" | null }, pc: ReturnType<typeof pcX>, withList = true) {
  const session = (await from.store.get("session"))!;
  return admitWithList(withList ? from.list : null, {
    fetch: pc.fetch, service: from.service, key: await from.store.key(), account: session.account, joining, through: THROUGH, paired: [], directory: [], wait: noWait,
  });
}

describe("a member's approval, once the PC let the new device in", () => {
  it("is as ever for an account with no list: the introduction and the add, and nothing of a list", async () => {
    const w = listWorld();
    w.fake.listAccounts = "";
    const member = await w.device();
    const newcomer = await w.device({ label: "Tablet" });
    const joining = { key: (await newcomer.store.key()).public_spki, label: "Tablet", os: "android" as const };
    for (const withList of [true, false]) {
      const pc = pcX();
      const add = await admit(member, joining, pc, withList);
      expect(pc.paths()).toEqual(["/api/account/introduce", "/api/account/records"]);
      expect(pc.sent[0]!.body).toEqual({ key: joining.key, pcs: [] });
      expect([add.kind, add.key, (await readAccountRecord(add))?.signer]).toEqual(["add", joining.key, (await member.store.key()).public_spki]);
    }
    expect(member.sent.map((each) => each.route).filter((route) => route.includes("/v2/lists/") && route !== "GET /v2/lists/mine")).toEqual([]);
    expect(w.fake.accountList(w.account)).toBeNull();
  });

  it("lets the newcomer into the list first, hands its place over in the introduction, and the newcomer follows from it", async () => {
    const w = listWorld();
    const member = await w.device({ label: "Phone" });
    await member.list.sync();
    const newcomer = await w.device({ label: "Tablet" });
    await newcomer.list.sync();
    const joining = { key: (await newcomer.keys()).key, label: "Tablet", os: "android" as const };
    const pc = pcX();
    await admit(member, joining, pc);
    const list = w.held();
    expect(list.entries).toHaveLength(2);
    expect(pc.paths()).toEqual(["/api/account/introduce", "/api/account/records", "/api/account/list/head"]);
    expect(pc.sent[0]!.body).toEqual({ key: joining.key, pcs: [], list: { id: list.id, seq: 1, hash: list.head.hash } });
    // the PC carries it to the new device over that device's own session
    const offer = await listOffer(async () => Response.json({ pcs: [], list: pc.sent[0]!.body.list }));
    expect(offer).toEqual({ list: list.id, seq: 1, hash: list.head.hash });
    const view = await newcomer.list.adopt(offer!);
    expect(view.status).toMatchObject({ at: "following", standing: "in" });
    expect(view.devices.map((row) => row.name?.label)).toEqual(["Phone", "Tablet"]);
  });

  it("signs nothing else where the list does not take the newcomer, and says why", async () => {
    const w = listWorld();
    const member = await w.device();
    await member.list.sync();
    const stranger = await listWorld("acct_other").device();
    const pc = pcX();
    const refused = await admit(member, { key: (await stranger.store.key()).public_spki, label: "Stranger", os: null }, pc).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ListAllowError);
    expect((refused as ListAllowError).why).toBe("not_claimed");
    expect([pc.sent, w.held().entries.length]).toEqual([[], 1]);
  });

  it("takes no place from an introduction that is out of form, or from a PC that has none", async () => {
    for (const list of [null, "x", { id: "ab".repeat(32), seq: 0, hash: "cd".repeat(32) }, { id: "AB".repeat(32), seq: 1, hash: "cd".repeat(32) }, { id: "ab".repeat(32), seq: 1.5, hash: "cd".repeat(32) }, { id: "ab".repeat(32), seq: 1 }]) {
      expect(await listOffer(async () => Response.json({ pcs: [], list }))).toBeNull();
    }
    expect(await listOffer(async () => Response.json({ pcs: [] }))).toBeNull();
    expect(await listOffer(async () => Response.json({ error: { code: "introduction_none" } }, { status: 404 }))).toBeNull();
  });
});

describe("handing a PC the list's new entries over a session", () => {
  /** a member whose list holds a second device, so that there is an entry to hand over */
  async function memberWithNews() {
    const w = listWorld();
    const member = await w.device();
    await member.list.sync();
    const newcomer = await w.device({ label: "Tablet" });
    await newcomer.list.sync();
    await admit(member, { key: (await newcomer.keys()).key, label: "Tablet", os: "android" }, pcX());
    return { w, member };
  }

  it("says where it stands, and hands the entries after the PC's place when the PC is behind", async () => {
    const { w, member } = await memberWithNews();
    const list = w.held();
    const pc = pcX({ head: () => Response.json({ list: list.id, place: { seq: 0, hash: list.id } }), page: () => Response.json({ verdict: "caught_up" }) });
    expect(await handListToPc(pc.fetch, member.list)).toBe(true);
    expect(pc.sent).toEqual([
      { path: "/api/account/list/head", body: { list: list.id, place: list.head } },
      { path: "/api/account/list/page", body: { list: list.id, after: 0, entries: [list.entries[1]], head: list.head } },
    ]);
  });

  it("counts a PC that stands at that place already as handed, and hands nothing to one that follows another list or has no such call", async () => {
    const { w, member } = await memberWithNews();
    const list = w.held();
    const there = pcX({ head: () => Response.json({ list: list.id, place: list.head }) });
    expect(await handListToPc(there.fetch, member.list)).toBe(true);
    expect(there.paths()).toEqual(["/api/account/list/head"]);
    for (const head of [
      () => Response.json({ list: "ef".repeat(32), place: { seq: 0, hash: "ef".repeat(32) } }),
      () => Response.json({ list: list.id, place: { seq: "0" } }),
      undefined,
    ]) {
      const pc = pcX(head === undefined ? {} : { head });
      expect(await handListToPc(pc.fetch, member.list)).toBe(false);
      expect(pc.paths()).toEqual(["/api/account/list/head"]);
    }
  });

  it("sends the page the PC asks for, and says the entry was handed only when the PC stands at its place", async () => {
    const { w, member } = await memberWithNews();
    const list = w.held();
    // the PC says it stands at entry 1 of some history, then asks for the list from entry 0, and takes that page
    const answers = [Response.json({ verdict: "asks_after", list: list.id, place: null, asks: { list: list.id, after: null } }), Response.json({ verdict: "caught_up", list: list.id, place: list.head })];
    const pc = pcX({ head: () => Response.json({ list: list.id, place: { seq: 0, hash: list.id } }), page: () => answers.shift()! });
    expect(await handListToPc(pc.fetch, member.list, list.head)).toBe(true);
    expect(pc.sent.slice(1).map((each) => [each.path, (each.body as { after: number | null }).after])).toEqual([["/api/account/list/page", 0], ["/api/account/list/page", null]]);
  });

  it("says the entry was not handed where the PC refuses the page, takes less than it, or keeps asking", async () => {
    const { w, member } = await memberWithNews();
    const list = w.held();
    const behind = { head: () => Response.json({ list: list.id, place: { seq: 0, hash: list.id } }) };
    for (const page of [
      () => Response.json({ verdict: "refused", list: list.id, place: { seq: 0, hash: list.id } }),
      () => Response.json({ verdict: "refused" }),
      () => Response.json({ verdict: "asks_after", asks: { list: list.id, after: 0 } }),
      () => Response.json({ verdict: "asks_after", asks: { list: "ef".repeat(32), after: null } }),
      () => Response.json({ error: { code: "rate_limited" } }, { status: 429 }),
    ]) {
      expect(await handListToPc(pcX({ ...behind, page }).fetch, member.list, list.head)).toBe(false);
    }
  });

  it("asks a PC nothing where this device follows no list", async () => {
    const w = listWorld();
    w.fake.listAccounts = "";
    const member = await w.device();
    await member.list.sync();
    const pc = pcX();
    expect(await handListToPc(pc.fetch, member.list)).toBe(false);
    expect(pc.sent).toEqual([]);
  });
});

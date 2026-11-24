import { describe, expect, it, spyOn } from "bun:test";
import { kindBody } from "../../../shared/account-list.ts";
import { entryFromText, entryHash, entryToText, readBody, signEntry } from "../../../shared/account-list-entry.ts";
import {
  admitsSession, ATTEMPT_ENTRIES_MAX, compareHeads, gossipHead, pinList, readSave, servePage, shownPcs, startRead, takePage,
  type FollowerCopy, type FollowRead, type ListPage,
} from "../../../shared/account-list-follower.ts";
import { addListPc, listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { allowDevice } from "./listAllow.ts";
import { GOSSIP_CALLS_PER_MINUTE, GOSSIP_SECONDS, gossipWithPc, keepListGossip, type GossipSession } from "./listGossip.ts";
import { removeListPc } from "./listRemove.ts";
import { signedOn, writeToList } from "./listWrite.ts";
import type { PcFetch } from "./join.ts";

type World = ReturnType<typeof listWorld>;

const noWait = { wait: async () => {} };
const seconds = (w: World): number => Math.floor(w.clock.now / 1000);
const hashOf = (text: string): string => entryHash(entryFromText(text).body);
/** Every call may be made: the budget of a minute is the session's (keepListGossip), not one exchange's. */
const always = (): boolean => true;

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

/** A member puts a device out: one `remove` of its key, as a Remove of the devices list signs it. */
async function removeDevice(from: WorldDevice, key: string): Promise<void> {
  const outcome = await writeToList(from.list, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: key }]) }), noWait);
  if (!outcome.written) throw new Error(`the removal was not placed: ${outcome.why}`);
}

/**
 * Another history from entry 1 that the first device signed, which is no post it left behind: more entries by one
 * signer than one post holds. Each lets a PC in that the honest history never names.
 */
async function otherHistory(w: World, by: WorldDevice): Promise<string[]> {
  const keys = await by.keys();
  const { id } = w.held();
  const texts: string[] = [];
  let head = { seq: 0, hash: id };
  for (let index = 0; index <= ATTEMPT_ENTRIES_MAX; index += 1) {
    const endpoint = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const body = kindBody({ issued_at: seconds(w), list: id, prev: head.hash, seq: head.seq + 1, signer: keys.key }, { kind: "carried", endpoint, sealed: null });
    const text = entryToText(await signEntry(body, keys.signs));
    texts.push(text);
    head = { seq: head.seq + 1, hash: hashOf(text) };
  }
  return texts;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => Response.json(body, { status, headers });

/**
 * A PC in memory that follows the account's list and answers the two calls of a session as a pinned PC does
 * (server/account/list-follow.ts `peerHeads`, `takePeerPage`; the real one is held to this in
 * relay/listGossip.contract.test.ts). It holds `texts` as its history, whatever the account service shows anybody.
 */
async function memoryPc(w: World, texts: readonly string[], options: { followsList?: boolean } = {}) {
  const list = hashOf(texts[0]!);
  // it follows the list as entry 0's signer would: whose copy it is does not change what it holds or answers
  const pinned = pinList(null, { account: w.account, list, me: { key: readBody(entryFromText(texts[0]!).body).signer, endpoint: null }, pin: { how: "genesis" } });
  if (!pinned.pinned) throw new Error("the PC could not pin the list");
  const top = texts.length - 1;
  let copy: FollowerCopy = (await takePage(pinned.copy, startRead(pinned.copy, "service"), { entries: texts, head: { seq: top, hash: top === 0 ? list : hashOf(texts[top]!) } }, seconds(w))).copy;
  let kept: FollowRead | null = null;
  const calls: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
  const pc = {
    calls,
    followsList: options.followsList !== false,
    /** Answer 429 to every call from now on, with this `retry-after` (seconds). */
    limit: null as number | null,
    copy: () => copy,
    /** Takes what the account service shows it (a removal it was not withheld). */
    async read(more: readonly string[]): Promise<void> {
      const at = copy.entries.length - 1;
      copy = (await takePage(copy, startRead(copy, "service"), { entries: more, head: { seq: at + more.length, hash: hashOf(more.at(-1)!) } }, seconds(w))).copy;
    },
    fetch: (async (path, init) => {
      const body = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
      calls.push({ path, body });
      if (pc.limit !== null) return json({ error: { code: "rate_limited" } }, 429, { "retry-after": String(pc.limit) });
      const own = gossipHead(copy);
      if (path === "/api/account/list/head") {
        const compared = compareHeads(copy, { list: body.list as string, place: body.place as never });
        if (compared.verdict === "not_my_list") return json(own);
        const asks = body.asks as { list: string; after: number | null } | undefined;
        const served = asks !== undefined && asks.list === copy.list ? servePage(copy, asks, 256) : null;
        if (compared.verdict === "ahead") {
          const page = served ?? servePage(copy, { list: copy.list, after: (body.place as { seq: number } | null)?.seq ?? null }, 256);
          return json(page === null ? own : { ...own, page });
        }
        const answered = served === null ? own : { ...own, page: served };
        if (compared.read === null) return json(answered);
        kept = compared.read;
        return json({ ...answered, asks: { list: compared.read.list, after: compared.read.after } });
      }
      if (path === "/api/account/list/page") {
        const after = body.after as number | null;
        const read: FollowRead = kept !== null && kept.after === after ? kept : { ...startRead(copy, "peer"), after };
        const took = await takePage(copy, read, body as unknown as ListPage, seconds(w));
        copy = took.copy;
        kept = took.read;
        return json({ verdict: took.verdict, ...(took.read === null ? {} : { asks: { list: took.read.list, after: took.read.after } }), ...gossipHead(copy) });
      }
      return json({ error: { code: "not_found" } }, 404);
    }) as PcFetch,
  };
  return pc;
}

/** A session with `pc` as the relay transport gives it: up, and following the list as the PC says. */
function sessionOf(pc: { fetch: PcFetch; followsList: boolean }): GossipSession & { up(on: boolean): void } {
  const listeners = new Set<() => void>();
  const session = {
    followsList: pc.followsList,
    route: "relay" as "relay" | "direct" | undefined,
    fetch: (input: string, init?: RequestInit) => pc.fetch(input, init),
    onRouteChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    up(on: boolean) { session.route = on ? "relay" : undefined; for (const listener of [...listeners]) listener(); },
  };
  return session;
}

/** Waits for `done` to hold, polling to a deadline: the exchanges run on their own. */
async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const end = performance.now() + ms;
  while (!done()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("a device and the PC it has a session with say where the list stands", () => {
  it("in one call where both stand at one entry, and hand nothing", async () => {
    const { w, first } = await account();
    const pc = await memoryPc(w, w.held().entries);
    expect(await gossipWithPc(pc.fetch, first.list, null, always)).toEqual({ end: "done", carry: null, retryAfterMs: null });
    expect(pc.calls.map((call) => call.path)).toEqual(["/api/account/list/head"]);
    expect(pc.calls[0]!.body).toEqual(gossipHead(pc.copy()) as unknown as Record<string, unknown>);
  });

  it("hand the PC a removal the account service withholds from it, which it takes on its own check of the entry", async () => {
    const { w, first, second } = await account();
    const pc = await memoryPc(w, w.held().entries);
    const removed = (await second.keys()).key;
    expect(admitsSession(pc.copy(), removed, seconds(w)).why).toBeNull();
    await removeDevice(first, removed);
    expect(await gossipWithPc(pc.fetch, first.list, null, always)).toMatchObject({ end: "done" });
    expect(pc.calls.map((call) => call.path)).toEqual(["/api/account/list/head", "/api/account/list/page"]);
    expect(admitsSession(pc.copy(), removed, seconds(w)).why).toBe("removed");
    expect(gossipHead(pc.copy())).toEqual(first.list.gossip()!);
  });

  it("take from the PC a removal the account service withholds from this device, and keep it", async () => {
    const { w, first, second, desk } = await account();
    w.fake.tamperList(w.held().id, { reader: { token: second.session.access_token }, withholdAfter: w.held().head.seq });
    expect(await removeListPc(first.list, desk.endpoint, noWait)).toEqual({ removed: true });
    w.clock.now += 30_000;
    await second.list.sync();
    expect(second.list.holdsPc(desk.endpoint)).toBe(true);
    const pc = await memoryPc(w, w.held().entries);
    expect(await gossipWithPc(pc.fetch, second.list, null, always)).toMatchObject({ end: "done" });
    expect(second.list.holdsPc(desk.endpoint)).toBe(false);
    expect(second.list.gossip()).toEqual(gossipHead(pc.copy()));
    // kept: what the device saved holds the removal, and the account service's withholding takes nothing back
    const saved = await readSave(String(await second.lists.get("copy", w.account)));
    expect(saved.read && shownPcs(saved.copy).map((row) => row.endpoint)).toEqual([]);
    w.clock.now += 30_000;
    await second.list.sync();
    expect(second.list.holdsPc(desk.endpoint)).toBe(false);
    // a peer's page is no full read of the account service
    expect(second.list.view().status).toMatchObject({ at: "following", trouble: null });
  });

  it("raise the alarm on both sides where each holds a history members signed, and the device then signs nothing", async () => {
    const { w, first, second } = await account();
    const fork = await otherHistory(w, first);
    // the honest history goes on by another member too: to the PC it is no post its writer left behind
    await addListPc(w, second, "Laptop");
    await first.list.sync();
    const pc = await memoryPc(w, [w.held().entries[0]!, ...fork]);
    const before = first.list.view();
    const result = await gossipWithPc(pc.fetch, first.list, null, always);
    expect(result.end).toBe("alarm");
    expect(first.list.view().status).toMatchObject({ at: "following", standing: "in", trouble: "fork" });
    // nobody of the other history is let in or shown, whom the device held stays, and it signs nothing from now on
    expect(first.list.view().pcs.map((row) => row.endpoint)).toEqual(before.pcs.map((row) => row.endpoint));
    expect(first.list.writer()).toBeNull();
    // the PC asked for the device's own entries and judged them: it has the alarm too
    expect(pc.calls.some((call) => call.path === "/api/account/list/page")).toBe(true);
    expect(pc.copy().alarm).toMatchObject({ code: "fork", source: "peer" });
    // the device's alarm is kept with its copy
    const saved = await readSave(String(await first.lists.get("copy", w.account)));
    expect(saved.read && saved.copy.alarm).toMatchObject({ code: "fork", source: "peer", seq: 1 });
  });

  it("take nothing a stranger signed from the PC", async () => {
    const { w, second, desk } = await account();
    const stranger = await w.device({ label: "nobody", register: false });
    const { id, head } = w.held();
    const keys = await stranger.keys();
    const forged = entryToText(await signEntry(kindBody({ issued_at: seconds(w), list: id, prev: head.hash, seq: head.seq + 1, signer: keys.key }, { kind: "remove", endpoint: desk.endpoint }), keys.signs));
    const pc = await memoryPc(w, w.held().entries);
    const page = { list: id, after: head.seq, entries: [forged], head: { seq: head.seq + 1, hash: hashOf(forged) } };
    expect(await second.list.takeFromPeer(page, null)).not.toBeNull();
    // whatever the follower makes of it, nobody is put out, and where the device stands is what members signed
    expect(second.list.holdsPc(desk.endpoint)).toBe(true);
    expect(second.list.gossip()).toEqual(gossipHead(pc.copy()));
    expect(second.list.view().status).toMatchObject({ standing: "in" });
    expect(second.list.view().status).not.toMatchObject({ trouble: "fork" });
  });

  it("act on a removal whose save failed, say it was not taken, and write it at the next round", async () => {
    const { w, first, second, desk } = await account();
    w.fake.tamperList(w.held().id, { reader: { token: second.session.access_token }, withholdAfter: w.held().head.seq });
    await removeListPc(first.list, desk.endpoint, noWait);
    const pc = await memoryPc(w, w.held().entries);
    const ask = second.list.compare(gossipHead(pc.copy()))!;
    const page = servePage(pc.copy(), { list: ask.read!.list, after: ask.read!.after }, 256)!;
    const failing = spyOn(second.lists, "swap").mockImplementation(async () => { throw new DOMException("The disk is full", "QuotaExceededError"); });
    let taken: Awaited<ReturnType<typeof second.list.takeFromPeer>>;
    try { taken = await second.list.takeFromPeer(page, ask.read); } finally { failing.mockRestore(); }
    expect(taken).toMatchObject({ verdict: "caught_up", saved: false });
    // acted on at once
    expect(second.list.holdsPc(desk.endpoint)).toBe(false);
    const stale = await readSave(String(await second.lists.get("copy", w.account)));
    expect(stale.read && shownPcs(stale.copy).length).toBe(1);
    // the next round writes it first, though the account service still withholds it
    w.clock.now += 30_000;
    await second.list.sync();
    const saved = await readSave(String(await second.lists.get("copy", w.account)));
    expect(saved.read && shownPcs(saved.copy).length).toBe(0);
    expect(second.list.holdsPc(desk.endpoint)).toBe(false);
  });
});

describe("a session keeps the list compared", () => {
  it("asks nothing of a PC that follows no list, and nothing at all for an account with no list", async () => {
    const { w, first } = await account();
    const unpinned = await memoryPc(w, w.held().entries, { followsList: false });
    const stop = keepListGossip(sessionOf(unpinned), { list: () => first.list });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(unpinned.calls).toEqual([]);
    // a device of an account with no list holds none: no request, whatever the PC says it follows
    const lone = listWorld("acct_lone");
    const device = await lone.device({ genesis: "never" });
    await device.list.sync();
    expect(device.list.gossip()).toBeNull();
    const pinned = await memoryPc(w, w.held().entries);
    const other = keepListGossip(sessionOf(pinned), { list: () => device.list });
    const none = keepListGossip(sessionOf(pinned), { list: () => null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    other();
    none();
    expect(pinned.calls).toEqual([]);
  });

  it("says where it stands at once, hands a removal it places at once, and says it again on the next carrier", async () => {
    const { w, first, second, desk } = await account();
    const pc = await memoryPc(w, w.held().entries);
    const session = sessionOf(pc);
    const stop = keepListGossip(session, { list: () => first.list });
    try {
      await until(() => pc.calls.length === 1);
      const removed = (await second.keys()).key;
      await removeDevice(first, removed);
      // the copy moved its head: the PC is handed the removal without waiting for anything else
      await until(() => admitsSession(pc.copy(), removed, seconds(w)).why === "removed");
      const made = pc.calls.length;
      session.up(false);
      session.up(true);
      await until(() => pc.calls.length > made);
      expect(pc.calls.at(-1)!.path).toBe("/api/account/list/head");
    } finally { stop(); }
    // stopped: a head that moves after it asks nothing
    const made = pc.calls.length;
    await removeListPc(first.list, desk.endpoint, noWait);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pc.calls.length).toBe(made);
  });

  it("waits as long as the PC says after a 429, and makes no more calls a minute than the PC takes", async () => {
    const { w, first, second } = await account();
    const pc = await memoryPc(w, w.held().entries);
    let clock = 0;
    const timers: { run: () => void; at: number }[] = [];
    const options = {
      list: () => first.list, mono: () => clock,
      setTimer: (run: () => void, ms: number) => { const timer = { run, at: clock + ms }; timers.push(timer); return timer; },
      clearTimer: (timer: unknown) => { timers.splice(timers.indexOf(timer as never), 1); },
    };
    pc.limit = 60;
    const stop = keepListGossip(sessionOf(pc), options);
    try {
      await until(() => pc.calls.length === 1);
      await until(() => timers.length === 1);
      expect(timers[0]!.at).toBe(60_000);
      // nothing is asked before then, however the copy moves
      await removeDevice(first, (await second.keys()).key);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pc.calls.length).toBe(1);
      pc.limit = null;
      clock = 60_000;
      timers.shift()!.run();
      await until(() => pc.calls.length >= 3);
      expect(pc.calls.slice(1).map((call) => call.path)).toEqual(["/api/account/list/head", "/api/account/list/page"]);
      await until(() => timers.length === 1);
      expect(timers[0]!.at).toBe(60_000 + GOSSIP_SECONDS * 1000);
    } finally { stop(); }
    // one exchange spends no more than the minute's calls, and says where its read got to
    let spent = 0;
    const result = await gossipWithPc(pc.fetch, first.list, null, () => ++spent <= 0);
    expect([result.end, spent]).toEqual(["spent", 1]);
    expect(GOSSIP_CALLS_PER_MINUTE).toBeLessThan(30);
  });

  it("goes on with a read the minute's calls cut, from where it got to, while the device stands where it stood", async () => {
    const { w, first } = await account();
    const fork = await otherHistory(w, first);
    const pc = await memoryPc(w, [w.held().entries[0]!, ...fork]);
    let left = 2;
    const cut = await gossipWithPc(pc.fetch, first.list, null, () => left-- > 0);
    expect(cut.end).toBe("spent");
    expect(cut.carry).not.toBeNull();
    const done = await gossipWithPc(pc.fetch, first.list, cut.carry, always);
    expect(done.end).toBe("alarm");
    expect(first.list.view().status).toMatchObject({ trouble: "fork" });
  });
});

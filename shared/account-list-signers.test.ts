import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ListEntryError, entryFromText, entryHash, entryHolds, entryToText, firstState, isListHash, isListKey, readFields, signEntry, verifySignature,
  type EntryBody, type HeldEntry, type ListRefusalCode, type SignerPower,
} from "./account-list-entry.ts";
import {
  firstSignersState, isBehind, judgeEntry, listHead, readSignersState, replayEntries, shownEntries, signerPower, signingPlace,
  type KeyProof, type ListMember, type ListPlace, type ListStop, type PassedOverCode, type ShownAnswer, type SignerRow, type SignersState, type TakenOutcome,
} from "./account-list-signers.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const T0 = 1767225600;

interface Key { readonly name: string; readonly key: string; readonly pair: CryptoKeyPair }
const names = new Map<string, string>();
async function newKey(name: string): Promise<Key> {
  const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
  const key = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  names.set(key, name);
  return { name, key, pair };
}
/** The first drive device; a drive device, a watch device and an invite it adds; a drive device added late. */
const owner = await newKey("owner");
const phone = await newKey("phone");
const watch = await newKey("watch");
const invite = await newKey("invite");
const late = await newKey("late");
/** Keys no entry adds: the service's own, a stranger's, one a machine made for itself, and one a later login lets in. */
const service = await newKey("service");
const stranger = await newKey("stranger");
const machine = await newKey("machine");
const login = await newKey("login");

/** An entry of a test list: its text, and what the next entry is signed on. */
interface Link { readonly text: string; readonly seq: number; readonly hash: string; readonly list: string }
interface Draft {
  readonly kind?: string;
  readonly v?: number;
  readonly adds?: readonly [Key, SignerPower];
  readonly ends?: Key;
  /** Fields set against the chain: how an entry that does not hold is made. */
  readonly change?: Partial<EntryBody>;
  /** Signed with this key while `signer` names another. */
  readonly signedWith?: Key;
}
async function sign(by: Key, body: EntryBody, signedWith: Key = by): Promise<Link> {
  const entry = await signEntry(body, signedWith.pair.privateKey);
  const hash = entryHash(entry.body);
  return { text: entryToText(entry), seq: body.seq, hash, list: body.seq === 0 ? hash : body.list };
}
const genesis = (by: Key = owner, v = 1) => sign(by, { issued_at: T0, kind: "genesis", list: "", prev: "", seq: 0, signer: by.key, v, own: [] });
/** The next entry on `before`, signed by `by`: a `remove` at `v` 1 unless the draft says otherwise. */
function on(before: Link, by: Key, draft: Draft = {}): Promise<Link> {
  return sign(by, {
    issued_at: T0 + 60 * (before.seq + 1), kind: draft.kind ?? "remove", list: before.list, prev: before.hash, seq: before.seq + 1, signer: by.key, v: draft.v ?? 1,
    ...(draft.adds ? { adds: { key: draft.adds[0].key, power: draft.adds[1] } } : {}),
    ...(draft.ends ? { ends: draft.ends.key } : {}),
    own: [], ...draft.change,
  }, draft.signedWith);
}
/** Entries one on another, from `before`. */
async function row(before: Link, ...steps: readonly (readonly [Key, Draft?])[]): Promise<Link[]> {
  const links: Link[] = [];
  let head = before;
  for (const [by, draft] of steps) {
    head = await on(head, by, draft);
    links.push(head);
  }
  return links;
}
/** The same entry with one bit of its signature changed: it does not verify. */
function badlySigned(link: Link): string {
  const entry = entryFromText(link.text);
  const signature = entry.signature.slice();
  signature[7] = (signature[7] ?? 0) ^ 1;
  return entryToText({ body: entry.body, signature });
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
}
const last = <T>(items: readonly T[]): T => at(items, items.length - 1);
const texts = (links: readonly Link[]) => links.map((link) => link.text);
const place = (link: Link): ListPlace => ({ seq: link.seq, hash: link.hash });
const replay = (links: readonly Link[], level = 1, proof?: KeyProof) => replayEntries(texts(links), level, proof ? { proof } : {});
/** A member that took every one of these entries. */
async function memberOf(links: readonly Link[], level = 1, proof?: KeyProof): Promise<ListMember> {
  const { member, stopped } = await replay(links, level, proof);
  if (member === null || stopped !== null || member.entries.length !== links.length) throw new Error("the entries do not all hold");
  return member;
}
const stateOf = async (links: readonly Link[], level = 1, proof?: KeyProof) => (await memberOf(links, level, proof)).state;
const outcomesOf = async (links: readonly Link[], level = 1, proof?: KeyProof) => (await replay(links, level, proof)).took.map((taken) => taken.outcome);
/** What the last of these entries came to. */
const outcomeOf = async (links: readonly Link[], level = 1, proof?: KeyProof) => last(await outcomesOf(links, level, proof));
/** The signers by the names of their keys: the rows that no entry ended. */
const who = (state: SignersState) => Object.fromEntries(Object.entries(state.signers).filter(([, row]) => row.ended === null).map(([key, row]) => [names.get(key) ?? key, row.power]));
/** The keys that entry 0 or an `adds` made a signer, by name, in the order they came in. */
const madeOf = (state: SignersState) => Object.entries(state.signers).filter(([, row]) => row.by !== null).map(([key]) => names.get(key) ?? key);
/** The row of a key that the entry `at` made a signer; `by` signed that entry, or is null where a proof made it one; `ended` is the entry that ended the key. */
const rowBy = (power: SignerPower, at: Link, by: Key | null, ended: Link | null = null): SignerRow => ({ power, seq: at.seq, by: by?.key ?? null, ended: ended?.seq ?? null });
const passedOver = (code: PassedOverCode): TakenOutcome => ({ outcome: "passed_over", code, loose: code === "signer_unknown" });
const reads = (power: SignerPower | null = "full", behind = false): TakenOutcome => ({ outcome: "reads", power, behind });
/** One answer of the log: the entries after `after`, and as its head the last of them unless one is named. */
const answer = (after: Link, shown: readonly Link[], head: ListPlace = place(shown.length > 0 ? last(shown) : after)): ShownAnswer => ({ after: after.seq, entries: texts(shown), head });
/** A result in which nothing happened. */
const quiet = { dropped_from: null, took: [], stopped: null, stuck: false, asks_after: null };
/** Runs `work` on a runtime that calls `meanwhile` once, before it answers the first signature it is asked to verify, and restores the runtime. */
async function whileVerifying<T>(meanwhile: () => void, work: () => Promise<T>): Promise<T> {
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  let called = false;
  const changing = spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
    const verified = await verify(...args);
    if (!called) meanwhile();
    called = true;
    return verified;
  });
  try {
    const result = await work();
    if (!called) throw new Error("no signature was verified");
    return result;
  } finally {
    changing.mockRestore();
  }
}

const g = await genesis();
const addPhone = await on(g, owner, { kind: "device", adds: [phone, "full"] });
const addWatch = await on(addPhone, owner, { kind: "device", adds: [watch, "bound"] });
const addInvite = await on(addWatch, owner, { kind: "invite", adds: [invite, "bound"] });
/** Entry 0 by the owner, then a drive device, a watch device and an invite. */
const base = [g, addPhone, addWatch, addInvite];
const everyone: Readonly<Record<string, SignerPower>> = { owner: "full", phone: "full", watch: "bound", invite: "bound" };
const otherList = (await genesis(phone)).hash;

describe("the signers", () => {
  test("entry 0 makes its own signer the first signer, with power full", async () => {
    const { member, took } = await replay([g]);
    if (member === null) throw new Error("entry 0 does not hold");
    expect(member.state).toEqual({ level: 1, list: g.hash, footing: place(g), needs: 1, behind: null, signers: { [owner.key]: { power: "full", seq: 0, by: owner.key, ended: null } } });
    expect(Object.keys(member.state).sort()).toEqual(["behind", "footing", "level", "list", "needs", "signers"]);
    expect(took.map((taken) => taken.outcome)).toEqual([reads()]);
    expect(firstSignersState(at(took, 0).held, 1)).toEqual(member.state);
  });

  test("every member keeps the signers from adds, power and ends alone, whatever the kind and whether it can read the entry", async () => {
    for (const draft of [{}, { kind: "genesis" }, { kind: "no_such_kind" }, { v: 2 }, { v: 999 }]) {
      const entries = await row(addInvite, [owner, { ...draft, adds: [late, "bound"] }], [phone, { ...draft, ends: watch }]);
      for (const level of [1, 2, 1000]) expect(who(await stateOf([...base, ...entries], level))).toEqual({ owner: "full", phone: "full", invite: "bound", late: "bound" });
    }
  });

  test("the state has one row for each key that was made a signer, never deleted: the entry that made it one, that entry's signer, and the entry that ended it", async () => {
    const entries = await row(addInvite,
      [phone, { kind: "device", adds: [late, "full"] }], [watch, { kind: "device", adds: [stranger, "full"] }], [phone, { ends: watch }],
      [watch, { ends: invite }], [phone, { ends: phone }], [late, { ends: owner }], [owner, { ends: late }]);
    const state = await stateOf([...base, ...entries]);
    expect(state.signers).toEqual({
      [owner.key]: rowBy("full", g, owner, at(entries, 5)),
      [phone.key]: rowBy("full", addPhone, owner, at(entries, 4)),
      [watch.key]: rowBy("bound", addWatch, owner, at(entries, 2)),
      [invite.key]: rowBy("bound", addInvite, owner),
      [late.key]: rowBy("full", at(entries, 0), phone),
    });
    expect(who(state)).toEqual({ invite: "bound", late: "full" });
    expect([signerPower(state, owner.key), signerPower(state, late.key), signerPower(state, stranger.key), signerPower(state, "toString")]).toEqual([null, "full", null, null]);
  });

  test("only a row of its own counts: a name that every object answers to is no signer and has no row", async () => {
    const { took, member } = await replay(base);
    if (member === null) throw new Error("entry 0 does not hold");
    const names = ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"];
    for (const name of names) expect([name, signerPower(member.state, name)]).toEqual([name, null]);
    // An entry that holds never names such a key (a key has its form); a held entry made by hand shows that only a row of the state's own decides.
    const { held } = last(took);
    for (const name of names) {
      const naming: HeldEntry = { ...held, body: { ...held.body, seq: held.body.seq + 1, signer: owner.key, adds: { key: name, power: "bound" } } };
      const judged = judgeEntry(member.state, naming);
      expect([name, judged.outcome]).toEqual([name, reads()]);
      expect([name, signerPower(judged.state, name), Object.keys(judged.state.signers).length]).toEqual([name, "bound", 5]);
      expect([name, judgeEntry(judged.state, { ...naming, body: { ...naming.body, seq: naming.body.seq + 1 } }).outcome]).toEqual([name, passedOver("key_reused")]);
    }
  });

  test("a row is frozen when it is made, and so is every state, with its footing and its rows: writing through a state that a function gives throws, and changes no state it was given", async () => {
    const out = await on(addInvite, owner, { ends: watch });
    const { took, member } = await replay([...base, out]);
    if (member === null) throw new Error("entry 0 does not hold");
    // Entry 0's row, the rows that an adds made, and the row of a key that an ends ended.
    expect(Object.values(firstSignersState(at(took, 0).held, 1).signers).map((row) => Object.isFrozen(row))).toEqual([true]);
    expect(Object.entries(member.state.signers).map(([key, row]) => [names.get(key), row.ended, Object.isFrozen(row)])).toEqual([["owner", null, true], ["phone", null, true], ["watch", 4, true], ["invite", null, true]]);
    // Judging one entry gives a state of its own: a new map, with copies of the rows it was given and the row it writes.
    const before = await stateOf(base);
    const after = judgeEntry(before, last(took).held).state;
    expect([after.signers === before.signers, after.signers[phone.key] === before.signers[phone.key], after.signers[phone.key], after.signers[watch.key] === before.signers[watch.key]]).toEqual([false, false, rowBy("full", addPhone, owner), false]);
    expect([Object.isFrozen(after.signers[watch.key]), before.signers[watch.key]]).toEqual([true, rowBy("bound", addWatch, owner)]);
    // A row cannot be written through the later state, and the earlier state is as it was.
    const kept = JSON.stringify(before);
    const copied: { ended: number | null; power: SignerPower } = after.signers[phone.key] ?? { ended: null, power: "bound" };
    expect(() => {
      copied.ended = 5;
    }).toThrow(TypeError);
    expect(() => {
      copied.power = "bound";
    }).toThrow(TypeError);
    expect([JSON.stringify(before), after.signers[phone.key]]).toEqual([kept, rowBy("full", addPhone, owner)]);
    // Through an answer the member it gives has rows of its own, copies of those it was given: they are frozen as well.
    const shown = await shownEntries(await memberOf(base), answer(addInvite, [out]));
    expect(Object.values(shown.member.state.signers).map((row) => Object.isFrozen(row))).toEqual([true, true, true, true]);
    // Every state this file gives is frozen, with its footing and the map of its rows: of a replay, of entry 0, of one entry judged, of an answer, and read again.
    const again = readSignersState(JSON.parse(JSON.stringify(before)));
    if (again === null) throw new Error("the saved state does not read");
    for (const state of [member.state, firstSignersState(at(took, 0).held, 1), before, after, shown.member.state, again]) {
      expect([Object.isFrozen(state), Object.isFrozen(state.footing), Object.isFrozen(state.signers)]).toEqual([true, true, true]);
    }
  });

  describe("an entry that carries adds and power", () => {
    test("is lawful when its signer is full and the key was never made a signer: the key is a signer with that power from the next entry on", async () => {
      const state = await stateOf(base);
      expect(who(state)).toEqual(everyone);
      expect(madeOf(state)).toEqual(["owner", "phone", "watch", "invite"]);
      expect(state.signers).toEqual({ [owner.key]: rowBy("full", g, owner), [phone.key]: rowBy("full", addPhone, owner), [watch.key]: rowBy("bound", addWatch, owner), [invite.key]: rowBy("bound", addInvite, owner) });
      expect(await outcomesOf(base)).toEqual(base.map(() => reads()));
      const byPhone = await on(addInvite, phone, { kind: "device", adds: [late, "full"] });
      const signs = await on(byPhone, late, { ends: watch });
      expect(who(await stateOf([...base, byPhone, signs]))).toEqual({ owner: "full", phone: "full", invite: "bound", late: "full" });
    });

    test("a key does not sign the entry that adds it", async () => {
      const own = await on(g, phone, { kind: "device", adds: [phone, "full"] });
      expect(await outcomeOf([g, own])).toEqual(passedOver("signer_unknown"));
      expect(who(await stateOf([g, own]))).toEqual({ owner: "full" });
    });

    test("adds by a bound signer is passed over, and the key can still be added", async () => {
      for (const bound of [watch, invite]) {
        const byBound = await on(addInvite, bound, { kind: "device", adds: [late, "full"] });
        expect(await outcomeOf([...base, byBound])).toEqual(passedOver("signer_not_allowed"));
        const state = await stateOf([...base, byBound]);
        expect(who(state)).toEqual(everyone);
        expect(madeOf(state)).not.toContain("late");
        const byOwner = await on(byBound, owner, { kind: "device", adds: [late, "full"] });
        expect(who(await stateOf([...base, byBound, byOwner]))).toEqual({ ...everyone, late: "full" });
      }
    });

    test("of a key that is a signer it is passed over, and the key keeps its power", async () => {
      for (const [key, power] of [[watch, "full"], [phone, "bound"], [owner, "bound"], [phone, "full"]] as const) {
        const again = await on(addInvite, owner, { kind: "device", adds: [key, power] });
        expect(await outcomeOf([...base, again])).toEqual(passedOver("key_reused"));
        expect(who(await stateOf([...base, again]))).toEqual(everyone);
      }
    });

    test("a key coming back: one that an adds made a signer and an ends ended is never made one again", async () => {
      const entries = await row(addInvite, [owner, { ends: phone }], [owner, { kind: "device", adds: [phone, "full"] }], [owner, { kind: "device", adds: [phone, "bound"] }], [phone, { ends: watch }]);
      expect((await outcomesOf([...base, ...entries])).slice(4)).toEqual([reads(), passedOver("key_reused"), passedOver("key_reused"), passedOver("signer_unknown")]);
      const state = await stateOf([...base, ...entries]);
      expect(who(state)).toEqual({ owner: "full", watch: "bound", invite: "bound" });
      expect(state.signers[phone.key]).toEqual(rowBy("full", addPhone, owner, at(entries, 0)));
    });

    test("entry 0's own key is never made a signer again, also after it ended itself", async () => {
      const entries = await row(addInvite, [owner, { ends: owner }], [phone, { kind: "device", adds: [owner, "full"] }]);
      expect(await outcomeOf([...base, ...entries])).toEqual(passedOver("key_reused"));
      expect(who(await stateOf([...base, ...entries]))).toEqual({ phone: "full", watch: "bound", invite: "bound" });
    });
  });

  describe("an entry that carries ends", () => {
    test("is lawful when its signer is full and the key is a signer: the key is no signer from the next entry on", async () => {
      for (const key of [watch, invite, owner]) {
        const out = await on(addInvite, phone, { ends: key });
        expect(await outcomeOf([...base, out])).toEqual(reads());
        expect(who(await stateOf([...base, out]))).toEqual(Object.fromEntries(Object.entries(everyone).filter(([name]) => name !== key.name)));
        expect(await outcomeOf([...base, out, await on(out, key, {})])).toEqual(passedOver("signer_unknown"));
      }
    });

    test("is lawful when its signer is that key itself, full or bound", async () => {
      for (const [key, power] of [[watch, "bound"], [invite, "bound"], [phone, "full"], [owner, "full"]] as const) {
        const out = await on(addInvite, key, { ends: key });
        expect(await outcomeOf([...base, out])).toEqual(reads(power));
        expect(who(await stateOf([...base, out]))).not.toHaveProperty(key.name);
      }
    });

    test("ends of another key by a bound signer is passed over", async () => {
      for (const [by, key] of [[watch, phone], [watch, invite], [invite, owner], [invite, watch]] as const) {
        const out = await on(addInvite, by, { ends: key });
        expect(await outcomeOf([...base, out])).toEqual(passedOver("signer_not_allowed"));
        expect(who(await stateOf([...base, out]))).toEqual(everyone);
      }
    });

    test("of a key that is no signer it is passed over: one never added, and one already ended", async () => {
      const never = await on(addInvite, owner, { ends: late });
      expect(await outcomeOf([...base, never])).toEqual(passedOver("already_out"));
      const twice = await row(addInvite, [owner, { ends: watch }], [owner, { ends: watch }]);
      expect(await outcomeOf([...base, ...twice])).toEqual(passedOver("already_out"));
    });

    test("an ended key never signs again: out is out", async () => {
      const entries = await row(addInvite, [owner, { ends: phone }], [phone, { ends: owner }], [phone, { kind: "device", adds: [late, "full"] }], [phone, { ends: phone }]);
      expect((await outcomesOf([...base, ...entries])).slice(5)).toEqual([passedOver("signer_unknown"), passedOver("signer_unknown"), passedOver("signer_unknown")]);
      expect(who(await stateOf([...base, ...entries]))).toEqual({ owner: "full", watch: "bound", invite: "bound" });
    });

    test("the ends of the last full signer is lawful, and the list then takes no further change", async () => {
      const entries = await row(addInvite, [owner, { ends: phone }], [owner, { ends: owner }], [watch, { kind: "device", adds: [late, "full"] }], [invite, { ends: watch }], [owner, { kind: "device", adds: [late, "full"] }]);
      expect((await outcomesOf([...base, ...entries])).slice(5)).toEqual([reads(), passedOver("signer_not_allowed"), passedOver("signer_not_allowed"), passedOver("signer_unknown")]);
      expect(who(await stateOf([...base, ...entries]))).toEqual({ watch: "bound", invite: "bound" });
    });
  });

  describe("adds and ends are both judged on the state before the entry", () => {
    test("an entry in which both are lawful applies both", async () => {
      const both = await on(addInvite, owner, { kind: "device", adds: [late, "bound"], ends: watch });
      const state = await stateOf([...base, both]);
      expect(who(state)).toEqual({ owner: "full", phone: "full", invite: "bound", late: "bound" });
      expect([state.signers[late.key], state.signers[watch.key]]).toEqual([rowBy("bound", both, owner), rowBy("bound", addWatch, owner, both)]);
      const handsOver = await on(addInvite, owner, { kind: "device", adds: [late, "full"], ends: owner });
      expect(who(await stateOf([...base, handsOver]))).toEqual({ phone: "full", watch: "bound", invite: "bound", late: "full" });
    });

    test("an entry of which one is not lawful is passed over whole", async () => {
      const endsNot = await on(addInvite, owner, { kind: "device", adds: [late, "full"], ends: stranger });
      expect(await outcomeOf([...base, endsNot])).toEqual(passedOver("already_out"));
      const state = await stateOf([...base, endsNot]);
      expect(who(state)).toEqual(everyone);
      expect(madeOf(state)).not.toContain("late");
      const addsNot = await on(addInvite, owner, { kind: "device", adds: [phone, "full"], ends: watch });
      expect(await outcomeOf([...base, addsNot])).toEqual(passedOver("key_reused"));
      expect(who(await stateOf([...base, addsNot]))).toEqual(everyone);
    });

    test("the key an entry adds is not yet a signer for that entry's ends", async () => {
      const both = await on(addInvite, owner, { kind: "device", adds: [late, "full"], ends: late });
      expect(await outcomeOf([...base, both])).toEqual(passedOver("already_out"));
      expect(who(await stateOf([...base, both]))).toEqual(everyone);
    });

    test("the code is that of the first clause that is not lawful: its signer, then adds, then ends, in each the signer's power before the key", async () => {
      const cases: readonly (readonly [Key, Draft, PassedOverCode])[] = [
        [stranger, { adds: [phone, "full"], ends: late }, "signer_unknown"],
        [watch, { adds: [phone, "full"] }, "signer_not_allowed"],
        [watch, { adds: [late, "full"], ends: watch }, "signer_not_allowed"],
        [watch, { ends: late }, "signer_not_allowed"],
        [owner, { adds: [phone, "full"], ends: late }, "key_reused"],
        [owner, { adds: [late, "full"], ends: stranger }, "already_out"],
      ];
      for (const [by, draft, code] of cases) expect(await outcomeOf([...base, await on(addInvite, by, draft)])).toEqual(passedOver(code));
    });
  });

  test("an entry signed by a key that no full signer added changes nothing: the service's own, a stranger's, one a machine made for itself", async () => {
    const plain = await stateOf(base);
    for (const by of [service, stranger, machine]) {
      const entries = await row(addInvite, [by, { kind: "device", adds: [by, "full"] }], [by, { ends: owner }], [by, { kind: "device", adds: [late, "full"] }], [by, { v: 2 }]);
      expect((await outcomesOf([...base, ...entries])).slice(4)).toEqual(entries.map(() => passedOver("signer_unknown")));
      expect(await stateOf([...base, ...entries])).toEqual(plain);
    }
  });

  test("a key that only a passed-over entry named in adds is no signer", async () => {
    const entries = await row(addInvite, [watch, { kind: "device", adds: [late, "full"] }], [late, { ends: owner }]);
    expect(await outcomeOf([...base, ...entries])).toEqual(passedOver("signer_unknown"));
  });
});

describe("the four things a member does with one entry", () => {
  const head = addInvite;

  describe("an entry that does not hold stops it there", () => {
    /** What a member that holds `base` says when it is shown these texts after its head; it must keep its head and its state. */
    const stoppedAt = async (shown: readonly string[]) => {
      const member = await memberOf(base);
      const result = await shownEntries(member, { after: head.seq, entries: shown, head: place(head) });
      expect(result.member).toEqual(member);
      expect(result.took).toEqual([]);
      expect(result.dropped_from).toBeNull();
      return { stopped: result.stopped, stuck: result.stuck, asks_after: result.asks_after };
    };
    const stopped = (code: ListRefusalCode) => ({ stopped: { seq: head.seq + 1, code }, stuck: false, asks_after: null });

    test("in its form", async () => {
      const good = await on(head, owner, {});
      for (const text of [`${good.text}=`, good.text.replace(".", ".."), good.text.slice(0, -1), "", ` ${good.text}`]) expect(await stoppedAt([text])).toEqual(stopped("entry_malformed"));
    });

    test("in its signature: a changed byte, a signature by another key", async () => {
      expect(await stoppedAt([badlySigned(await on(head, owner, {}))])).toEqual(stopped("signature_invalid"));
      expect(await stoppedAt([(await on(head, owner, { signedWith: phone })).text])).toEqual(stopped("signature_invalid"));
    });

    test("in its place: a wrong seq or list, also when it names the head in prev", async () => {
      for (const change of [{ seq: head.seq + 2 }, { seq: head.seq }, { list: otherList }, { prev: "" }]) {
        expect(await stoppedAt([(await on(head, owner, { change })).text])).toEqual(stopped("chain_broken"));
      }
    });

    test("it takes neither that entry nor any after it, and goes on when it is shown one that holds", async () => {
      const member = await memberOf(base);
      const entries = await row(head, [owner, { ends: watch }], [phone, { kind: "device", adds: [late, "full"] }], [late, { ends: invite }]);
      const first = await shownEntries(member, { after: head.seq, entries: [at(entries, 0).text, badlySigned(at(entries, 1)), at(entries, 2).text], head: place(last(entries)) });
      expect(first.stopped).toEqual({ seq: 5, code: "signature_invalid" });
      expect(first.stuck).toBe(false);
      expect(first.member).toEqual(await memberOf([...base, at(entries, 0)]));
      const second = await shownEntries(first.member, answer(at(entries, 0), entries.slice(1)));
      expect(second.stopped).toBeNull();
      expect(second.member).toEqual(await memberOf([...base, ...entries]));
    });
  });

  describe("an entry that holds and is passed over", () => {
    test("is taken, and the head moves on", async () => {
      for (const by of [stranger, watch]) {
        const over = await on(head, by, { kind: "device", adds: [late, "full"] });
        const result = await shownEntries(await memberOf(base), answer(head, [over]));
        expect(listHead(result.member)).toEqual(place(over));
        expect(result.member.entries).toEqual(texts([...base, over]));
        expect(result.took.map((taken) => taken.outcome.outcome)).toEqual(["passed_over"]);
      }
    });

    test("has no effect: nobody in, nobody out, the member is not behind, and it does not count for what the list needs", async () => {
      const plain = await stateOf(base);
      const byStranger = await on(head, stranger, { kind: "later", v: 9, adds: [late, "full"], ends: owner });
      expect(await outcomeOf([...base, byStranger])).toEqual(passedOver("signer_unknown"));
      expect(await stateOf([...base, byStranger])).toEqual(plain);
      const notLawful = await on(head, owner, { kind: "later", v: 9, adds: [late, "full"], ends: stranger });
      expect(await outcomeOf([...base, notLawful])).toEqual(passedOver("already_out"));
      expect(await stateOf([...base, notLawful])).toEqual({ ...plain, footing: place(notLawful) });
    });

    test("is loose when its signer is no signer for the member, and not when a signer signed it", async () => {
      const loose = await on(head, service, {});
      expect(await outcomeOf([...base, loose])).toEqual({ outcome: "passed_over", code: "signer_unknown", loose: true });
      expect((await stateOf([...base, loose])).footing).toEqual(place(head));
      const signed = await on(head, invite, { ends: owner });
      expect(await outcomeOf([...base, signed])).toEqual({ outcome: "passed_over", code: "signer_not_allowed", loose: false });
      expect((await stateOf([...base, signed])).footing).toEqual(place(signed));
    });
  });

  describe("an entry that holds, is not passed over, and whose v is above its level", () => {
    test("it cannot read: adds and ends have applied, and it is behind from this entry on when its signer is full", async () => {
      const later = await on(head, phone, { kind: "later", v: 2, adds: [late, "bound"], ends: watch });
      expect(await outcomeOf([...base, later])).toEqual({ outcome: "cannot_read", power: "full", behind: true });
      const state = await stateOf([...base, later]);
      expect(who(state)).toEqual({ owner: "full", phone: "full", invite: "bound", late: "bound" });
      expect([state.behind, state.needs, isBehind(state)]).toEqual([4, 2, true]);
    });

    test("signed by a bound signer it does not make the member behind, and its ends still applies", async () => {
      for (const bound of [watch, invite]) {
        const later = await on(head, bound, { kind: "later", v: 2, ends: bound });
        expect(await outcomeOf([...base, later])).toEqual({ outcome: "cannot_read", power: "bound", behind: false });
        const state = await stateOf([...base, later]);
        expect(who(state)).not.toHaveProperty(bound.name);
        expect([state.behind, state.needs, isBehind(state)]).toEqual([null, 1, false]);
      }
    });
  });

  describe("an entry that holds, is not passed over, and whose v is at most its level", () => {
    test("it reads, whatever the kind: the entry is its kind's to judge", async () => {
      for (const kind of ["remove", "device", "genesis", "no_such_kind"]) {
        const entry = await on(head, phone, { kind, ends: watch });
        expect(await outcomeOf([...base, entry])).toEqual(reads());
        expect(isBehind(await stateOf([...base, entry]))).toBe(false);
      }
      expect(await outcomeOf([...base, await on(head, invite, { kind: "join" })])).toEqual(reads("bound"));
    });

    test("the level alone decides between reading and not: v L is read, v L + 1 is not", async () => {
      for (const level of [1, 2, 7]) {
        const zero = await genesis(owner, level);
        const same = await on(zero, owner, { kind: "later", v: level });
        const above = await on(zero, owner, { kind: "later", v: level + 1 });
        expect((await outcomeOf([zero, same], level)).outcome).toBe("reads");
        expect((await outcomeOf([zero, above], level)).outcome).toBe("cannot_read");
        expect((await outcomeOf([zero, above], level + 1)).outcome).toBe("reads");
      }
    });
  });

  test("in the last three the head moves on", async () => {
    const entries = await row(head, [stranger, {}], [owner, { kind: "later", v: 2 }], [phone, {}]);
    const result = await shownEntries(await memberOf(base), answer(head, entries));
    expect(result.took.map((taken) => taken.outcome.outcome)).toEqual(["passed_over", "cannot_read", "reads"]);
    expect(listHead(result.member)).toEqual(place(last(entries)));
  });
});

/** A later kind signed by a drive device, and what follows it: a device and a join, then removals by a device it held and by the one added after. */
const fell = await on(addInvite, owner, { kind: "later", v: 2 });
const afterFell = await row(fell, [owner, { kind: "device", adds: [late, "full"] }], [invite, { kind: "join" }], [owner, { ends: phone }], [late, { ends: watch }], [late, {}]);
const behindLog = [...base, fell, ...afterFell];

describe("behind", () => {
  test("the member is behind from the entry on that it cannot read and a full signer signed, and says that it needs an update", async () => {
    const state = await stateOf(behindLog);
    expect([state.behind, state.needs, isBehind(state)]).toEqual([4, 2, true]);
    expect(isBehind(await stateOf(base))).toBe(false);
  });

  test("it lets nobody new in: every entry after that one is read as by a member that is behind", async () => {
    const outcomes = await outcomesOf(behindLog);
    expect(outcomes.slice(0, 4)).toEqual(base.map(() => reads()));
    expect(outcomes.slice(4)).toEqual([{ outcome: "cannot_read", power: "full", behind: true }, reads("full", true), reads("bound", true), reads("full", true), reads("full", true), reads("full", true)]);
  });

  test("it keeps following the chain and the signers, also for keys that came in after it fell behind, and applies every removal", async () => {
    expect(who(await stateOf([...base, fell, at(afterFell, 0)]))).toEqual({ ...everyone, late: "full" });
    expect(who(await stateOf(behindLog))).toEqual({ owner: "full", invite: "bound", late: "full" });
    expect(listHead(await memberOf(behindLog))).toEqual(place(last(afterFell)));
  });

  test("a later kind signed by an unknown key, or by an invite's key, does not make it behind", async () => {
    for (const by of [stranger, service, invite, watch]) {
      const state = await stateOf([...base, await on(addInvite, by, { kind: "later", v: 2 })]);
      expect([state.behind, state.needs]).toEqual([null, 1]);
    }
  });

  test("a kind that its level does not define, written at v 1, does not make it behind, and its ends still applies", async () => {
    const entry = await on(addInvite, owner, { kind: "later", v: 1, ends: phone });
    expect(await outcomeOf([...base, entry])).toEqual(reads());
    expect(who(await stateOf([...base, entry]))).toEqual({ owner: "full", watch: "bound", invite: "bound" });
  });

  test("a known kind at a higher v, signed by a drive device, makes it behind, and its adds still applies", async () => {
    const entry = await on(addInvite, owner, { kind: "device", v: 2, adds: [late, "full"] });
    expect(await outcomeOf([...base, entry])).toEqual({ outcome: "cannot_read", power: "full", behind: true });
    expect(who(await stateOf([...base, entry]))).toEqual({ ...everyone, late: "full" });
  });

  test("with its level raised it replays every entry it kept, from entry 0, and is not behind", async () => {
    const member = await memberOf(behindLog);
    const updated = await replayEntries(member.entries, 2, { given: member.state.list });
    expect(updated.stopped).toBeNull();
    expect(updated.took.map((taken) => taken.outcome)).toEqual([reads(), reads(), reads(), reads(), reads(), reads(), reads("bound"), reads(), reads(), reads()]);
    expect(updated.member).toEqual({ entries: member.entries, state: { ...member.state, level: 2, behind: null } });
  });
});

describe("what a list needs", () => {
  test("is the highest v among its entries that are not passed over and that a full signer signed", async () => {
    const entries = await row(addInvite,
      [owner, { kind: "later", v: 3 }], [watch, { kind: "later", v: 5 }], [stranger, { kind: "later", v: 7 }],
      [owner, { kind: "later", v: 4, ends: stranger }], [phone, { kind: "later", v: 2 }], [invite, { kind: "later", v: 6, ends: invite }]);
    const needs: number[] = [];
    for (let count = 0; count <= entries.length; count++) needs.push((await stateOf([...base, ...entries.slice(0, count)])).needs);
    expect(needs).toEqual([1, 3, 3, 3, 3, 3, 3]);
  });

  test("full is judged after the entries before it: the entry in which a full signer ends itself counts, its next one does not", async () => {
    const entries = await row(addInvite, [phone, { kind: "later", v: 4, ends: phone }], [phone, { kind: "later", v: 9 }]);
    expect((await stateOf([...base, ...entries])).needs).toBe(4);
  });

  test("every reader works it out from its own copy, also from entries it cannot read: it is behind exactly when its level is below it", async () => {
    const entries = await row(addInvite, [owner, { kind: "later", v: 3 }], [phone, { kind: "later", v: 2 }]);
    for (const level of [1, 2, 3, 4]) {
      const state = await stateOf([...base, ...entries], level);
      expect([level, state.needs, isBehind(state), state.behind]).toEqual([level, 3, level < 3, level < 3 ? 4 : null]);
    }
  });

  test("entry 0 is the first that its first signer signed", async () => {
    const zero = await genesis(owner, 2);
    expect(await outcomesOf([zero], 1)).toEqual([{ outcome: "cannot_read", power: "full", behind: true }]);
    const lower = await stateOf([zero], 1);
    const same = await stateOf([zero], 2);
    expect([lower.needs, lower.behind, same.needs, same.behind]).toEqual([2, 0, 2, null]);
  });
});

const root = [g, addPhone];
/** The list as its signers wrote it, after the owner added the phone. */
const real = await row(addPhone, [owner, { kind: "device", adds: [watch, "bound"] }], [phone, { kind: "invite", adds: [invite, "bound"] }], [owner, { ends: watch }], [phone, {}]);
/** What a lying service shows in their place, signed by a key of its own. */
const padding = await row(addPhone, [service, { kind: "device", adds: [service, "full"] }], [service, { ends: owner }], [service, { kind: "device", adds: [late, "full"] }]);
/** Another history under entry 1: the owner adds another device there, and goes on. */
const fork = await row(g, [owner, { kind: "device", adds: [late, "full"] }], [owner, {}], [owner, {}], [owner, {}], [owner, {}], [owner, {}]);

describe("loose entries and the footing", () => {
  test("the footing is the last entry it holds that is not loose, entry 0 at the least", async () => {
    expect((await stateOf([g])).footing).toEqual(place(g));
    expect((await stateOf([g, await on(g, service, {})])).footing).toEqual(place(g));
    expect((await stateOf(root)).footing).toEqual(place(addPhone));
    expect((await stateOf([...root, ...padding])).footing).toEqual(place(addPhone));
    expect((await stateOf([...root, ...real])).footing).toEqual(place(last(real)));
  });

  test("the entries after the footing are all loose, and none of them had an effect", async () => {
    const member = await memberOf([...root, ...padding]);
    expect(member.state).toEqual(await stateOf(root));
    expect((await outcomesOf([...root, ...padding])).slice(2)).toEqual(padding.map(() => passedOver("signer_unknown")));
    expect(listHead(member)).toEqual(place(last(padding)));
  });

  test("an entry by a signer on top of loose entries makes them part of the list, and none of them is dropped", async () => {
    const onTop = await on(last(padding), owner, { kind: "device", adds: [watch, "bound"] });
    const result = await shownEntries(await memberOf([...root, ...padding]), answer(last(padding), [onTop]));
    expect(result.dropped_from).toBeNull();
    expect(result.member.entries).toEqual(texts([...root, ...padding, onTop]));
    expect(result.member.state.footing).toEqual(place(onTop));
    expect(who(result.member.state)).toEqual({ owner: "full", phone: "full", watch: "bound" });
    const later = await shownEntries(result.member, answer(addPhone, real, place(onTop)));
    expect(later).toEqual({ ...quiet, member: result.member, stopped: { seq: 2, code: "chain_broken" }, stuck: true });
  });

  test("so does an entry that a signer signed and that is passed over for a field that is not lawful", async () => {
    const onTop = await on(last(padding), phone, { ends: stranger });
    const result = await shownEntries(await memberOf([...root, ...padding]), answer(last(padding), [onTop]));
    expect(result.took.map((taken) => taken.outcome)).toEqual([passedOver("already_out")]);
    expect(result.member.state).toEqual({ ...(await stateOf(root)), footing: place(onTop) });
  });
});

describe("going back", () => {
  const padded = () => memberOf([...root, ...padding]);

  describe("it learns of another continuation", () => {
    test("when the first entry it is shown does not continue its head: it asks for the entries after its footing, and nothing changes yet", async () => {
      const member = await padded();
      const next = await on(last(real), owner, {});
      for (const shown of [[last(real)], [last(real), next]]) {
        expect(await shownEntries(member, answer(last(padding), shown))).toEqual({ ...quiet, member, asks_after: 1 });
      }
    });

    test("when the answer's head lies at or before its own head with another hash than its own entry at that place", async () => {
      const member = await padded();
      for (const head of [place(at(real, 2)), place(at(real, 1)), place(at(real, 0))]) {
        expect(await shownEntries(member, { after: last(padding).seq, entries: [], head })).toEqual({ ...quiet, member, asks_after: 1 });
      }
    });

    test("not when the answer's head is its own entry at that place: the log is only shorter, and it keeps its loose entries", async () => {
      const member = await padded();
      for (const head of [place(last(padding)), place(at(padding, 0)), place(addPhone), place(g)]) {
        expect(await shownEntries(member, { after: last(padding).seq, entries: [], head })).toEqual({ ...quiet, member });
      }
      expect(await shownEntries(member, { after: addPhone.seq, entries: [], head: place(addPhone) })).toEqual({ ...quiet, member });
    });

    test("and not from a head past its own, which says nothing about what it holds", async () => {
      const member = await padded();
      expect(await shownEntries(member, { after: last(padding).seq, entries: [], head: place(last(real)) })).toEqual({ ...quiet, member });
    });

    test("the head is held again after each entry: at a loose entry it has just taken, with another hash, it takes no further entry of that answer and goes back", async () => {
      const loose = await row(addPhone, [service, {}], [service, {}]);
      const result = await shownEntries(await memberOf(root), answer(addPhone, loose, place(at(real, 0))));
      expect(result.took.map((item) => [item.held.hash, item.outcome.outcome])).toEqual([[at(loose, 0).hash, "passed_over"]]);
      expect({ ...result, took: [] }).toEqual({ ...quiet, member: await memberOf([...root, at(loose, 0)]), asks_after: 1 });
      // A head that names the loose entry it has just taken says nothing, and it takes the next one.
      const plain = await shownEntries(await memberOf(root), answer(addPhone, loose, place(at(loose, 0))));
      expect([plain.asks_after, plain.stopped, plain.member]).toEqual([null, null, await memberOf([...root, ...loose])]);
    });

    test("the head is not held again after an entry that is the same as its own: shown its true loose entry again and then the list's entry in the place of a stale one, it comes to that entry and takes it", async () => {
      /** Its loose entry 2 is the list's own, by a key that it cannot read as a signer; its loose entry 3 is stale. The list's entry 3 is a signer's, on entry 2. */
      const true2 = await on(addPhone, stranger, {});
      const stale3 = await on(true2, service, {});
      const list3 = await on(true2, owner, { kind: "device", adds: [watch, "bound"] });
      const member = await memberOf([...root, true2, stale3]);
      const after = await memberOf([...root, true2, list3]);
      expect([member.state.footing, listHead(member), after.state.footing]).toEqual([place(addPhone), place(stale3), place(list3)]);
      // The honest answer to its asking after its footing: entry 2 again, then the list's entry 3, which is its head.
      const whole = await shownEntries(member, answer(addPhone, [true2, list3]));
      expect(whole.took.map((item) => item.held.hash)).toEqual([list3.hash]);
      expect({ ...whole, took: [] }).toEqual({ ...quiet, member: after, dropped_from: 3 });
      // Cut in two, it ends the same: the first part changes nothing, the second brings it on.
      const first = await shownEntries(member, answer(addPhone, [true2], place(list3)));
      expect(first).toEqual({ ...quiet, member });
      const second = await shownEntries(first.member, answer(true2, [list3]));
      expect({ ...second, took: [] }).toEqual({ ...quiet, member: after, dropped_from: 3 });
    });

    test("nor after its own last entry: an answer that shows all its loose entries again and goes on, under a head that names another entry among them, is taken on, and the head is held after the entry it takes", async () => {
      const member = await padded();
      const onTop = await on(last(padding), owner, {});
      /** Another entry 3 than its own: only a lying service names it as the head of an answer that shows its entry 3 again. */
      const lying = place(at(real, 1));
      // Its own entries are the same, so the head is not held; it takes the entry on top, which a signer signed, and the head then lies under its footing.
      const whole = await shownEntries(member, answer(addPhone, [...padding, onTop], lying));
      expect(whole.took.map((item) => item.held.hash)).toEqual([onTop.hash]);
      expect({ ...whole, took: [] }).toEqual({ ...quiet, member: await memberOf([...root, ...padding, onTop]), stopped: { seq: 3, code: "chain_broken" }, stuck: true });
      // Without the entry on top the answer changes nothing.
      expect(await shownEntries(member, answer(addPhone, padding, lying))).toEqual({ ...quiet, member });
      // That entry alone, in an answer that follows its head, is not taken: the head is held when an answer arrives, and it goes back.
      expect(await shownEntries(member, answer(last(padding), [onTop], lying))).toEqual({ ...quiet, member, asks_after: 1 });
    });
  });

  describe("it is shown the entries after its footing", () => {
    test("padding shown and then the true list: it follows the true list, and its state is as if it had never seen the padding", async () => {
      for (const count of [1, 2, 3]) {
        const member = await memberOf([...root, ...padding.slice(0, count)]);
        const top = last(padding.slice(0, count));
        const learns = await shownEntries(member, answer(top, real.slice(count)));
        expect(learns).toEqual({ ...quiet, member, asks_after: 1 });
        const result = await shownEntries(member, answer(addPhone, real));
        expect(result.dropped_from).toBe(2);
        expect(result.stopped).toBeNull();
        expect(result.took.map((taken) => taken.held.hash)).toEqual(real.map((link) => link.hash));
        expect(result.member).toEqual(await memberOf([...root, ...real]));
      }
    });

    test("an entry that is the same entry as its own at that place changes nothing, whatever its signature", async () => {
      const member = await padded();
      expect(await shownEntries(member, answer(addPhone, padding))).toEqual({ ...quiet, member });
      expect(await shownEntries(member, answer(addPhone, padding.slice(0, 2)))).toEqual({ ...quiet, member });
      const first = entryFromText(at(padding, 0).text);
      const signedAgain = entryToText({ body: first.body, signature: new Uint8Array(await crypto.subtle.sign(SIGN, service.pair.privateKey, new Uint8Array(first.body))) });
      expect(signedAgain).not.toBe(at(padding, 0).text);
      expect(await shownEntries(member, { after: 1, entries: [signedAgain, badlySigned(at(padding, 1))], head: place(last(padding)) })).toEqual({ ...quiet, member });
    });

    test("at the first place where it is another entry that holds there, it drops its own entries from that place on and takes what it is shown", async () => {
      const member = await padded();
      const other = await row(at(padding, 0), [owner, { kind: "device", adds: [watch, "bound"] }], [stranger, {}]);
      const result = await shownEntries(member, answer(addPhone, [at(padding, 0), ...other]));
      expect(result.dropped_from).toBe(3);
      expect(result.member.entries).toEqual(texts([...root, at(padding, 0), ...other]));
      expect(result.took.map((taken) => taken.outcome)).toEqual([reads(), passedOver("signer_unknown")]);
      expect(result.member.state.footing).toEqual(place(at(other, 0)));
      expect(who(result.member.state)).toEqual({ owner: "full", phone: "full", watch: "bound" });
    });

    test("it drops all of its own entries from that place on, also those past the head it is shown", async () => {
      const result = await shownEntries(await padded(), answer(addPhone, real.slice(0, 1)));
      expect(result.dropped_from).toBe(2);
      expect(result.member).toEqual(await memberOf([...root, at(real, 0)]));
    });

    test("nothing it drops had an effect: a key that only a dropped entry named can still be added", async () => {
      const adds = await on(addPhone, owner, { kind: "device", adds: [late, "bound"] });
      const result = await shownEntries(await padded(), answer(addPhone, [adds]));
      expect(who(result.member.state)).toEqual({ owner: "full", phone: "full", late: "bound" });
      expect(madeOf(result.member.state)).toEqual(["owner", "phone", "late"]);
    });

    test("it is done entry by entry: after an entry that does not hold, its head stands at the last entry it took, and what it dropped stays dropped", async () => {
      const other = await row(at(padding, 0), [phone, {}], [owner, {}], [phone, {}]);
      const first = await shownEntries(await padded(), { after: 1, entries: [at(padding, 0).text, at(other, 0).text, badlySigned(at(other, 1)), at(other, 2).text], head: place(last(other)) });
      expect(first.stopped).toEqual({ seq: 4, code: "signature_invalid" });
      expect(first.dropped_from).toBe(3);
      expect(first.member).toEqual(await memberOf([...root, at(padding, 0), at(other, 0)]));
      const second = await shownEntries(first.member, answer(at(other, 0), other.slice(1)));
      expect(second.member).toEqual(await memberOf([...root, at(padding, 0), ...other]));
    });

    test("after a page that breaks off, its own entries before the first place that differed stay", async () => {
      const member = await padded();
      expect(await shownEntries(member, answer(addPhone, padding.slice(0, 1), place(last(real))))).toEqual({ ...quiet, member });
      const other = await row(at(padding, 0), [phone, {}]);
      const next = await shownEntries(member, answer(at(padding, 0), other));
      expect(next.dropped_from).toBe(3);
      expect(next.member).toEqual(await memberOf([...root, at(padding, 0), ...other]));
    });

    test("an entry that does not hold in the place of a loose one stops it, and nothing is dropped", async () => {
      const member = await padded();
      const cases: readonly (readonly [string, ListRefusalCode])[] = [
        [`${at(real, 0).text}=`, "entry_malformed"],
        [badlySigned(at(real, 0)), "signature_invalid"],
        [(await on(addPhone, owner, { change: { seq: 5 } })).text, "chain_broken"],
        [(await on(addPhone, owner, { change: { list: otherList } })).text, "chain_broken"],
      ];
      for (const [text, code] of cases) {
        expect(await shownEntries(member, { after: 1, entries: [text, at(real, 1).text], head: place(last(real)) })).toEqual({ ...quiet, member, stopped: { seq: 2, code } });
      }
    });

    test("an entry further on that does not continue a loose entry before it makes it go back, as the first entry of an answer does", async () => {
      const member = await padded();
      const stray = await on(at(real, 0), owner, {});
      // Its own loose entry, shown again, and then an entry on another entry 2: in one answer, and as the first entry of the next.
      expect(await shownEntries(member, answer(addPhone, [at(padding, 0), stray]))).toEqual({ ...quiet, member, asks_after: 1 });
      expect(await shownEntries(member, answer(at(padding, 0), [stray]))).toEqual({ ...quiet, member, asks_after: 1 });
      // An entry that a signer signed, then a loose one on it, both taken in this answer, then an entry on another entry 3:
      // it asks for the entries after its footing as it then stands.
      const loose = await on(at(real, 0), service, {});
      const result = await shownEntries(await memberOf(root), answer(addPhone, [at(real, 0), loose, await on(at(real, 1), owner, {})]));
      expect(result.took.map((taken) => [taken.held.hash, taken.outcome.outcome])).toEqual([[at(real, 0).hash, "reads"], [loose.hash, "passed_over"]]);
      expect({ ...result, took: [] }).toEqual({ ...quiet, member: await memberOf([...root, at(real, 0), loose]), asks_after: 2 });
      expect([result.member.state.footing, listHead(result.member)]).toEqual([place(at(real, 0)), place(loose)]);
    });

    test("when a later page does not continue the entry it follows, it asks for the entries after its footing again", async () => {
      const member = await padded();
      expect(await shownEntries(member, answer(at(padding, 0), real.slice(1)))).toEqual({ ...quiet, member, asks_after: 1 });
    });
  });

  describe("it is shown another history under its footing", () => {
    const stuckAt = (seq: number): { stopped: ListStop; stuck: boolean } => ({ stopped: { seq, code: "chain_broken" }, stuck: true });

    test("the first entry after its footing does not continue the footing: it stops and says stuck, and keeps its head and its state", async () => {
      for (const links of [root, [...root, ...padding], [...root, ...real]]) {
        const member = await memberOf(links);
        const { seq } = member.state.footing;
        const shown = fork.slice(seq);
        expect(await shownEntries(member, { after: seq, entries: texts(shown), head: place(last(shown)) })).toEqual({ ...quiet, member, ...stuckAt(seq + 1) });
      }
    });

    test("the answer's head lies at or before the footing with another hash than its own entry there", async () => {
      const member = await memberOf([...root, ...real]);
      for (const link of fork.slice(0, 5)) {
        for (const after of [last(real).seq, at(real, 1).seq]) expect(await shownEntries(member, { after, entries: [], head: place(link) })).toEqual({ ...quiet, member, ...stuckAt(link.seq) });
      }
      const loose = await padded();
      expect(await shownEntries(loose, { after: last(padding).seq, entries: [], head: place(at(fork, 0)) })).toEqual({ ...quiet, member: loose, ...stuckAt(1) });
    });

    test("no member goes back under its footing: another entry in the place of one a signer signed is not taken, and nothing is dropped", async () => {
      const member = await memberOf([...root, ...real]);
      const own = place(last(real));
      const other = await row(addPhone, [owner, { ends: phone }], [owner, {}]);
      expect(await shownEntries(member, answer(addPhone, other, own))).toEqual({ ...quiet, member, ...stuckAt(2) });
      expect(await shownEntries(member, answer(at(real, 0), other.slice(1), own))).toEqual({ ...quiet, member, ...stuckAt(3) });
      expect(await shownEntries(member, answer(addPhone, other))).toEqual({ ...quiet, member, ...stuckAt(3) });
      expect(await shownEntries(member, answer(addPhone, real))).toEqual({ ...quiet, member });
    });

    test("the footing moves with each entry it takes, also inside one answer: an entry further on that does not continue it stops the member at once, stuck", async () => {
      /** An entry 3 on another entry 2 than the one the member takes. */
      const elsewhere = await on(at(padding, 0), owner, {});
      const taken = await memberOf([...root, at(real, 0)]);
      const whole = await shownEntries(await memberOf(root), answer(addPhone, [at(real, 0), elsewhere]));
      expect(whole.took.map((item) => [item.held.hash, item.outcome.outcome])).toEqual([[at(real, 0).hash, "reads"]]);
      expect({ ...whole, took: [] }).toEqual({ ...quiet, member: taken, ...stuckAt(3) });
      expect([taken.state.footing, listHead(taken)]).toEqual([place(at(real, 0)), place(at(real, 0))]);
      // The same two entries as two answers end in the same.
      const first = await shownEntries(await memberOf(root), answer(addPhone, [at(real, 0)]));
      expect([first.stopped, first.asks_after, first.member]).toEqual([null, null, taken]);
      expect(await shownEntries(first.member, answer(at(real, 0), [elsewhere]))).toEqual({ ...quiet, member: taken, ...stuckAt(3) });
      // So does an entry that does not continue one of its own entries under the footing, shown again before it.
      const member = await memberOf([...root, ...real]);
      expect(await shownEntries(member, answer(addPhone, [at(real, 0), elsewhere], place(last(real))))).toEqual({ ...quiet, member, ...stuckAt(3) });
      expect(await shownEntries(member, answer(addPhone, [at(real, 0), at(real, 1), await on(elsewhere, owner, {})], place(last(real))))).toEqual({ ...quiet, member, ...stuckAt(4) });
    });

    test("the answer's head is held against the footing as it stands after each entry it takes: at an entry it has just taken, with another hash, it stops there, stuck, and takes no further entry", async () => {
      /** Another entry 2, and another entry 3, than those the answer shows. */
      const [other2, other3] = [place(at(padding, 0)), place(at(padding, 1))];
      const fresh = () => memberOf(root);
      // The head at the first entry it takes: it takes that one and no other.
      for (const shown of [real.slice(0, 2), real.slice(0, 3), real.slice(0, 1)]) {
        const result = await shownEntries(await fresh(), answer(addPhone, shown, other2));
        expect(result.took.map((item) => item.held.hash)).toEqual([at(real, 0).hash]);
        expect({ ...result, took: [] }).toEqual({ ...quiet, member: await memberOf([...root, at(real, 0)]), ...stuckAt(2) });
      }
      // The head at the second entry it takes: it takes both, and stops at the head's place.
      const atSecond = await shownEntries(await fresh(), answer(addPhone, real.slice(0, 3), other3));
      expect(atSecond.took.map((item) => item.held.hash)).toEqual([at(real, 0).hash, at(real, 1).hash]);
      expect({ ...atSecond, took: [] }).toEqual({ ...quiet, member: await memberOf([...root, ...real.slice(0, 2)]), ...stuckAt(3) });
      // A head that is the entry it shows there says nothing, wherever it stands in the answer.
      for (const head of [place(at(real, 0)), place(at(real, 1)), place(at(real, 2))]) {
        expect(await shownEntries(await fresh(), answer(addPhone, real.slice(0, 3), head))).toMatchObject({ stopped: null, stuck: false, asks_after: null, member: await memberOf([...root, ...real.slice(0, 3)]) });
      }
    });

    test("once an entry by a signer has made its own loose entry part of the list, a head that names another entry there is another history under its footing: the stop names the head's place", async () => {
      const member = await memberOf([...root, ...padding.slice(0, 2)]);
      const onLoose = await on(at(padding, 0), owner, { kind: "device", adds: [watch, "bound"] });
      // Its loose entry 2 shown again, then an entry 3 by the owner on it in the place of its loose entry 3, under a head that names another entry 2.
      const result = await shownEntries(member, answer(addPhone, [at(padding, 0), onLoose, await on(onLoose, phone, {})], place(at(real, 0))));
      expect(result.took.map((item) => item.held.hash)).toEqual([onLoose.hash]);
      expect({ ...result, took: [] }).toEqual({ ...quiet, member: await memberOf([...root, at(padding, 0), onLoose]), dropped_from: 3, ...stuckAt(2) });
      expect([result.member.state.footing, listHead(result.member)]).toEqual([place(onLoose), place(onLoose)]);
    });

    test("asked after a place below its footing and shown another entry at the footing's own place, it stops there, stuck, also when the answer's head lies past its own", async () => {
      const member = await memberOf([...root, ...real]);
      const atFooting = await on(at(real, 2), owner, { kind: "device", adds: [late, "full"] });
      const beyond = await on(atFooting, owner, {});
      expect([atFooting.seq, member.state.footing.seq, atFooting.hash === last(real).hash]).toEqual([5, 5, false]);
      for (const head of [place(beyond), place(atFooting)]) {
        expect(await shownEntries(member, { after: 4, entries: texts([atFooting, beyond]), head })).toEqual({ ...quiet, member, ...stuckAt(5) });
        expect(await shownEntries(member, { after: 1, entries: texts([...real.slice(0, 3), atFooting]), head })).toEqual({ ...quiet, member, ...stuckAt(5) });
      }
    });

    test("an entry that fails in more than that is no other history: it stops there, and is not stuck", async () => {
      const member = await memberOf(root);
      const elsewhere = at(fork, 0);
      const cases = [
        await on(elsewhere, owner, { signedWith: phone }),
        await on(elsewhere, owner, { change: { seq: 3 } }),
        await on(elsewhere, owner, { change: { list: otherList } }),
        await on(addPhone, owner, { change: { prev: "" } }),
      ];
      for (const link of cases) expect(await shownEntries(member, { after: 1, entries: [link.text], head: { seq: 2, hash: link.hash } })).toEqual({ ...quiet, member, stopped: { seq: 2, code: "chain_broken" } });
    });

    test("it lasts until it is shown its own history again", async () => {
      const member = await memberOf(root);
      const stuck = await shownEntries(member, answer(addPhone, fork.slice(1)));
      expect([stuck.stuck, stuck.member]).toEqual([true, member]);
      const again = await shownEntries(stuck.member, answer(addPhone, real));
      expect([again.stuck, again.stopped]).toEqual([false, null]);
      expect(again.member).toEqual(await memberOf([...root, ...real]));
    });
  });

  test("what a member does never depends on where an answer was cut: each answer here, cut in two at every place, ends as it does whole", async () => {
    /** An entry 3 on another entry 2 than the true list's, and an entry 4 on it. */
    const elsewhere = await on(at(padding, 0), owner, {});
    const onElsewhere = await on(elsewhere, owner, {});
    /** An entry 3 on the true list's entry 2, by a key nobody added, and an entry 4 on the true list's entry 3. */
    const loose = await on(at(real, 0), service, {});
    const onReal = await on(at(real, 1), owner, {});
    const stray = await on(at(real, 0), owner, {});
    const onLoose = await row(at(padding, 0), [owner, { kind: "device", adds: [watch, "bound"] }], [stranger, {}]);
    const onTop = await row(last(padding), [owner, { kind: "device", adds: [watch, "bound"] }], [phone, {}]);
    const wrongSeq = await on(at(real, 0), owner, { change: { seq: 9 } });
    const wrongList = await on(at(real, 0), owner, { change: { list: otherList } });
    const onPadding = await on(at(padding, 1), service, {});
    const true2 = await on(addPhone, stranger, {});
    const stale3 = await on(true2, service, {});
    const list3 = await on(true2, owner, { kind: "device", adds: [watch, "bound"] });
    const withPadding = [...root, ...padding];
    /** What a member holds, the entry the answer follows, the texts it shows and its head; then how it ends. */
    const cases: readonly (readonly [string, readonly Link[], Link, readonly string[], ListPlace, "stuck" | "asks" | "stopped" | "took"])[] = [
      ["another entry 3 after an entry it takes", root, addPhone, texts([at(real, 0), elsewhere]), place(elsewhere), "stuck"],
      ["another entry 4 after two entries it takes", root, addPhone, texts([at(real, 0), at(real, 1), onElsewhere]), place(onElsewhere), "stuck"],
      ["another entry 4 after its own entries under the footing", [...root, ...real], addPhone, texts([at(real, 0), at(real, 1), onElsewhere]), place(last(real)), "stuck"],
      ["an entry on another entry 2 after its own loose entry", withPadding, addPhone, texts([at(padding, 0), stray]), place(stray), "asks"],
      ["an entry on another entry 3 after a loose entry it takes", root, addPhone, texts([at(real, 0), loose, onReal]), place(onReal), "asks"],
      ["the true list in the place of its padding", withPadding, addPhone, texts(real), place(last(real)), "took"],
      ["other entries from the second place on", withPadding, addPhone, texts([at(padding, 0), ...onLoose]), place(last(onLoose)), "took"],
      ["entries on top of its loose entries", withPadding, last(padding), texts(onTop), place(last(onTop)), "took"],
      ["a signature that does not verify, further on", root, addPhone, [at(real, 0).text, at(real, 1).text, badlySigned(at(real, 2)), at(real, 3).text], place(last(real)), "stopped"],
      ["a wrong seq after an entry it takes", root, addPhone, texts([at(real, 0), wrongSeq, at(real, 1)]), place(at(real, 1)), "stopped"],
      ["another list after an entry it takes", root, addPhone, texts([at(real, 0), wrongList]), place(at(real, 1)), "stopped"],
      // Answers whose head names another entry than one they show: the head is held after each entry that the member takes.
      ["a head at the first entry it takes, with another hash", root, addPhone, texts(real.slice(0, 3)), place(at(padding, 0)), "stuck"],
      ["a head at the second entry it takes, with another hash", root, addPhone, texts(real.slice(0, 3)), place(at(padding, 1)), "stuck"],
      ["a head at the last entry it takes, with another hash", root, addPhone, texts(real.slice(0, 3)), place(at(padding, 2)), "stuck"],
      ["a head at a loose entry it takes, with another hash", root, addPhone, texts([...padding.slice(0, 2), onPadding]), place(at(real, 0)), "asks"],
      // An honest answer to a member that holds the list's own loose entry 2 and a stale entry 3: entry 2 again, then the list's entry 3 as its head.
      ["its true loose entry again, then the list's entry in the place of a stale one", [...root, true2, stale3], addPhone, texts([true2, list3]), place(list3), "took"],
      ["a head at its own loose entry, with another hash, once an entry by a signer has taken the place of the next", [...root, ...padding.slice(0, 2)], addPhone, texts([at(padding, 0), ...onLoose]), place(at(real, 0)), "stuck"],
    ];
    /** What an answer came to, with the entries it took by their hashes. */
    const cameTo = (result: Awaited<ReturnType<typeof shownEntries>>) => ({ ...result, took: result.took.map((item) => [item.held.hash, item.outcome.outcome]) });
    for (const [name, links, after, shown, head, end] of cases) {
      const whole = await shownEntries(await memberOf(links), { after: after.seq, entries: shown, head });
      expect([name, whole.stuck ? "stuck" : whole.stopped !== null ? "stopped" : whole.asks_after !== null ? "asks" : "took"]).toEqual([name, end]);
      for (let cut = 1; cut < shown.length; cut++) {
        const first = await shownEntries(await memberOf(links), { after: after.seq, entries: shown.slice(0, cut), head });
        // A member that stops or asks again is shown nothing more of that answer.
        const second = first.stopped !== null || first.asks_after !== null ? null : await shownEntries(first.member, { after: after.seq + cut, entries: shown.slice(cut), head });
        const inTwo = second === null ? cameTo(first) : { ...cameTo(second), took: [...cameTo(first).took, ...cameTo(second).took], dropped_from: first.dropped_from ?? second.dropped_from };
        expect([name, cut, inTwo]).toEqual([name, cut, cameTo(whole)]);
      }
    }
  });

  test("a lying service cannot turn its own entries into a member's footing", async () => {
    let member = await memberOf(root);
    let head = addPhone;
    for (let round = 0; round < 3; round++) {
      const more = await row(head, [service, { kind: "device", adds: [service, "full"] }], [service, { ends: owner }]);
      member = (await shownEntries(member, answer(head, more))).member;
      head = last(more);
      expect(member.state).toEqual(await stateOf(root));
    }
    expect(member.entries.length).toBe(8);
    expect((await shownEntries(member, answer(addPhone, real))).member).toEqual(await memberOf([...root, ...real]));
  });

  test("a state whose footing is not the member's own entry at that place is the caller's mistake", async () => {
    const member = await memberOf([...root, ...real]);
    const other = await on(at(real, 2), owner, {});
    const states: SignersState[] = [
      { ...member.state, footing: { seq: 6, hash: last(real).hash } },
      { ...member.state, footing: { seq: 5, hash: other.hash } },
      { ...member.state, footing: { seq: 4, hash: last(real).hash } },
    ];
    for (const state of states) await expect(shownEntries({ entries: member.entries, state }, answer(last(real), []))).rejects.toBeInstanceOf(RangeError);
    await expect(shownEntries({ entries: member.entries.slice(0, 3), state: member.state }, answer(at(real, 0), []))).rejects.toBeInstanceOf(RangeError);
    expect(await shownEntries(member, answer(last(real), []))).toEqual({ ...quiet, member });
  });

  test("a proof is handed the rows that the member is taking entries into: a later entry of the same answer, or of the same replay, writes its row into them, so a proof must not keep that state", async () => {
    // Two entries by a key that nobody added, each of which a kind's rule is asked for, and before each of them an entry that adds a key.
    const entries = await row(addPhone,
      [owner, { kind: "device", adds: [watch, "bound"] }], [stranger, { kind: "later_login" }], [owner, { kind: "device", adds: [late, "bound"] }], [stranger, { kind: "later_login" }]);
    for (const through of ["an answer", "a replay"] as const) {
      const handed: SignersState[] = [];
      const keeps: KeyProof = (_held, state) => {
        handed.push(state);
        return null;
      };
      if (through === "an answer") await shownEntries(await memberOf(root), answer(addPhone, entries), keeps);
      else await replayEntries(texts([...root, ...entries]), 1, { proof: keeps });
      const [first, second] = handed;
      if (!first || !second) throw new Error("the rule was not asked twice");
      expect([through, handed.length, first.footing.seq, second.footing.seq]).toEqual([through, 2, 2, 4]);
      // When it was asked first, the late device's key had no row. The state it was handed then has that row now: the rows are one copy, written on.
      expect([through, first.signers === second.signers, Object.keys(first.signers).map((key) => names.get(key))]).toEqual([through, true, ["owner", "phone", "watch", "late"]]);
    }
  });

  test("an answer changes nothing it was given: the member's state and its rows stay as they were, also when they are frozen", async () => {
    const member = await memberOf(base);
    const before = JSON.stringify(member);
    Object.freeze(member.state.signers);
    Object.freeze(member.state);
    const entries = await row(addInvite, [owner, { ends: watch }], [phone, { kind: "device", adds: [late, "full"] }], [late, { ends: invite }]);
    const result = await shownEntries(member, answer(addInvite, entries));
    expect(JSON.stringify(member)).toBe(before);
    expect(result.member).toEqual(await memberOf([...base, ...entries]));
    expect(who(result.member.state)).toEqual({ owner: "full", phone: "full", late: "full" });
    const kept = JSON.stringify(result.member);
    const more = await row(last(entries), [owner, { ends: late }], [phone, { kind: "device", adds: [stranger, "bound"] }]);
    expect(who((await shownEntries(result.member, answer(last(entries), more))).member.state)).toEqual({ owner: "full", phone: "full", stranger: "bound" });
    expect(JSON.stringify(result.member)).toBe(kept);
  });

  test("an answer is taken as the member and the answer were handed over: changed while a signature is checked, they change nothing that comes back", async () => {
    const shown = await row(addPhone, [phone, {}], [owner, {}]);
    const elsewhere = "f".repeat(64);
    /** A member that holds entries 0 and 1 and an answer that shows it entries 2 and 3, each a copy that can be changed; the member's rows are not frozen. */
    const handed = async () => {
      const { entries, state } = await memberOf(root);
      const signers = Object.fromEntries(Object.entries(state.signers).map(([key, row]) => [key, { ...row }]));
      return {
        member: { entries: [...entries], state: { ...state, footing: { ...state.footing }, signers } },
        answer: { after: addPhone.seq, entries: texts(shown), head: { ...place(last(shown)) } },
      };
    };
    const plain = await handed();
    const unchanged = await shownEntries(plain.member, plain.answer);
    expect(unchanged.took.map((taken) => taken.held.hash)).toEqual(shown.map((link) => link.hash));
    const changes: readonly (readonly [string, (given: Awaited<ReturnType<typeof handed>>) => void])[] = [
      ["the state's list id", ({ member }) => { member.state.list = elsewhere; }],
      ["the state's footing", ({ member }) => { member.state.footing.seq = 5; }],
      ["a row taken out of the state", ({ member }) => { delete member.state.signers[phone.key]; }],
      ["each row written", ({ member }) => { for (const row of Object.values(member.state.signers)) row.ended = 1; }],
      ["the answer's entries", ({ answer }) => { answer.entries.length = 1; }],
      ["the answer's head", ({ answer }) => { answer.head.hash = elsewhere; }],
    ];
    for (const [what, change] of changes) {
      const given = await handed();
      // The runtime verifies entry 2, and what the caller handed over changes before the runtime answers.
      const result = await whileVerifying(() => change(given), () => shownEntries(given.member, given.answer));
      expect([what, result]).toEqual([what, unchanged]);
    }
  });

  test("a member's rows are read once, frozen ones too: a row whose power reads otherwise while a signature is checked is taken as it first read", async () => {
    const byWatch = await on(addInvite, watch, { kind: "device", adds: [late, "full"] });
    const member = await memberOf(base);
    const unchanged = await shownEntries(member, answer(addInvite, [byWatch]));
    expect(unchanged.took.map((taken) => taken.outcome)).toEqual([passedOver("signer_not_allowed")]);
    // The watch's row as a frozen object whose power is read from what the caller holds: bound when the answer arrives.
    const live: { power: SignerPower } = { power: "bound" };
    const row = Object.freeze(Object.defineProperty(rowBy("bound", addWatch, owner), "power", { get: () => live.power, enumerable: true }));
    const given = { entries: member.entries, state: { ...member.state, signers: { ...member.state.signers, [watch.key]: row } } };
    expect([Object.isFrozen(row), signerPower(given.state, watch.key)]).toEqual([true, "bound"]);
    // The runtime verifies the watch's entry, and the row says full before the runtime answers.
    const result = await whileVerifying(() => { live.power = "full"; }, () => shownEntries(given, answer(addInvite, [byWatch])));
    expect(result).toEqual(unchanged);
  });

  test("an answer that follows a place the member does not hold is the caller's mistake", async () => {
    const member = await memberOf(root);
    for (const after of [2, -1, 0.5, Number.NaN]) await expect(shownEntries(member, { after, entries: [], head: place(addPhone) })).rejects.toBeInstanceOf(RangeError);
  });
});

describe("what a caller hands in is read as its type names it, whatever carries its fields", () => {
  /** The fields of `data` as getters over it. */
  const getters = (data: object) => Object.fromEntries(Object.keys(data).map((name) => [name, { get: (): unknown => Reflect.get(data, name) }]));
  /** The same data as an object whose fields are getters: inherited from its prototype, or its own and not enumerable. A spread finds no field of either. */
  const carried: readonly (readonly [string, <T extends object>(data: T) => T])[] = [
    ["inherited", (data) => Object.create(Object.create(Object.prototype, getters(data)))],
    ["its own, not enumerable", (data) => Object.create(Object.prototype, getters(data))],
  ];

  test("an answer's head: one that names another entry under the footing stops the member, stuck", async () => {
    // The member holds entry 0 alone; the answer has no entry, and its head names another entry 0.
    const member = await memberOf([g]);
    const other = { seq: 0, hash: otherList };
    const stuck = await shownEntries(member, { after: 0, entries: [], head: other });
    expect([stuck.stuck, stuck.stopped]).toEqual([true, { seq: 0, code: "chain_broken" }]);
    for (const [how, as] of carried) expect([how, await shownEntries(member, { after: 0, entries: [], head: as(other) })]).toEqual([how, stuck]);
  });

  test("a member's state, its footing and its rows: an entry by a signer is read", async () => {
    const member = await memberOf(root);
    const next = await on(addPhone, phone, {});
    const taken = await shownEntries(member, answer(addPhone, [next]));
    expect(taken.took.map((item) => item.outcome)).toEqual([reads()]);
    const { state } = member;
    for (const [how, as] of carried) {
      const states: readonly (readonly [string, SignersState])[] = [
        ["its footing", { ...state, footing: as(state.footing) }],
        ["its rows", { ...state, signers: Object.fromEntries(Object.entries(state.signers).map(([key, row]) => [key, as(row)])) }],
        ["its state", as(state)],
      ];
      for (const [what, given] of states) expect([how, what, await shownEntries({ entries: member.entries, state: given }, answer(addPhone, [next]))]).toEqual([how, what, taken]);
    }
  });

  test("a row that a state's rows hold as a property of their own that is not enumerable is a row: for an answer, for judgeEntry and for a saved state", async () => {
    const member = await memberOf(root);
    const { state } = member;
    /** The phone's row is of the rows' own and not enumerable: signerPower finds it, Object.entries and a spread do not. */
    const hidden = { ...state, signers: Object.defineProperty({ ...state.signers }, phone.key, { enumerable: false }) };
    expect([Object.keys(hidden.signers).length, signerPower(hidden, phone.key)]).toEqual([1, "full"]);
    const next = await on(addPhone, phone, { kind: "device", adds: [watch, "bound"] });
    const taken = await shownEntries(member, answer(addPhone, [next]));
    expect(taken.took.map((item) => item.outcome)).toEqual([reads()]);
    expect(await shownEntries({ entries: member.entries, state: hidden }, answer(addPhone, [next]))).toEqual(taken);
    expect(judgeEntry(hidden, at(taken.took, 0).held).state.signers).toEqual(taken.member.state.signers);
    expect(readSignersState(hidden)).toEqual(state);
  });

  test("judgeEntry: the state it gives has the level and the list of the one it was given, and a key it ends keeps the rest of its row", async () => {
    const out = await on(addInvite, owner, { ends: watch });
    const state = await stateOf(base);
    const { held } = last((await replay([...base, out])).took);
    const plain = judgeEntry(state, held);
    expect(plain.state.signers[watch.key]).toEqual(rowBy("bound", addWatch, owner, out));
    for (const [how, as] of carried) {
      expect([how, judgeEntry(as(state), held)]).toEqual([how, plain]);
      const rows = Object.fromEntries(Object.entries(state.signers).map(([key, row]) => [key, as(row)]));
      expect([how, judgeEntry({ ...state, signers: rows }, held).state.signers[watch.key]]).toEqual([how, rowBy("bound", addWatch, owner, out)]);
    }
  });
});

describe("what a caller hands in is taken once, when it is handed over", () => {
  const isData = (value: unknown): value is object => typeof value === "object" && value !== null && !(value instanceof Uint8Array);
  /** `value` as plain frozen data: every object and list in it copied and frozen. Bytes and functions are kept as they are. */
  function frozen<T>(value: T): T {
    if (!isData(value)) return value;
    const copy: T & object = Array.isArray(value) ? Object.assign([], value) : { ...value };
    for (const name of Object.keys(copy)) Reflect.set(copy, name, frozen(Reflect.get(copy, name)));
    Object.freeze(copy);
    return copy;
  }
  /**
   * `first` behind a Proxy: each field reads as `first` has it the first time it is read, and as `later` has it at every
   * reading after that; an object or a list in a field is handed out the same way. Once `turned` says so, an object that was
   * handed out before then reads as `later` has it at every reading. Bytes and functions are handed out as they are.
   */
  function shifting<T extends object>(first: T, later: T, turned: () => boolean): T {
    const read = new Set<string>();
    const born = turned();
    const target: T = Array.isArray(first) ? Object.assign([], first) : { ...first };
    return new Proxy(target, {
      get(_target, name) {
        if (typeof name === "symbol") return Reflect.get(first, name);
        const [now, then] = read.has(name) || (!born && turned()) ? [later, first] : [first, later];
        read.add(name);
        const value: unknown = Reflect.get(now, name);
        const other: unknown = Reflect.get(then, name);
        return isData(value) ? shifting(value, isData(other) ? other : value, turned) : value;
      },
    });
  }
  /** How a call hands over what the caller holds: `first` is what it reads as at first, `later` what it reads as after that. */
  type Handed = <T extends object>(first: T, later: T) => T;

  test("every function gives, for objects that read otherwise at each reading after the first, what it gives for plain frozen data of what they first read: so also when they read otherwise from the moment a signature is being checked", async () => {
    // Two members, each of a list of its own: the first is what every object reads as at first, the second what it reads as after that.
    const more = await row(addInvite, [owner, { kind: "device", adds: [late, "full"] }], [phone, { ends: watch }]);
    const a = await memberOf(base);
    const tookA = (await replay([...base, ...more])).took;
    const otherZero = await genesis(phone);
    const others = [otherZero, ...(await row(otherZero,
      [phone, { kind: "device", adds: [watch, "full"] }], [phone, { kind: "device", adds: [owner, "bound"] }], [watch, { v: 5 }], [phone, { ends: owner }], [watch, {}], [phone, {}], [watch, {}]))];
    const b = await memberOf(others.slice(0, 5), 3);
    const tookB = (await replay(others, 3)).took;
    const shownA = answer(addInvite, more);
    const shownB = answer(at(others, 4), others.slice(5));
    // A member of level 2, and a key that a later kind lets in on a proof: the proof reads what it is handed, and what it answers is handed over too.
    const above = await memberOf(base, 2);
    const enters = await on(addInvite, login, { kind: "later_login" });
    const byLogin = await on(enters, login, { kind: "device", adds: [late, "bound"] });
    const entersHeld = at((await replay([...base, enters], 2)).took, 4).held;
    const lets = (handed: Handed): KeyProof => (held, state) =>
      held.hash === enters.hash && held.body.signer === login.key && state.level === 2 && state.footing.seq === addInvite.seq
        ? handed<NonNullable<ReturnType<KeyProof>>>({ key: login.key, power: "full" }, { key: stranger.key, power: "bound" }) : null;
    const entry = (link: Link) => entryFromText(link.text);
    const saved = (state: SignersState): SignersState => JSON.parse(JSON.stringify(state));

    /** Each call: the function, whether a signature is checked in it, and the call itself, which hands over what `handed` makes of the two. */
    const calls: readonly (readonly [string, boolean, (handed: Handed) => unknown])[] = [
      ["signerPower", false, (handed) => signerPower(handed(a.state, b.state), watch.key)],
      ["isBehind", false, (handed) => isBehind(handed(a.state, b.state))],
      ["firstSignersState", false, (handed) => firstSignersState(handed(at(tookA, 0).held, at(tookB, 0).held), 1)],
      ["judgeEntry", false, (handed) => judgeEntry(handed(a.state, b.state), handed(at(tookA, 4).held, at(tookB, 1).held))],
      ["judgeEntry, its state alone", false, (handed) => judgeEntry(handed(a.state, b.state), frozen(at(tookA, 4).held))],
      ["judgeEntry, its entry alone", false, (handed) => judgeEntry(frozen(a.state), handed(at(tookA, 4).held, at(tookB, 1).held))],
      ["judgeEntry, with a proof", false, (handed) => judgeEntry(handed(above.state, b.state), handed(entersHeld, at(tookB, 1).held), lets(handed))],
      ["listHead", false, (handed) => listHead(handed(a, b))],
      ["signingPlace", false, (handed) => signingPlace(handed(a, b), handed(place(addInvite), place(at(others, 4))))],
      ["readSignersState", false, (handed) => readSignersState(handed(saved(a.state), saved(b.state)))],
      ["shownEntries", true, (handed) => shownEntries(handed(a, b), handed(shownA, shownB))],
      ["shownEntries, with a proof", true, (handed) => shownEntries(handed(above, b), handed(answer(addInvite, [enters, byLogin]), shownB), lets(handed))],
      ["shownEntries, shown its own entry again", false, (handed) => shownEntries(handed(a, b), handed(answer(addWatch, [addInvite]), shownB))],
      ["replayEntries", true, (handed) => replayEntries(handed(texts([...base, ...more]), texts(others)), 1, handed({ given: g.hash }, { given: otherZero.hash }))],
      ["replayEntries, with a proof", true, (handed) => replayEntries(handed(texts([...base, enters, byLogin]), texts(others)), 2, handed({ proof: lets(handed) }, { proof: () => null }))],
      ["replayEntries, of what is no entry", false, (handed) => replayEntries(handed(["not an entry"], texts(others)), 1, handed({}, { given: otherZero.hash }))],
      ["entryHolds", true, (handed) => entryHolds(handed(entry(addPhone), entry(at(others, 2))), handed(at(tookA, 0).held, at(tookB, 1).held))],
      ["entryHolds, of an entry out of its place", false, (handed) => entryHolds(handed(entry(addWatch), entry(at(others, 2))), handed(at(tookA, 0).held, at(tookB, 1).held))],
      ["firstState", true, (handed) => firstState(handed(entry(g), entry(otherZero)), g.hash)],
    ];
    /** What a call came to: what it gave, or the refusal or the error it threw. */
    const cameTo = async (work: () => unknown): Promise<unknown> => {
      try {
        return await work();
      } catch (error) {
        return { thrown: error instanceof ListEntryError ? error.code : String(error) };
      }
    };
    const blind: string[] = [];
    const differs: string[] = [];
    for (const [name, verifies, call] of calls) {
      const plain = await cameTo(() => call((first) => frozen(first)));
      // The call tells the two apart: handed what is read later, it comes to something else.
      if (isDeepStrictEqual(await cameTo(() => call((_first, later) => frozen(later))), plain)) blind.push(name);
      if (!isDeepStrictEqual(await cameTo(() => call((first, later) => shifting(first, later, () => false))), plain)) differs.push(name);
      if (!verifies) continue;
      let turned = false;
      const pending = await cameTo(() => whileVerifying(() => { turned = true; }, async () => call((first, later) => shifting(first, later, () => turned))));
      if (!isDeepStrictEqual(pending, plain)) differs.push(`${name}, while a signature is checked`);
    }
    expect({ blind, differs }).toEqual({ blind: [], differs: [] });
  });
});

describe("where a member signs", () => {
  test("only on its footing: the place after it, on its hash", async () => {
    const member = await memberOf([...root, ...real]);
    expect(signingPlace(member, place(last(real)))).toEqual({ list: g.hash, prev: last(real).hash, seq: 6 });
  });

  test("when the head it is shown lies past its footing, it places nothing", async () => {
    const member = await memberOf([...root, ...padding]);
    expect(signingPlace(member, place(last(padding)))).toBeNull();
    expect(signingPlace(member, place(at(padding, 0)))).toBeNull();
    expect(signingPlace(await memberOf(root), place(at(real, 0)))).toBeNull();
  });

  test("shown another entry at or under its footing, it places nothing: that is another history, which an answer stops as stuck", async () => {
    const zero = await memberOf([g]);
    const other = { seq: 0, hash: otherList };
    expect(signingPlace(zero, other)).toBeNull();
    expect(await shownEntries(zero, { after: 0, entries: [], head: other })).toMatchObject({ stopped: { seq: 0, code: "chain_broken" }, stuck: true });
    const member = await memberOf([...root, ...real]);
    for (const link of fork.slice(0, 5)) expect([link.seq, signingPlace(member, place(link))]).toEqual([link.seq, null]);
    expect(signingPlace(member, place(at(real, 1)))).toEqual({ list: g.hash, prev: last(real).hash, seq: 6 });
    for (const seq of [-1, 0.5, Number.NaN]) expect([seq, signingPlace(member, { seq, hash: g.hash })]).toEqual([seq, null]);
  });

  test("with loose entries of its own and a log that ends at its footing, it signs on its footing; its entry takes their place when the log shows it", async () => {
    const member = await memberOf([...root, ...padding]);
    expect(signingPlace(member, place(addPhone))).toEqual({ list: g.hash, prev: addPhone.hash, seq: 2 });
    const placed = at(real, 0);
    expect((await shownEntries(member, { after: last(padding).seq, entries: [], head: place(placed) })).asks_after).toBe(1);
    expect((await shownEntries(member, answer(addPhone, [placed]))).member).toEqual(await memberOf([...root, placed]));
  });
});

/** A later kind turns that way in on; an entry the login key signs lets it in on a proof of its own; then the key signs. */
const turnsOn = await on(addPhone, owner, { kind: "later", v: 2 });
const enters = await on(turnsOn, login, { kind: "later_login", v: 2 });
const byLogin = await row(enters, [login, { kind: "device", adds: [late, "bound"] }], [login, { ends: phone }]);
const loginLog = [...root, turnsOn, enters, ...byLogin];
/** The rule of that later kind, for a member that reads it. */
const letsIn = (power: SignerPower, key: Key = login, entry: Link = enters): KeyProof => (held) => (held.hash === entry.hash ? { key: key.key, power } : null);

describe("a member of a higher level, and a key that a later kind lets in on a proof of its own", () => {
  test("it holds the key as a signer from the next entry on, with the power that kind names, and applies what the key signs", async () => {
    const member = await memberOf(loginLog, 2, letsIn("full"));
    expect(who(member.state)).toEqual({ owner: "full", login: "full", late: "bound" });
    expect(madeOf(member.state)).toEqual(["owner", "phone", "late"]);
    expect(member.state.signers[login.key]).toEqual(rowBy("full", enters, null));
    expect(Object.isFrozen(member.state.signers[login.key])).toBe(true);
    expect([member.state.signers[late.key], member.state.signers[phone.key]]).toEqual([rowBy("bound", at(byLogin, 0), login), rowBy("full", addPhone, owner, at(byLogin, 1))]);
    expect(member.state.footing).toEqual(place(last(byLogin)));
    expect((await outcomesOf(loginLog, 2, letsIn("full"))).slice(3)).toEqual([reads(null), reads(), reads()]);
    expect(who(await stateOf([...root, turnsOn, enters], 2, letsIn("bound")))).toEqual({ owner: "full", phone: "full", login: "bound" });
    expect((await outcomesOf(loginLog, 2, letsIn("bound"))).slice(4)).toEqual([passedOver("signer_not_allowed"), passedOver("signer_not_allowed")]);
  });

  test("an older member is behind before the key appears, and passes over that entry and everything the key signs", async () => {
    const member = await memberOf(loginLog, 1);
    expect(who(member.state)).toEqual({ owner: "full", phone: "full" });
    expect([member.state.behind, member.state.footing]).toEqual([2, place(turnsOn)]);
    expect((await outcomesOf(loginLog, 1)).slice(3)).toEqual([passedOver("signer_unknown"), passedOver("signer_unknown"), passedOver("signer_unknown")]);
    expect(await stateOf(loginLog, 2)).toEqual({ ...member.state, level: 2, behind: null });
  });

  test("what a login key signed is not loose for it, and it never drops it; the older member drops it, and takes it again when it is shown it", async () => {
    const other = await row(turnsOn, [service, {}], [service, {}], [service, {}], [service, {}]);
    const higher = await memberOf(loginLog, 2, letsIn("full"));
    expect(await shownEntries(higher, answer(last(byLogin), other.slice(3)), letsIn("full"))).toEqual({ ...quiet, member: higher, stopped: { seq: 6, code: "chain_broken" }, stuck: true });
    expect(await shownEntries(higher, answer(turnsOn, other), letsIn("full"))).toEqual({ ...quiet, member: higher, stopped: { seq: 3, code: "chain_broken" }, stuck: true });
    const older = await memberOf(loginLog, 1);
    expect(await shownEntries(older, answer(last(byLogin), other.slice(3)))).toEqual({ ...quiet, member: older, asks_after: 2 });
    const dropped = await shownEntries(older, answer(turnsOn, other));
    expect(dropped.dropped_from).toBe(3);
    expect(dropped.member).toEqual(await memberOf([...root, turnsOn, ...other], 1));
    expect((await shownEntries(dropped.member, answer(turnsOn, [enters, ...byLogin]))).member).toEqual(older);
  });

  test("the entry that lets the key in is part of the list for it: it is not dropped either", async () => {
    const higher = await memberOf([...root, turnsOn, enters], 2, letsIn("full"));
    expect(higher.state.footing).toEqual(place(enters));
    const other = await row(turnsOn, [service, {}]);
    expect(await shownEntries(higher, answer(turnsOn, other), letsIn("full"))).toEqual({ ...quiet, member: higher, stopped: { seq: 3, code: "chain_broken" }, stuck: true });
  });

  test("it may hold fewer signers than an older member only where such a key signed the ends, which the older member passes over until its update", async () => {
    const older = await memberOf(loginLog, 1);
    expect(signerPower(older.state, phone.key)).toBe("full");
    const updated = await replayEntries(older.entries, 2, { proof: letsIn("full") });
    const higher = await memberOf(loginLog, 2, letsIn("full"));
    expect(updated.member).toEqual(higher);
    expect(signerPower(higher.state, phone.key)).toBeNull();
  });

  test("after an update, an entry whose signer a login key had ended is then loose", async () => {
    const byPhone = await on(last(byLogin), phone, { kind: "device", adds: [watch, "bound"] });
    const older = await memberOf([...loginLog, byPhone], 1);
    expect([older.state.footing, signerPower(older.state, watch.key)]).toEqual([place(byPhone), "bound"]);
    const updated = await replayEntries(older.entries, 2, { proof: letsIn("full") });
    if (updated.member === null) throw new Error("the replay holds no entry");
    expect(last(updated.took).outcome).toEqual(passedOver("signer_unknown"));
    expect([updated.member.state.footing, signerPower(updated.member.state, watch.key)]).toEqual([place(last(byLogin)), null]);
  });

  describe("a proof lets in the signer of its own entry only, and only a key that was never made a signer", () => {
    test("a proof that names another key than the signer of its entry lets nobody in: the entry is passed over, and loose", async () => {
      const links = [...root, turnsOn, enters];
      const plain = await stateOf([...root, turnsOn], 2);
      for (const key of [stranger, late, phone, owner]) {
        for (const power of ["full", "bound"] as const) {
          expect(await outcomeOf(links, 2, letsIn(power, key))).toEqual(passedOver("signer_unknown"));
          expect(await stateOf(links, 2, letsIn(power, key))).toEqual(plain);
        }
      }
      expect((await outcomesOf(loginLog, 2, letsIn("full", stranger))).slice(3)).toEqual([passedOver("signer_unknown"), passedOver("signer_unknown"), passedOver("signer_unknown")]);
      expect(await stateOf(loginLog, 2, letsIn("full", stranger))).toEqual(plain);
    });

    test("a key that a proof made a signer and an ends ended does not come back by a second proof: out is out", async () => {
      const out = await on(enters, owner, { ends: login });
      const again = await on(out, login, { kind: "later_login", v: 2 });
      const signs = await on(again, login, { ends: phone });
      const proof: KeyProof = (held) => (held.hash === enters.hash || held.hash === again.hash ? { key: login.key, power: "full" } : null);
      const links = [...root, turnsOn, enters, out, again, signs];
      expect((await outcomesOf(links, 2, proof)).slice(3)).toEqual([reads(null), reads(), passedOver("signer_unknown"), passedOver("signer_unknown")]);
      const state = await stateOf(links, 2, proof);
      expect(state.signers[login.key]).toEqual(rowBy("full", enters, null, out));
      expect([state.footing, who(state)]).toEqual([place(out), { owner: "full", phone: "full" }]);
    });

    test("a proof for a key that an adds made a signer and an ends ended lets nobody in, and its entry is loose: the footing stays, and the entry can be dropped", async () => {
      const out = await on(turnsOn, owner, { ends: phone });
      const again = await on(out, phone, { kind: "later_login", v: 2 });
      const links = [...root, turnsOn, out, again];
      const under = await stateOf(links.slice(0, 4), 2);
      for (const power of ["full", "bound"] as const) {
        const proof = letsIn(power, phone, again);
        expect(await outcomeOf(links, 2, proof)).toEqual(passedOver("signer_unknown"));
        const state = await stateOf(links, 2, proof);
        expect(state).toEqual(under);
        expect([state.footing, state.signers[phone.key]]).toEqual([place(out), rowBy("full", addPhone, owner, out)]);
      }
      const proof = letsIn("full", phone, again);
      const other = await on(out, owner, {});
      const result = await shownEntries(await memberOf(links, 2, proof), answer(out, [other]), proof);
      expect([result.dropped_from, result.stuck, result.stopped, listHead(result.member)]).toEqual([4, false, null, place(other)]);
    });

    test("a proof changes no key that is a signer: an entry that a signer signed is read as any entry of its signer's, and the key keeps its power", async () => {
      const cases = [[watch, "bound", "full"], [phone, "full", "bound"], [owner, "full", "bound"]] as const;
      for (const [key, has, named] of cases) {
        const byIt = await on(addInvite, key, { kind: "later_login", v: 1 });
        const proof = letsIn(named, key, byIt);
        expect(await outcomeOf([...base, byIt], 2, proof)).toEqual(reads(has));
        const state = await stateOf([...base, byIt], 2, proof);
        expect(state).toEqual(await stateOf([...base, byIt], 2));
        expect([state.footing, signerPower(state, key.key)]).toEqual([place(byIt), has]);
      }
    });
  });

  test("an adds that names such a key is judged as it is written, at every level: both end with the same power for that key", async () => {
    for (const power of ["full", "bound"] as const) {
      const named = await on(enters, owner, { kind: "device", adds: [login, power] });
      const higher = await stateOf([...root, turnsOn, enters, named], 2, letsIn(power === "full" ? "bound" : "full"));
      const older = await stateOf([...root, turnsOn, enters, named], 1);
      expect([signerPower(higher, login.key), signerPower(older, login.key)]).toEqual([power, power]);
      expect([madeOf(higher), madeOf(older)]).toEqual([["owner", "phone", "login"], ["owner", "phone", "login"]]);
      expect(higher.signers[login.key]).toEqual(rowBy(power, named, owner));
      expect(higher.signers).toEqual(older.signers);
    }
  });

  test("a full signer, or the key itself, ends such a key as it ends any other", async () => {
    for (const by of [owner, login]) {
      const out = await on(enters, by, { ends: login });
      const state = await stateOf([...root, turnsOn, enters, out], 2, letsIn("bound"));
      expect(who(state)).toEqual({ owner: "full", phone: "full" });
      expect(state.signers[login.key]).toEqual(rowBy("bound", enters, null, out));
    }
  });

  test("an entry that names such a key in adds and in ends applies both: the key is out, and is never made a signer again", async () => {
    const both = await on(enters, owner, { kind: "device", adds: [login, "full"], ends: login });
    const back = await on(both, owner, { kind: "device", adds: [login, "full"] });
    const links = [...root, turnsOn, enters, both, back];
    expect((await outcomesOf(links, 2, letsIn("full"))).slice(4)).toEqual([reads(), passedOver("key_reused")]);
    const state = await stateOf(links, 2, letsIn("full"));
    expect(who(state)).toEqual({ owner: "full", phone: "full" });
    expect(madeOf(state)).toEqual(["owner", "phone", "login"]);
    expect(state.signers[login.key]).toEqual(rowBy("full", both, owner, both));
  });

  test("the proof is asked only for an entry the member reads, also while it is behind, whose signer has no row and that carries no adds and no ends", async () => {
    const asked: string[] = [];
    const never: KeyProof = (held) => {
      asked.push(held.hash);
      return null;
    };
    const out = await on(turnsOn, owner, { ends: phone });
    const entries = await row(out,
      [login, { kind: "later_login", v: 2 }], [login, { kind: "later_login", v: 3 }], [login, { kind: "later_login", v: 2, adds: [late, "full"] }],
      [login, { kind: "later_login", v: 2, ends: owner }], [owner, { kind: "later_login", v: 2 }], [phone, { kind: "later_login", v: 2 }], [stranger, { kind: "later_login", v: 1 }]);
    const links = [...root, turnsOn, out, ...entries];
    await stateOf(links, 2, never);
    expect(asked).toEqual([at(entries, 0).hash, at(entries, 6).hash]);
    asked.length = 0;
    const lower = await stateOf(links, 1, never);
    expect([asked, isBehind(lower)]).toEqual([[at(entries, 6).hash], true]);
  });
});

describe("a saved state", () => {
  test("is plain data: JSON saves it, readSignersState reads it again, and the member goes on from it", async () => {
    const member = await memberOf([...base, fell]);
    const saved = JSON.stringify(member.state);
    const loaded = readSignersState(JSON.parse(saved));
    if (loaded === null) throw new Error("the saved state does not read");
    expect(loaded).toEqual(member.state);
    expect(JSON.stringify(loaded)).toBe(saved);
    expect(Object.values(loaded.signers).map((row) => Object.isFrozen(row))).toEqual(Object.keys(member.state.signers).map(() => true));
    const fromLoaded = await shownEntries({ entries: member.entries, state: loaded }, answer(fell, afterFell));
    expect(fromLoaded).toEqual(await shownEntries(member, answer(fell, afterFell)));
    expect(fromLoaded.member).toEqual(await memberOf(behindLog));
  });

  test("a state of a higher level reads again: a row that a proof made, and one whose key came in and went in one entry", async () => {
    const both = await on(enters, owner, { kind: "device", adds: [login, "bound"], ends: login });
    for (const state of [await stateOf(loginLog, 2, letsIn("full")), await stateOf([...root, turnsOn, enters, both], 2, letsIn("full"))]) {
      const saved = JSON.stringify(state);
      expect(readSignersState(JSON.parse(saved))).toEqual(state);
      expect(JSON.stringify(readSignersState(JSON.parse(saved)))).toBe(saved);
    }
  });

  test("members it does not name are left out, also those of a state that begins with it", async () => {
    const state = await stateOf(base);
    const fuller = {
      ...state, head: place(addInvite), first_signer: owner.key, footing: { ...state.footing, text: "x" },
      signers: Object.fromEntries(Object.entries(state.signers).map(([key, row]) => [key, { ...row, as: "device", label: "x" }])),
    };
    expect(readSignersState(fuller)).toEqual(state);
  });

  test("anything that has not its form, or does not agree with itself, is null", async () => {
    const state = await stateOf([...base, ...(await row(addInvite, [owner, { kind: "later", v: 3 }], [owner, { ends: watch }]))]);
    expect(readSignersState(state)).toEqual(state);
    expect([state.level, state.needs, state.behind, state.footing.seq, state.signers[watch.key]?.ended]).toEqual([1, 3, 4, 5, 5]);
    const hash = "ab".repeat(32);
    const first = state.signers[owner.key];
    /** The state with one row changed. */
    const withRow = (key: Key, change: object): unknown => ({ ...state, signers: { ...state.signers, [key.key]: { ...state.signers[key.key], ...change } } });
    const broken: readonly unknown[] = [
      null, undefined, "state", 7, [], [state],
      { ...state, level: 0 }, { ...state, level: 1.5 }, { ...state, level: "1" }, { ...state, level: -1 }, { ...state, level: 2 ** 53 },
      { ...state, list: hash.toUpperCase() }, { ...state, list: "" }, { ...state, list: 7 },
      { ...state, footing: null }, { ...state, footing: { seq: -1, hash } }, { ...state, footing: { seq: 5, hash: "x" } }, { ...state, footing: { seq: "5", hash } },
      { ...state, footing: { seq: 0, hash }, behind: 0, signers: { [owner.key]: first } },
      { ...state, needs: 0 }, { ...state, needs: "3" }, { ...state, needs: 1 }, { ...state, behind: null }, { ...state, level: 3 },
      { ...state, behind: 6 }, { ...state, behind: -1 }, { ...state, behind: 1.5 }, { ...state, behind: "4" }, { ...state, behind: undefined },
      { ...state, signers: null }, { ...state, signers: "x" }, { ...state, signers: [] }, { ...state, signers: [first] }, { ...state, signers: {} },
      { ...state, signers: { ...state.signers, x: rowBy("bound", addPhone, owner) } },
      { ...state, signers: { ...state.signers, [late.key]: null } }, { ...state, signers: { ...state.signers, [late.key]: "full" } }, { ...state, signers: { ...state.signers, [late.key]: [] } },
      withRow(phone, { power: "admin" }), withRow(phone, { power: undefined }),
      withRow(phone, { seq: -1 }), withRow(phone, { seq: 1.5 }), withRow(phone, { seq: "1" }), withRow(phone, { seq: 6 }),
      withRow(phone, { by: "x" }), withRow(phone, { by: undefined }), withRow(phone, { by: 7 }), withRow(phone, { by: "constructor" }), withRow(phone, { by: "__proto__" }),
      withRow(phone, { by: stranger.key }),
      withRow(phone, { ended: -1 }), withRow(phone, { ended: "2" }), withRow(phone, { ended: undefined }), withRow(phone, { ended: 0 }), withRow(phone, { ended: 6 }),
      withRow(owner, { by: phone.key }), withRow(owner, { by: null }), withRow(owner, { power: "bound" }), withRow(owner, { seq: 1 }),
      withRow(phone, { seq: 0, by: phone.key }),
    ];
    for (const value of broken) expect([value, readSignersState(value)]).toEqual([value, null]);
    for (const name of Object.keys(state)) expect([name, readSignersState(Object.fromEntries(Object.entries(state).filter(([key]) => key !== name)))]).toEqual([name, null]);
    for (const change of [{ ended: 1 }, { ended: 5 }, { seq: 5, ended: 5 }, { power: "bound" }, { by: watch.key }, { by: null }]) {
      const value: unknown = withRow(phone, change);
      const read: unknown = readSignersState(value);
      expect([change, read]).toEqual([change, value]);
    }
  });
});

describe("replaying from entry 0", () => {
  test("no entry, an entry 0 that does not hold, and one that is not the list it was given", async () => {
    expect(await replayEntries([], 1)).toEqual({ member: null, took: [], stopped: null });
    expect(await replayEntries([`${g.text}=`, addPhone.text], 1)).toEqual({ member: null, took: [], stopped: { seq: 0, code: "entry_malformed" } });
    expect(await replayEntries([addPhone.text], 1)).toEqual({ member: null, took: [], stopped: { seq: 0, code: "chain_broken" } });
    expect(await replayEntries(texts(root), 1, { given: "ab".repeat(32) })).toEqual({ member: null, took: [], stopped: { seq: 0, code: "list_mismatch" } });
    expect((await replayEntries(texts(root), 1, { given: g.hash })).member).toEqual(await memberOf(root));
  });

  test("it stops at the first entry that does not hold and keeps the ones before it", async () => {
    const result = await replayEntries([...texts(base), at(real, 0).text, at(real, 1).text], 1);
    expect(result.stopped).toEqual({ seq: 4, code: "chain_broken" });
    expect(result.member).toEqual(await memberOf(base));
  });

  test("a replay never goes back: an entry that does not continue the one before it stops it there, also after a loose entry, and its result names the stop", async () => {
    /** An entry 2 by a key that nobody added, one by a signer, and an entry 3 by the owner on another entry 2 than either. */
    const loose2 = await on(addPhone, stranger, {});
    const signed2 = await on(addPhone, phone, {});
    const on3 = await on(await on(addPhone, owner, { kind: "device", adds: [watch, "bound"] }), owner, {});
    // The smallest list: entries 0 and 1, a loose entry 2, and an entry 3 whose prev is the hash of another entry 2. It takes three of the four, and says so.
    const replayed = await replayEntries(texts([...root, loose2, on3]), 1);
    expect([replayed.stopped, replayed.took.length, replayed.member]).toEqual([{ seq: 3, code: "chain_broken" }, 3, await memberOf([...root, loose2])]);
    expect(replayed.took.map((taken) => taken.outcome.outcome)).toEqual(["reads", "reads", "passed_over"]);
    // After an entry 2 that a signer signed it is the same stop: a replay's result has no stuck, since no service showed it anything.
    const afterSigned = await replayEntries(texts([...root, signed2, on3]), 1);
    expect([afterSigned.stopped, afterSigned.took.length, Object.keys(afterSigned).sort()]).toEqual([{ seq: 3, code: "chain_broken" }, 3, ["member", "stopped", "took"]]);
    // The same entries as an answer of the log to a member that holds entries 0 and 1: there the first makes it go back, and the second is another history.
    expect(await shownEntries(await memberOf(root), answer(addPhone, [loose2, on3]))).toMatchObject({ stopped: null, stuck: false, asks_after: 1 });
    expect(await shownEntries(await memberOf(root), answer(addPhone, [signed2, on3]))).toMatchObject({ stopped: { seq: 3, code: "chain_broken" }, stuck: true, asks_after: null });
  });

  test("a replay's proof is read once: another put in its place while a signature is checked decides nothing", async () => {
    const byLogin = await on(addPhone, login, { kind: "later_login" });
    const list = texts([...root, byLogin]);
    const never: KeyProof = () => null;
    const unchanged = await replayEntries(list, 1, { proof: never });
    expect(last(unchanged.took).outcome).toEqual(passedOver("signer_unknown"));
    // The runtime verifies entry 0, and the caller's options name a proof that lets the login key in before the runtime answers.
    const options = { proof: never };
    const result = await whileVerifying(() => { options.proof = letsIn("full", login, byLogin); }, () => replayEntries(list, 1, options));
    expect(result).toEqual(unchanged);
  });

  test("over random lists, a replay either takes every entry it was given or names where it stopped: exactly where the envelope says that an entry does not hold on the one before it", async () => {
    /** The same lists in every run, but for their signatures: numbers from a small generator with a fixed start. */
    let seed = 20261115;
    const next = (below: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor((seed / 2 ** 32) * below);
    };
    const pick = <T>(items: readonly T[]): T => at(items, next(items.length));
    /** What the envelope alone says of these texts: the first that does not hold on the one before it, or null. */
    async function firstFault(list: readonly string[]): Promise<ListStop | null> {
      let before: HeldEntry | null = null;
      for (const [seq, text] of list.entries()) {
        try {
          const entry = entryFromText(text);
          before = before === null ? (await firstState(entry)).first : await entryHolds(entry, before);
        } catch (error) {
          if (!(error instanceof ListEntryError)) throw error;
          return { seq, code: error.code };
        }
      }
      return null;
    }
    const FAULTS = { prev: "chain_broken", seq: "chain_broken", list: "chain_broken", signature: "signature_invalid", form: "entry_malformed" } as const;
    const insiders = [owner, phone, watch];
    const counts = { lists: 0, whole: 0, stopped: 0, prevAfterLoose: 0, prevAfterSigned: 0 };
    for (let round = 0; round < 150; round++) {
      // A list that holds: entry 0, the phone and the watch device, then entries by signers and by keys that nobody added.
      const links: Link[] = [g, addPhone, addWatch];
      const length = 2 + next(6);
      for (let index = 0; index < length; index++) {
        const by = next(3) === 0 ? pick([stranger, service]) : pick(insiders);
        const draft: Draft = next(4) === 0 ? { kind: "later", v: 2 }
          : next(3) === 0 ? { ends: pick([watch, invite, late]) }
          : next(3) === 0 ? { kind: "device", adds: [pick([invite, late, machine]), pick(["full", "bound"] as const)] }
          : {};
        links.push(await on(last(links), by, draft));
      }
      const list = texts(links);
      // In two lists of three, one entry is put in the place of another that does not hold there; the list goes on after it.
      let fault: keyof typeof FAULTS | null = null;
      let place = -1;
      if (next(3) > 0) {
        place = 3 + next(links.length - 3);
        fault = pick(["prev", "prev", "prev", "seq", "list", "signature", "form"] as const);
        const before = at(links, place - 1);
        const by = pick(insiders);
        /** Another entry at the place before it: one that fails in its prev alone stands on that one. */
        const elsewhere = await on(at(links, place - 2), owner, { kind: "device", adds: [login, "bound"] });
        const put = fault === "prev" ? await on(elsewhere, by, {})
          : fault === "seq" ? await on(before, by, { change: { seq: place + 1 } })
          : fault === "list" ? await on(before, by, { change: { list: otherList } })
          : fault === "signature" ? await on(before, by, { signedWith: stranger })
          : await on(before, by, {});
        list[place] = fault === "form" ? `${put.text}=` : put.text;
      }
      const level = 1 + (round % 2);
      const stop = await firstFault(list);
      expect([round, stop]).toEqual([round, fault === null ? null : { seq: place, code: FAULTS[fault] }]);
      const result = await replayEntries(list, level);
      // It either took every entry it was given, or names where it stopped; and it holds what a replay of the entries before the stop gives.
      const taken = stop === null ? list.length : stop.seq;
      expect([round, result.stopped, result.member?.entries.length, result.took.length]).toEqual([round, stop, taken, taken]);
      if (stop !== null) expect([round, result.member]).toEqual([round, (await replayEntries(list.slice(0, stop.seq), level)).member]);
      counts.lists++;
      if (stop === null) counts.whole++;
      else counts.stopped++;
      const beforeIt = fault === "prev" ? result.took[place - 1]?.outcome : undefined;
      if (beforeIt !== undefined) counts[beforeIt.outcome === "passed_over" && beforeIt.loose ? "prevAfterLoose" : "prevAfterSigned"]++;
    }
    // The lists are the same in every run: 44 hold whole and 106 have an entry put in. 51 of those fail in their prev alone, 13 of them right
    // after an entry by a key that nobody added (and some more after an entry by a key that was ended): the case that a going back would swallow.
    expect([counts.lists, counts.whole, counts.stopped, counts.prevAfterLoose + counts.prevAfterSigned, counts.prevAfterLoose >= 13]).toEqual([150, 44, 106, 51, true]);
  }, 60_000);

  test("judgeEntry turns on no row but those the entry names: on those rows alone it gives the same outcome and the same rows", async () => {
    const entries = await row(addInvite,
      [stranger, { ends: owner }], [owner, { kind: "later", v: 2, adds: [late, "full"], ends: watch }], [invite, { kind: "join" }], [watch, {}],
      [late, { kind: "device", adds: [phone, "full"] }], [phone, { ends: phone }], [late, { ends: stranger }], [invite, { ends: invite }]);
    const { took } = await replay([...base, ...entries]);
    let state = firstSignersState(at(took, 0).held, 1);
    for (const { held } of took.slice(1)) {
      const { signer, adds, ends } = held.body;
      const namedKeys = [signer, ...(adds ? [adds.key] : []), ...(ends === undefined ? [] : [ends])];
      const whole = judgeEntry(state, held);
      const onNamed = judgeEntry({ ...state, signers: Object.fromEntries(Object.entries(state.signers).filter(([key]) => namedKeys.includes(key))) }, held);
      expect(onNamed.outcome).toEqual(whole.outcome);
      expect({ ...onNamed.state, signers: {} }).toEqual({ ...whole.state, signers: {} });
      expect(onNamed.state.signers).toEqual(Object.fromEntries(Object.entries(whole.state.signers).filter(([key]) => namedKeys.includes(key))));
      state = whole.state;
    }
    expect(took.map((taken) => taken.outcome.outcome)).toEqual(["reads", "reads", "reads", "reads", "passed_over", "cannot_read", "reads", "passed_over", "passed_over", "reads", "passed_over", "reads"]);
  });

  test("judgeEntry gives the state that replaying gives, entry by entry", async () => {
    const entries = await row(addInvite, [stranger, {}], [owner, { kind: "later", v: 2, ends: watch }], [invite, { kind: "join" }], [phone, { kind: "device", adds: [late, "full"] }]);
    const { took, member } = await replay([...base, ...entries]);
    if (member === null) throw new Error("entry 0 does not hold");
    let state = firstSignersState(at(took, 0).held, 1);
    for (const taken of took.slice(1)) {
      const judged = judgeEntry(state, taken.held);
      expect(judged.outcome).toEqual(taken.outcome);
      state = judged.state;
    }
    expect(took.length).toBe(8);
    expect(state).toEqual(member.state);
  });

  test("the envelope's vectors stop a member where the envelope says, and it takes every entry of the ones that hold", async () => {
    const dir = join(import.meta.dir, "account-list-vectors", "envelope");
    interface EnvelopeVector { given_list?: string; entries: { text: string }[]; expect: { stops?: ListStop } }
    const files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
    const stopped: string[] = [];
    for (const file of files) {
      const vector = JSON.parse(readFileSync(join(dir, file), "utf8")) as EnvelopeVector;
      const result = await replayEntries(vector.entries.map((entry) => entry.text), 1, vector.given_list === undefined ? {} : { given: vector.given_list });
      const { stops } = vector.expect;
      if (stops === undefined) {
        expect([file, result.stopped, result.member?.entries.length]).toEqual([file, null, vector.entries.length]);
      } else {
        stopped.push(file);
        expect([file, result.stopped, result.member?.entries.length ?? 0]).toEqual([file, stops, stops.seq]);
      }
    }
    expect(stopped.length).toBeGreaterThan(30);
    expect(files.length).toBeGreaterThan(stopped.length);
  });
});

describe("the vectors of signers/ and unreadable/", () => {
  const SIGNERS = [
    "signer-unknown", "signer-service-key", "signer-ended", "signer-machine-key", "adds-by-bound", "adds-key-again", "ends-other-by-bound", "ends-self", "ends-not-a-signer",
    "adds-and-ends-one-entry", "ends-last-full", "signer-not-device",
    "loose-one-then-list", "loose-several-then-list", "loose-same-again", "loose-under-signer", "loose-head-before", "footing-other-history", "footing-head-before",
    "head-other-at-shown-entry", "loose-same-then-list", "loose-not-at-higher-level",
  ];
  /** Cases added after the first set, written with this folder's own keys. */
  const SIGNERS_SECOND = [
    "seq-wrong-after-footing", "other-list-after-footing", "prev-other-after-footing", "footing-replaced", "head-before-footing-no-entry", "head-before-past-footing",
    "same-entry-other-signature", "forged-in-place-of-loose",
    "proof-entry-not-loose", "proof-cannot-change-made-key", "adds-and-ends-one-key", "proof-names-another-key", "proof-key-ended-stays-out", "proof-for-ended-adds-key",
    "device-out-of-form-signs", "took-every-name",
  ];
  const UNREADABLE = [
    "later-kind-by-drive-device", "later-kind-by-unknown-key", "later-kind-by-invite-key", "later-kind-v1", "known-kind-higher-v", "needs-from-copy",
    "remove-after-later-kind", "remove-by-device-added-after", "replay-after-update",
  ];
  const UNREADABLE_SECOND = ["adds-and-ends-one-key-level-1", "needs-passed-over"];
  const GOING_BACK = [...SIGNERS.slice(12), ...SIGNERS_SECOND.slice(0, 8)];
  /** Not in a vector: the place a member asks after when the answer makes it ask again; null for every other vector. */
  const ASKS_AFTER: Readonly<Record<string, number>> = { "head-before-past-footing": 1 };

  interface VectorEntry { fields: [string, string][]; body: string; signature: string; text: string; hash: string }
  interface Vector {
    name: string;
    keys: Record<string, { pkcs8: string; spki: string }>;
    /** What the member holds: it took each of them by the level in `expect.state.level`. */
    entries: VectorEntry[];
    /**
     * Going back: one whole answer of the log that the member is shown while it holds `entries`. Its entries follow the place
     * before the first of them; an answer with no entry follows the member's head.
     */
    shown?: { entries: VectorEntry[]; head: ListPlace };
    /** A member of a higher level: what the kinds it reads let in on a proof of their own, by the place of the entry. */
    lets_in?: { seq: number; key: string; power: SignerPower }[];
    /**
     * `took`: what the member did with each entry of `entries` after entry 0, before it is shown anything; `code` stands only
     * beside `passed_over`. Then its state, and for an answer its head after it, and `stops` and `stuck` when it stops.
     */
    expect: { took: { seq: number; outcome: TakenOutcome["outcome"]; code?: PassedOverCode }[]; state: SignersState; head?: ListPlace; stops?: ListStop; stuck?: boolean };
  }
  const load = (folder: string) => {
    const dir = join(import.meta.dir, "account-list-vectors", folder);
    const files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
    return { files, vectors: files.map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Vector) };
  };
  const signers = load("signers");
  const unreadable = load("unreadable");
  const vectors = [...signers.vectors, ...unreadable.vectors];
  const named = (name: string): Vector => {
    const vector = vectors.find((item) => item.name === name);
    if (vector === undefined) throw new Error(`no vector ${name}`);
    return vector;
  };
  const proofOf = (vector: Vector): KeyProof => (held) => {
    const found = vector.lets_in?.find((item) => item.seq === held.body.seq);
    return found ? { key: found.key, power: found.power } : null;
  };
  /** The member of a vector after its `entries`, and what happens when it is shown `shown`. */
  async function run(vector: Vector) {
    const held = await replayEntries(vector.entries.map((entry) => entry.text), vector.expect.state.level, { proof: proofOf(vector) });
    if (held.member === null || held.stopped !== null) throw new Error(`${vector.name}: its entries do not all hold`);
    const { shown } = vector;
    if (shown === undefined) return { member: held.member, took: held.took, shown: null };
    const first = shown.entries[0];
    const after = first === undefined ? held.member.entries.length - 1 : Number(new Map(first.fields).get("seq")) - 1;
    return { member: held.member, took: held.took, shown: await shownEntries(held.member, { after, entries: shown.entries.map((entry) => entry.text), head: shown.head }, proofOf(vector)) };
  }

  test("there is one file for every vector named, and no other", () => {
    expect(signers.files).toEqual([...SIGNERS, ...SIGNERS_SECOND].map((name) => `${name}.json`).sort());
    expect(unreadable.files).toEqual([...UNREADABLE, ...UNREADABLE_SECOND].map((name) => `${name}.json`).sort());
    for (const [index, vector] of signers.vectors.entries()) expect(`${vector.name}.json`).toBe(signers.files[index] ?? "");
    for (const [index, vector] of unreadable.vectors.entries()) expect(`${vector.name}.json`).toBe(unreadable.files[index] ?? "");
  });

  for (const vector of vectors) {
    test(vector.name, async () => {
      const { member, took, shown } = await run(vector);
      const { expect: expected } = vector;
      expect(readSignersState(expected.state)).toEqual(expected.state);
      const did = took.slice(1).map(({ held, outcome }) => ({ seq: held.body.seq, outcome: outcome.outcome, ...(outcome.outcome === "passed_over" ? { code: outcome.code } : {}) }));
      expect(did).toEqual(expected.took);
      expect(expected.took.map((item) => item.seq)).toEqual(vector.entries.slice(1).map((_, index) => index + 1));
      for (const item of expected.took) expect(Object.keys(item)).toEqual(item.outcome === "passed_over" ? ["seq", "outcome", "code"] : ["seq", "outcome"]);
      if (shown === null) {
        expect(GOING_BACK).not.toContain(vector.name);
        expect(Object.keys(expected)).toEqual(["took", "state"]);
        expect(member.state).toEqual(expected.state);
        expect(member.entries.length).toBe(vector.entries.length);
      } else {
        expect(GOING_BACK).toContain(vector.name);
        expect(Object.keys(vector.shown ?? {})).toEqual(["entries", "head"]);
        expect(Object.keys(expected)).toEqual(shown.stopped === null ? ["took", "head", "state"] : ["took", "head", "state", "stops", "stuck"]);
        expect(expected.head).toBeDefined();
        expect(listHead(shown.member)).toEqual(expected.head ?? { seq: -1, hash: "" });
        expect(shown.member.state).toEqual(expected.state);
        expect(shown.stopped).toEqual(expected.stops ?? null);
        expect(shown.stuck).toBe(expected.stuck ?? false);
        expect(shown.asks_after).toBe(ASKS_AFTER[vector.name] ?? null);
      }
    });
  }

  test("every entry of a vector is its text, hashes to its hash and shows its fields; every key it names is a TEST ONLY pair of its own", async () => {
    const encoder = new TextEncoder();
    for (const vector of vectors) {
      const known = Object.values(vector.keys).map((key) => key.spki);
      const named = [...Object.entries(vector.expect.state.signers).flatMap(([key, row]) => (row.by === null ? [key] : [key, row.by])), ...(vector.lets_in ?? []).map((item) => item.key)];
      for (const item of [...vector.entries, ...(vector.shown?.entries ?? [])]) {
        expect(item.text).toBe(`${item.body}.${item.signature}`);
        const entry = entryFromText(item.text);
        expect(entryHash(entry.body)).toBe(item.hash);
        expect(readFields(entry.body).map(({ name, value }) => [name, new TextDecoder().decode(value)])).toEqual(item.fields);
        named.push(...item.fields.filter(([name]) => name === "signer" || name === "adds" || name === "ends").map(([, value]) => value));
      }
      expect(named.length).toBeGreaterThan(2);
      for (const key of named) expect([vector.name, known.includes(key)]).toEqual([vector.name, true]);
      expect(new Set(named).size).toBe(known.length);
      for (const [name, { pkcs8, spki }] of Object.entries(vector.keys)) {
        expect(name).toStartWith("TEST-ONLY-");
        expect(isListKey(spki)).toBe(true);
        const privateKey = await crypto.subtle.importKey("pkcs8", new Uint8Array(fromBase64Url(pkcs8)), P256, false, ["sign"]);
        const message = encoder.encode(vector.name);
        expect(await verifySignature(message, new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, message)), spki)).toBe(true);
      }
    }
  });

  /** What the member of a vector did with each of its entries, in a word or two each. */
  const outcomes = async (name: string) => (await run(named(name))).took.map(({ outcome }) => (outcome.outcome === "passed_over" ? outcome.code : `${outcome.outcome}${outcome.behind ? " behind" : ""}`));

  test("signers/: each entry that is passed over, and why", async () => {
    expect(await outcomes("signer-unknown")).toEqual(["reads", "signer_unknown", "reads"]);
    expect(await outcomes("signer-service-key")).toEqual(["reads", "signer_unknown", "signer_unknown"]);
    expect(await outcomes("signer-ended")).toEqual(["reads", "reads", "reads", "signer_unknown"]);
    expect(await outcomes("signer-machine-key")).toEqual(["reads", "reads", "reads", "signer_unknown"]);
    expect(await outcomes("adds-by-bound")).toEqual(["reads", "reads", "signer_not_allowed"]);
    expect(await outcomes("adds-key-again")).toEqual(["reads", "reads", "reads", "key_reused", "reads", "key_reused"]);
    expect(await outcomes("ends-other-by-bound")).toEqual(["reads", "reads", "reads", "signer_not_allowed"]);
    expect(await outcomes("ends-self")).toEqual(["reads", "reads", "reads"]);
    expect(await outcomes("ends-not-a-signer")).toEqual(["reads", "already_out", "reads", "reads", "already_out"]);
    expect(await outcomes("adds-and-ends-one-entry")).toEqual(["reads", "reads", "already_out", "reads"]);
    expect(await outcomes("ends-last-full")).toEqual(["reads", "reads", "reads", "signer_not_allowed", "signer_unknown"]);
    expect(await outcomes("signer-not-device")).toEqual(["reads", "reads", "reads"]);
  });

  test("signer-not-device: a device entry that is out of its kind's form still makes its key a signer, and that key's adds applies", () => {
    const { entries, expect: expected } = named("signer-not-device");
    const fields = entries.map((entry) => new Map(entry.fields));
    const [first, outOfForm, byIt] = [at(fields, 0), at(fields, 1), at(fields, 2)];
    expect([outOfForm.get("kind"), outOfForm.get("power"), [...outOfForm.keys()].filter((name) => !["adds", "issued_at", "kind", "label", "list", "power", "prev", "seq", "signer", "v"].includes(name)).length]).toEqual(["device", "full", 1]);
    expect(byIt.get("signer")).toBe(outOfForm.get("adds") ?? "");
    expect(expected.state.signers).toEqual({
      [first.get("signer") ?? ""]: { power: "full", seq: 0, by: first.get("signer") ?? "", ended: null },
      [outOfForm.get("adds") ?? ""]: { power: "full", seq: 1, by: first.get("signer") ?? "", ended: null },
      [byIt.get("adds") ?? ""]: { power: "bound", seq: 2, by: outOfForm.get("adds") ?? "", ended: null },
    });
  });

  test("unreadable/: what a member of the vector's level does with each entry", async () => {
    const behind = "reads behind";
    expect(await outcomes("later-kind-by-drive-device")).toEqual(["reads", "reads", "reads", "reads", "reads", "cannot_read behind", behind, behind, behind, behind, behind]);
    expect(await outcomes("replay-after-update")).toEqual(new Array<string>(11).fill("reads"));
    expect(named("replay-after-update").entries).toEqual(named("later-kind-by-drive-device").entries);
    expect([named("later-kind-by-drive-device").expect.state.level, named("replay-after-update").expect.state.level]).toEqual([1, 2]);
    expect(await outcomes("later-kind-by-unknown-key")).toEqual(["reads", "reads", "signer_unknown", "reads"]);
    expect(await outcomes("later-kind-by-invite-key")).toEqual(["reads", "reads", "cannot_read"]);
    expect(await outcomes("later-kind-v1")).toEqual(["reads", "reads", "reads"]);
    expect(await outcomes("known-kind-higher-v")).toEqual(["reads", "cannot_read behind"]);
    expect(await outcomes("needs-from-copy")).toEqual(["reads", "reads", "cannot_read behind", "cannot_read behind", "signer_unknown", "cannot_read behind"]);
    expect(await outcomes("remove-after-later-kind")).toEqual(["reads", "reads", "cannot_read behind", behind]);
    expect(await outcomes("remove-by-device-added-after")).toEqual(["reads", "reads", "cannot_read behind", behind, behind]);
  });

  test("going back: what each vector's member holds, drops and takes", async () => {
    const story = async (name: string) => {
      const { member, shown } = await run(named(name));
      if (shown === null) throw new Error(`${name} shows nothing`);
      return { held: member.entries.length, footing: member.state.footing.seq, dropped: shown.dropped_from, took: shown.took.length, now: shown.member.entries.length, stuck: shown.stuck };
    };
    expect(await story("loose-one-then-list")).toEqual({ held: 3, footing: 1, dropped: 2, took: 2, now: 4, stuck: false });
    expect(await story("loose-several-then-list")).toEqual({ held: 5, footing: 1, dropped: 2, took: 4, now: 6, stuck: false });
    expect(await story("loose-same-again")).toEqual({ held: 4, footing: 1, dropped: null, took: 0, now: 4, stuck: false });
    expect(await story("loose-under-signer")).toEqual({ held: 4, footing: 1, dropped: null, took: 1, now: 5, stuck: false });
    expect(await story("loose-head-before")).toEqual({ held: 5, footing: 1, dropped: 2, took: 2, now: 4, stuck: false });
    expect(await story("footing-other-history")).toEqual({ held: 3, footing: 2, dropped: null, took: 0, now: 3, stuck: true });
    expect(await story("footing-head-before")).toEqual({ held: 3, footing: 2, dropped: null, took: 0, now: 3, stuck: true });
    expect(await story("loose-not-at-higher-level")).toEqual({ held: 4, footing: 3, dropped: null, took: 0, now: 4, stuck: true });
    expect(await story("seq-wrong-after-footing")).toEqual({ held: 3, footing: 2, dropped: null, took: 1, now: 4, stuck: false });
    expect(await story("other-list-after-footing")).toEqual({ held: 3, footing: 2, dropped: null, took: 1, now: 4, stuck: false });
    expect(await story("prev-other-after-footing")).toEqual({ held: 3, footing: 2, dropped: null, took: 1, now: 4, stuck: true });
    expect(await story("head-other-at-shown-entry")).toEqual({ held: 3, footing: 2, dropped: null, took: 1, now: 4, stuck: true });
    expect(await story("loose-same-then-list")).toEqual({ held: 4, footing: 1, dropped: 3, took: 1, now: 4, stuck: false });
    expect(await story("footing-replaced")).toEqual({ held: 3, footing: 2, dropped: null, took: 0, now: 3, stuck: true });
    expect(await story("head-before-footing-no-entry")).toEqual({ held: 3, footing: 2, dropped: null, took: 0, now: 3, stuck: true });
    expect(await story("head-before-past-footing")).toEqual({ held: 4, footing: 1, dropped: null, took: 0, now: 4, stuck: false });
    expect(await story("same-entry-other-signature")).toEqual({ held: 4, footing: 1, dropped: null, took: 0, now: 4, stuck: false });
    expect(await story("forged-in-place-of-loose")).toEqual({ held: 3, footing: 1, dropped: null, took: 0, now: 3, stuck: false });
    expect(named("loose-same-again").shown?.entries).toEqual(named("loose-same-again").entries.slice(2));
    expect(named("loose-under-signer").expect.state.footing.seq).toBe(4);
    expect(named("loose-not-at-higher-level").expect.state.level).toBe(2);
  });

  test("the head of each answer: the last entry it shows, but for the one that names another entry than it shows; four lie before the member's own head", () => {
    for (const name of GOING_BACK) {
      const { shown, entries } = named(name);
      if (shown === undefined) throw new Error(`${name} shows nothing`);
      const lastShown = shown.entries[shown.entries.length - 1];
      if (lastShown !== undefined && name !== "head-other-at-shown-entry") expect([name, shown.head]).toEqual([name, { seq: Number(new Map(lastShown.fields).get("seq")), hash: lastShown.hash }]);
      expect([name, shown.head.seq < entries.length - 1]).toEqual([name, ["loose-head-before", "footing-head-before", "head-before-footing-no-entry", "head-before-past-footing"].includes(name)]);
    }
    const stop = named("footing-head-before");
    expect([stop.shown?.entries, stop.expect.stops, stop.expect.stuck]).toEqual([[], { seq: stop.shown?.head.seq ?? -1, code: "chain_broken" }, true]);
    expect((stop.shown?.head.seq ?? 9) < stop.expect.state.footing.seq).toBe(true);
    expect(stop.shown?.head.hash).not.toBe(at(stop.entries, stop.shown?.head.seq ?? 0).hash);
  });

  test("the state after going back is as if the member had never seen the loose entries", async () => {
    for (const name of ["loose-one-then-list", "loose-several-then-list", "loose-head-before"]) {
      const vector = named(name);
      const clean = await replayEntries([...vector.entries.slice(0, 2), ...(vector.shown?.entries ?? [])].map((entry) => entry.text), 1);
      expect([name, clean.stopped, clean.member?.state]).toEqual([name, null, vector.expect.state]);
    }
  });

  test("the three vectors of an entry that fails right after one the member has just taken: only the one that fails in its prev alone is stuck", async () => {
    const bySeq = named("seq-wrong-after-footing");
    const byList = named("other-list-after-footing");
    const byPrev = named("prev-other-after-footing");
    const hashes = (items: readonly VectorEntry[]) => items.map((item) => item.hash);
    const list = at(byPrev.entries, 0).hash;
    for (const [vector, wrong, stuck] of [[bySeq, "seq", false], [byList, "list", false], [byPrev, "prev", true]] as const) {
      const [third, fourth] = vector.shown?.entries ?? [];
      if (!third || !fourth) throw new Error(`${vector.name} shows no two entries`);
      // The same entries held, the same entry 3 taken, and the same head, state and stop after it: the three differ in entry 4 alone.
      expect([vector.name, hashes(vector.entries), third.hash]).toEqual([vector.name, hashes(byPrev.entries), at(byPrev.shown?.entries ?? [], 0).hash]);
      expect([vector.name, vector.expect.head, vector.expect.state, vector.expect.stops]).toEqual([vector.name, { seq: 3, hash: third.hash }, byPrev.expect.state, { seq: 4, code: "chain_broken" }]);
      expect([vector.name, vector.expect.state.footing]).toEqual([vector.name, { seq: 3, hash: third.hash }]);
      // Entry 4 is its signer's, and is out of order in its seq, in its list or in its prev, and in nothing else.
      const fields = new Map(fourth.fields);
      expect([vector.name, await verifySignature(fromBase64Url(fourth.body), fromBase64Url(fourth.signature), fields.get("signer") ?? "")]).toEqual([vector.name, true]);
      const outOfOrder = [fields.get("seq") === "4" ? "" : "seq", fields.get("list") === list ? "" : "list", fields.get("prev") === third.hash ? "" : "prev"].join("");
      expect([vector.name, outOfOrder, vector.expect.stuck]).toEqual([vector.name, wrong, stuck]);
    }
    expect(isListHash(new Map(at(byPrev.shown?.entries ?? [], 1).fields).get("prev") ?? "")).toBe(true);
  });

  test("head-other-at-shown-entry: its head names another entry than the one it shows there; whole and cut in two, the member takes that entry, stops at the head's place, stuck, and takes no further entry", async () => {
    const vector = named("head-other-at-shown-entry");
    const { member, shown: whole } = await run(vector);
    const shown = vector.shown;
    const [third, fourth] = shown?.entries ?? [];
    if (whole === null || shown === undefined || !third || !fourth) throw new Error("it shows no two entries");
    // The answer: entries 3 and 4, each its signer's, the second on the first; and a head at place 3 that is another hash in form.
    expect([new Map(third.fields).get("seq"), new Map(fourth.fields).get("seq"), new Map(fourth.fields).get("prev") === third.hash]).toEqual(["3", "4", true]);
    for (const item of [third, fourth]) expect(await verifySignature(fromBase64Url(item.body), fromBase64Url(item.signature), new Map(item.fields).get("signer") ?? "")).toBe(true);
    expect([shown.head.seq, shown.head.hash === third.hash, isListHash(shown.head.hash)]).toEqual([3, false, true]);
    // Whole: it takes entry 3, which a signer signed, so its footing is entry 3; the head lies there with another hash.
    const cameTo = (result: Awaited<ReturnType<typeof shownEntries>>) => ({ ...result, took: result.took.map((item) => item.held.hash) });
    expect(cameTo(whole)).toMatchObject({ took: [third.hash], stopped: { seq: 3, code: "chain_broken" }, stuck: true, asks_after: null, dropped_from: null });
    expect([listHead(whole.member), whole.member.state.footing]).toEqual([{ seq: 3, hash: third.hash }, { seq: 3, hash: third.hash }]);
    // Cut in two: the first part ends as the whole does, so the member is shown no second part.
    expect(cameTo(await shownEntries(member, { after: 2, entries: [third.text], head: shown.head }))).toEqual(cameTo(whole));
    // It differs from an honest answer in its head alone: under the last entry it shows as its head, the member takes both.
    const honest = await shownEntries(member, { after: 2, entries: [third.text, fourth.text], head: { seq: 4, hash: fourth.hash } });
    expect([honest.stopped, honest.stuck, honest.asks_after, cameTo(honest).took]).toEqual([null, false, null, [third.hash, fourth.hash]]);
  });

  test("loose-same-then-list: the answer shows its loose entry 2 again and names as its head another entry 3 than its own; whole and cut in two, the member ends on that entry", async () => {
    const vector = named("loose-same-then-list");
    const { member, shown: whole } = await run(vector);
    const shown = vector.shown;
    const [second, third] = shown?.entries ?? [];
    if (whole === null || shown === undefined || !second || !third) throw new Error("it shows no two entries");
    // It holds two loose entries past its footing. The answer shows the first again; its head is the entry 3 that it shows, another than the member's own.
    expect([member.state.level, member.state.footing.seq, member.entries.length, second.hash === at(vector.entries, 2).hash, third.hash === at(vector.entries, 3).hash]).toEqual([1, 1, 4, true, false]);
    expect(shown.head).toEqual({ seq: 3, hash: third.hash });
    const ends = (result: Awaited<ReturnType<typeof shownEntries>>) => [result.stopped, result.stuck, result.asks_after, listHead(result.member), result.member.state.footing];
    expect(ends(whole)).toEqual([null, false, null, shown.head, shown.head]);
    expect([whole.dropped_from, whole.took.map((item) => item.held.hash)]).toEqual([3, [third.hash]]);
    // Cut in two: shown entry 2 again under that head, it changes nothing and asks nothing; shown entry 3, it ends as it does whole.
    const first = await shownEntries(member, { after: 1, entries: [second.text], head: shown.head }, proofOf(vector));
    expect([first.took.length, first.dropped_from, first.asks_after, first.stopped, first.member]).toEqual([0, null, null, null, member]);
    expect(ends(await shownEntries(first.member, { after: 2, entries: [third.text], head: shown.head }, proofOf(vector)))).toEqual(ends(whole));
  });

  test("an honest answer is never caught by its head: each answer whose head is the last entry it shows ends the same under a head that lies past everything, and cut in two at every place", async () => {
    const honest = GOING_BACK.filter((name) => {
      const { shown } = named(name);
      const lastShown = shown?.entries[shown.entries.length - 1];
      return shown !== undefined && lastShown !== undefined && shown.head.hash === lastShown.hash;
    });
    // All but the three that show no entry, and the one whose head names another entry than it shows.
    expect(honest).toEqual(GOING_BACK.filter((name) => !["footing-head-before", "head-before-footing-no-entry", "head-before-past-footing", "head-other-at-shown-entry"].includes(name)));
    expect(honest.length).toBe(14);
    /** A head at a place that no member here holds and no answer here comes to: it says nothing. */
    const far = { seq: 1000, hash: "ab".repeat(32) };
    const cameTo = (result: Awaited<ReturnType<typeof shownEntries>>) => ({ ...result, took: result.took.map((item) => item.held.hash) });
    let cuts = 0;
    for (const name of honest) {
      const vector = named(name);
      const { member, shown: whole } = await run(vector);
      const shown = vector.shown;
      if (whole === null || shown === undefined) throw new Error(`${name} shows nothing`);
      const texts = shown.entries.map((entry) => entry.text);
      const after = Number(new Map(at(shown.entries, 0).fields).get("seq")) - 1;
      // What its head says, its entries say too.
      expect([name, cameTo(await shownEntries(member, { after, entries: texts, head: far }, proofOf(vector)))]).toEqual([name, cameTo(whole)]);
      // Cut in two at every place, each part under the answer's own head, which lies past the first part.
      for (let cut = 1; cut < texts.length; cut++) {
        const first = await shownEntries(member, { after, entries: texts.slice(0, cut), head: shown.head }, proofOf(vector));
        const second = first.stopped !== null || first.asks_after !== null ? null : await shownEntries(first.member, { after: after + cut, entries: texts.slice(cut), head: shown.head }, proofOf(vector));
        const inTwo = second === null ? cameTo(first) : { ...cameTo(second), took: [...cameTo(first).took, ...cameTo(second).took], dropped_from: first.dropped_from ?? second.dropped_from };
        expect([name, cut, inTwo]).toEqual([name, cut, cameTo(whole)]);
        cuts++;
      }
    }
    expect(cuts).toBe(11);
  });

  test("same-entry-other-signature and forged-in-place-of-loose are what their names say", async () => {
    const same = named("same-entry-other-signature");
    for (const [index, shownEntry] of (same.shown?.entries ?? []).entries()) {
      const own = at(same.entries, index + 2);
      expect([shownEntry.hash, shownEntry.body, shownEntry.signature === own.signature]).toEqual([own.hash, own.body, false]);
      const signer = new Map(shownEntry.fields).get("signer") ?? "";
      for (const item of [own, shownEntry]) expect(await verifySignature(fromBase64Url(item.body), fromBase64Url(item.signature), signer)).toBe(true);
    }
    expect(same.shown?.entries.length).toBe(2);
    const forged = at(named("forged-in-place-of-loose").shown?.entries ?? [], 0);
    expect(await verifySignature(fromBase64Url(forged.body), fromBase64Url(forged.signature), new Map(forged.fields).get("signer") ?? "")).toBe(false);
    expect(forged.hash).toBe(at(named("footing-replaced").shown?.entries ?? [], 0).hash);
  });

  test("the three cases of a proof that lets nobody in: each entry is passed over, and the footing stays under it", () => {
    for (const [name, place] of [["proof-names-another-key", 2], ["proof-key-ended-stays-out", 4], ["proof-for-ended-adds-key", 4]] as const) {
      const { entries, lets_in, expect: expected } = named(name);
      const entry = new Map(at(entries, place).fields);
      expect([name, entries.length - 1, lets_in?.some((item) => item.seq === place)]).toEqual([name, place, true]);
      expect([name, at(expected.took, place - 1)]).toEqual([name, { seq: place, outcome: "passed_over", code: "signer_unknown" }]);
      expect([name, expected.state.footing.seq, expected.state.level]).toEqual([name, place - 1, 2]);
      expect([name, expected.state.signers[entry.get("signer") ?? ""]?.ended ?? "no row"]).toEqual([name, name === "proof-names-another-key" ? "no row" : 3]);
    }
  });

  test("loose-not-at-higher-level: a member of level 1 holds what the login key signed as loose entries", async () => {
    const vector = named("loose-not-at-higher-level");
    const lower = await replayEntries(vector.entries.map((entry) => entry.text), 1);
    expect([lower.member?.state.footing.seq, Object.keys(lower.member?.state.signers ?? {}).length, lower.member?.state.behind]).toEqual([1, 1, 1]);
  });
});

import { describe, expect, test } from "bun:test";
import { handRecords, readSnapshot, refusalReceipts, type PageAnswer, type ReadScope, type SnapshotPage, type SnapshotPorts, type StagedRead } from "./snapshot-read.ts";

type Rec = { readonly kind: "block" | "remove" | "lift" | "add" | "junk"; readonly id: string; readonly target?: string };

const ACCOUNT = "acct-1";
const SERVER = "srv-1";

function page(over: Partial<SnapshotPage> & { records?: readonly Rec[] } = {}): SnapshotPage {
  return { snapshot: "snap-a", account: ACCOUNT, server_id: SERVER, version: 7, last: true, methods_version: 1, devices: [], removed: [], records: [], freeze_lines: [], ...over };
}

/** A PC as the read sees it: the scope it reads under, its `gen`, and what each port did, in order. */
function pc(options: { gen?: number; lastVersion?: number; methods?: number | null; liftOk?: (lift: Rec) => boolean; scope?: () => ReadScope | null } = {}) {
  const state = { gen: options.gen ?? 10, lock: null as string | null, account: ACCOUNT, serverId: SERVER };
  const events: string[] = [];
  const committed: StagedRead[] = [];
  const journaled: number[] = [];
  let methods = options.methods === undefined ? 1 : options.methods;
  const ports: SnapshotPorts = {
    scope: options.scope ?? (() => ({ account: state.account, serverId: state.serverId, gen: state.gen, lock: state.lock })),
    lastVersion: () => options.lastVersion ?? 6,
    classify: (record) => {
      const kind = (record as Rec).kind;
      return kind === "block" || kind === "remove" ? "denial" : kind === "lift" ? "lift" : kind === "add" ? "add" : "invalid";
    },
    deny: async (record) => { events.push(`deny ${(record as Rec).id}`); state.gen++; return true; },
    liftAuthority: (lift) => options.liftOk?.(lift as Rec) ?? true,
    commit: (stage) => { events.push("commit"); committed.push(stage); },
    methodsVersion: () => methods,
    journalMethod: (version) => { journaled.push(version); methods = version; },
    requestRead: () => { events.push("read requested"); },
  };
  return { ports, state, events, committed, journaled };
}

/** Pages served in order; `snapshot` is what each later call asked for. */
function serve(answers: readonly (PageAnswer | Error)[]) {
  const asked: (string | null)[] = [];
  let index = 0;
  const fetchPage = async (cursor: { snapshot: string | null; page: number }) => {
    asked.push(cursor.snapshot);
    const answer = answers[index++];
    if (answer === undefined) throw new Error("no more pages");
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetchPage, asked };
}

describe("S2-24 whole account reads (G1, T15, T52, T58, T60)", () => {
  test("G1: partial, mixed or stale snapshots commit no widening or list drop", async () => {
    const block: Rec = { kind: "block", id: "b1" };
    const add: Rec = { kind: "add", id: "a1" };
    const lift: Rec = { kind: "lift", id: "l1" };
    const cases: { name: string; answers: (PageAnswer | Error)[]; reason: string; lastVersion?: number }[] = [
      { name: "mixed snapshot ids", answers: [page({ last: false, records: [block] }), page({ snapshot: "snap-b", records: [add, lift] })], reason: "mixed_snapshot" },
      { name: "snapshot_gone", answers: [page({ last: false, records: [block] }), { snapshot_gone: true }], reason: "snapshot_gone" },
      { name: "a page fails", answers: [page({ last: false, records: [block] }), new Error("503")], reason: "page_failed" },
      { name: "no last page", answers: [page({ last: false, records: [block] }), page({ last: false, records: [add] }), page({ last: false })], reason: "incomplete" },
      { name: "another account", answers: [page({ last: false, records: [block] }), page({ account: "acct-2", records: [add] })], reason: "scope_mismatch" },
      { name: "another relay identity", answers: [page({ last: false, records: [block] }), page({ server_id: "srv-2", records: [add] })], reason: "scope_mismatch" },
      { name: "older than the last snapshot applied", answers: [page({ version: 5, records: [block, add] })], reason: "stale", lastVersion: 6 },
      { name: "a missing part is not an empty part", answers: [page({ last: false, records: [block] }), { ...page({ records: [add] }), devices: undefined } as unknown as SnapshotPage], reason: "malformed" },
    ];
    for (const { name, answers, reason, lastVersion } of cases) {
      const machine = pc(lastVersion === undefined ? {} : { lastVersion });
      const { fetchPage } = serve(answers);
      const outcome = await readSnapshot(fetchPage, machine.ports, 3);
      const got: string = outcome.committed ? "committed" : outcome.reason;
      expect({ name, got }).toEqual({ name, got: reason });
      // nothing widened and the list was not replaced (no drop), yet the denial read before the failure stands
      expect({ name, committed: machine.committed }).toEqual({ name, committed: [] });
      if (reason !== "stale") expect({ name, events: machine.events }).toEqual({ name, events: ["deny b1"] });
    }
  });

  test("G1: every later page is asked by the first page's snapshot id, and a whole read commits once", async () => {
    const machine = pc();
    const { fetchPage, asked } = serve([page({ last: false }), page({ last: false }), page()]);
    const outcome = await readSnapshot(fetchPage, machine.ports);
    expect(asked).toEqual([null, "snap-a", "snap-a"]);
    expect(outcome).toEqual({ committed: true, snapshot: "snap-a", denials: 0, liftsRefused: 0 });
    expect(machine.committed).toHaveLength(1);
  });

  test("G1: a binding, identity or lock that changed during the read throws the stage away", async () => {
    for (const change of ["account", "serverId", "lock"] as const) {
      const machine = pc();
      const fetchPage = async (cursor: { snapshot: string | null }) => {
        if (cursor.snapshot === null) return page({ last: false, records: [{ kind: "add", id: "a1" }] });
        if (change === "lock") machine.state.lock = "lock-1";
        else machine.state[change] = `${machine.state[change]}-changed`;
        return page();
      };
      const outcome = await readSnapshot(fetchPage, machine.ports);
      expect({ change, outcome }).toEqual({ change, outcome: { committed: false, reason: "scope_changed", denials: 0 } });
      expect(machine.committed).toEqual([]);
    }
  });

  test("G1: a PC in no account reads nothing", async () => {
    const machine = pc({ scope: () => null });
    const { fetchPage, asked } = serve([page()]);
    expect(await readSnapshot(fetchPage, machine.ports)).toEqual({ committed: false, reason: "unbound", denials: 0 });
    expect(asked).toEqual([]);
  });

  test("T15: denials apply first and an add commits only at a validated unchanged generation", async () => {
    const add: Rec = { kind: "add", id: "a1" };
    const block: Rec = { kind: "block", id: "b1" };
    const remove: Rec = { kind: "remove", id: "r1" };
    // the add is read before the block, yet the block applies as it is read and the add only at the commit
    const machine = pc();
    const { fetchPage } = serve([page({ last: false, records: [add, block] }), page({ records: [remove] })]);
    const outcome = await readSnapshot(fetchPage, machine.ports);
    expect(machine.events).toEqual(["deny b1", "deny r1", "commit"]);
    expect(outcome).toEqual({ committed: true, snapshot: "snap-a", denials: 2, liftsRefused: 0 });
    expect(machine.committed[0]?.adds).toEqual([add]);

    // another denial landed during the read (a handed block, a Revoke): gen moved past what this read raised
    const raced = pc();
    const racing = async (cursor: { snapshot: string | null }) => {
      if (cursor.snapshot === null) return page({ last: false, records: [add, block] });
      raced.state.gen += 1;
      return page();
    };
    expect(await readSnapshot(racing, raced.ports)).toEqual({ committed: false, reason: "generation_changed", denials: 1 });
    expect(raced.committed).toEqual([]);
    expect(raced.events).toEqual(["deny b1"]);
  });

  test("T15: a handed add or lift is staged for a whole read and never applied as it is handed; a handed denial applies at once", async () => {
    const machine = pc();
    const outcomes = await handRecords([{ kind: "add", id: "a1" }, { kind: "block", id: "b1" }, { kind: "lift", id: "l1" }, { kind: "junk", id: "j1" }], machine.ports);
    expect(outcomes).toEqual([
      { id: "a1", outcome: "staged" },
      { id: "b1", outcome: "applied" },
      { id: "l1", outcome: "staged" },
      { id: "j1", outcome: "refused", code: "record_invalid" },
    ]);
    expect(machine.events).toEqual(["deny b1", "read requested"]);
    expect(machine.committed).toEqual([]);
  });

  test("T52: a handed or partial-read lift cannot thaw; a complete accepted lift still needs PC-local age authority", async () => {
    const lift: Rec = { kind: "lift", id: "l1", target: "b1" };
    const younger: Rec = { kind: "lift", id: "l2", target: "b2" };

    const handed = pc();
    await handRecords([lift], handed.ports);
    expect(handed.committed).toEqual([]);

    const partial = pc();
    await readSnapshot(serve([page({ last: false, records: [lift] }), new Error("timeout")]).fetchPage, partial.ports);
    expect(partial.committed).toEqual([]);

    // whole read: the service took both, but this PC's own order says only l1's signer is older than the blocked key
    const whole = pc({ liftOk: (candidate) => candidate.id === "l1" });
    const outcome = await readSnapshot(serve([page({ records: [lift, younger] })]).fetchPage, whole.ports);
    expect(outcome).toEqual({ committed: true, snapshot: "snap-a", denials: 0, liftsRefused: 1 });
    expect(whole.committed[0]?.lifts).toEqual([lift]);
  });

  test("T58: committed method version change journals once and never treats a bell as authority", async () => {
    const machine = pc({ methods: 1 });
    await readSnapshot(serve([page({ methods_version: 2 })]).fetchPage, machine.ports);
    await readSnapshot(serve([page({ methods_version: 2, version: 8 })]).fetchPage, machine.ports);
    expect(machine.journaled).toEqual([2]);

    // a read thrown away journals nothing, however its pages named the version
    const thrown = pc({ methods: 1 });
    await readSnapshot(serve([page({ methods_version: 3, last: false }), page({ snapshot: "snap-b", methods_version: 3 })]).fetchPage, thrown.ports);
    expect(thrown.journaled).toEqual([]);

    // the bell carries no list: all it may do is ask for a read, and a read that fails changes nothing
    const rung = pc({ methods: 1 });
    await readSnapshot(serve([new Error("service down")]).fetchPage, rung.ports);
    expect(rung.journaled).toEqual([]);
    expect(rung.committed).toEqual([]);
  });

  test("T60: a refused sign-in triggers catch-up and only a known proved key gets a PC-authenticated receipt backed by its log", () => {
    const log = new Map([["key-known", [{ id: "b1", outcome: "applied" as const, n: 4 }]]]);
    const asked: string[] = [];
    const receipts = (key: string, proved: boolean) => refusalReceipts(key, proved, {
      requestRead: () => { asked.push(key); },
      ordered: (candidate) => candidate === "key-known" || candidate === "key-empty",
      receipts: (candidate) => log.get(candidate) ?? [],
    });
    expect(receipts("key-known", true)).toEqual([{ id: "b1", outcome: "applied", n: 4 }]);
    expect(receipts("key-known", false)).toEqual([]);
    expect(receipts("key-stranger", true)).toEqual([]);
    expect(receipts("key-empty", true)).toEqual([]);
    // every refused sign-in asks for the catch-up, whether or not it gets receipts
    expect(asked).toEqual(["key-known", "key-known", "key-stranger", "key-empty"]);
  });
});

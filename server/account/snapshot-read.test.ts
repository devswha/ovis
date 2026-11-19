import { describe, expect, test } from "bun:test";
import { exportAccountKey, newRecordId, signSafetyRecord, type DeviceLiftRecord } from "../../shared/account-records.ts";
import type { AccountSnapshotPage } from "../../shared/account-snapshot.ts";
import { handRecords, readSnapshot, refusalReceipts, type PageAnswer, type ReadScope, type SnapshotPorts, type StagedRead } from "./snapshot-read.ts";

type Mail = { readonly kind: "add" | "remove" | "junk"; readonly id: string };

async function key() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { pair, spki: await exportAccountKey(pair.publicKey) };
}

const ACCOUNT = "acct_1";
const SERVER = "0123456789abcdef0123456789abcdef";
const SNAP_A = "a".repeat(32);
const SNAP_B = "b".repeat(32);
const AT = "2026-11-05T01:02:03.456Z";
const [older, newer, newest] = [await key(), await key(), await key()];
const block = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: newer.spki, target_no: 2, signer: older.spki, signer_no: 1, signed_at: AT, nonce: newRecordId() }, older.pair.privateKey);
const lift = await signSafetyRecord({ v: 1, kind: "lift", account: ACCOUNT, target: block.id, signer: older.spki, signer_no: 1, signed_at: AT }, older.pair.privateKey);
const youngLift = await signSafetyRecord({ v: 1, kind: "lift", account: ACCOUNT, target: block.id, signer: newest.spki, signer_no: 3, signed_at: AT }, newest.pair.privateKey);

function page(over: Partial<AccountSnapshotPage> = {}): AccountSnapshotPage {
  return {
    v: 1, snapshot: SNAP_A, account: ACCOUNT, server_id: SERVER, version: 7, methods_version: 1, page: 0, last: true,
    devices: [{ key: older.spki, no: 1, eligible: true, label: "Phone" }], removed: [], blocks: [], lifts: [], freezes: [],
    ...over,
  };
}
const answer = (over: Partial<AccountSnapshotPage> = {}, records: readonly Mail[] = []): PageAnswer => ({ page: page(over), records });

/** A PC as the read sees it: the scope it reads under, its `gen`, and what each port did, in order. */
function pc(options: { lastVersion?: number | null; methods?: number | null; liftOk?: (lift: DeviceLiftRecord) => boolean; scope?: () => ReadScope | null } = {}) {
  const state = { gen: 10, lock: null as string | null, account: ACCOUNT, serverId: SERVER };
  const events: string[] = [];
  const committed: StagedRead[] = [];
  const journaled: number[] = [];
  let methods = options.methods === undefined ? 1 : options.methods;
  const name = (record: unknown) => (record as { id: string }).id === block.id ? "block" : (record as { id: string }).id;
  const ports: SnapshotPorts = {
    scope: options.scope ?? (() => ({ account: state.account, serverId: state.serverId, gen: state.gen, lock: state.lock })),
    lastVersion: () => options.lastVersion === undefined ? 6 : options.lastVersion,
    classify: (record) => {
      const kind = (record as { kind: string }).kind;
      return kind === "block" || kind === "remove" ? "denial" : kind === "lift" ? "lift" : kind === "add" ? "add" : "invalid";
    },
    deny: async (record) => { events.push(`deny ${name(record)}`); state.gen++; return true; },
    liftAuthority: (candidate) => options.liftOk?.(candidate) ?? true,
    commit: (stage) => { events.push("commit"); committed.push(stage); },
    methodsVersion: () => methods,
    journalMethod: (version) => { journaled.push(version); methods = version; },
    requestRead: () => { events.push("read requested"); },
  };
  return { ports, state, events, committed, journaled };
}

/** Pages served in order; `asked` is the snapshot id each call named. */
function serve(answers: readonly (PageAnswer | Error)[]) {
  const asked: (string | null)[] = [];
  let index = 0;
  const fetchPage = async (cursor: { snapshot: string | null; page: number }) => {
    asked.push(cursor.snapshot);
    const next = answers[index++];
    if (next === undefined) throw new Error("no more pages");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchPage, asked };
}

describe("S2-24 whole account reads (G1, T15, T52, T58, T60)", () => {
  test("G1: partial, mixed or stale snapshots commit no widening or list drop", async () => {
    const add: Mail = { kind: "add", id: "a1" };
    const first = answer({ last: false, blocks: [block] });
    const cases: { name: string; answers: (PageAnswer | Error)[]; reason: string; lastVersion?: number }[] = [
      { name: "mixed snapshot ids", answers: [first, answer({ page: 1, snapshot: SNAP_B, lifts: [lift] }, [add])], reason: "mixed_snapshot" },
      { name: "mixed methods version", answers: [first, answer({ page: 1, methods_version: 2 }, [add])], reason: "mixed_snapshot" },
      { name: "snapshot_gone", answers: [first, { snapshot_gone: true }], reason: "snapshot_gone" },
      { name: "a page fails", answers: [first, new Error("503")], reason: "page_failed" },
      { name: "no last page", answers: [first, answer({ page: 1, last: false }, [add]), answer({ page: 2, last: false })], reason: "incomplete" },
      { name: "pages out of order", answers: [first, answer({ page: 2 }, [add])], reason: "malformed" },
      { name: "another account", answers: [first, answer({ page: 1, account: "acct_2" }, [add])], reason: "scope_mismatch" },
      { name: "another relay identity", answers: [first, answer({ page: 1, server_id: "f".repeat(32) }, [add])], reason: "scope_mismatch" },
      { name: "older than the last snapshot applied", answers: [answer({ version: 5, blocks: [block] }, [add])], reason: "stale", lastVersion: 6 },
      { name: "a missing part is not an empty part", answers: [first, { page: { ...page({ page: 1 }), devices: undefined }, records: [add] }], reason: "malformed" },
      { name: "a key named twice across pages", answers: [first, answer({ page: 1 }, [add])], reason: "malformed" },
    ];
    for (const { name, answers, reason, lastVersion } of cases) {
      const machine = pc(lastVersion === undefined ? {} : { lastVersion });
      const outcome = await readSnapshot(serve(answers).fetchPage, machine.ports, 3);
      const got: string = outcome.committed ? "committed" : outcome.reason;
      expect({ name, got }).toEqual({ name, got: reason });
      // nothing widened and the list was not replaced (no drop), yet the block read before the failure stands
      expect({ name, committed: machine.committed }).toEqual({ name, committed: [] });
      if (reason !== "stale") expect({ name, events: machine.events }).toEqual({ name, events: ["deny block"] });
    }
  });

  test("G1: every later page is asked by the first page's snapshot id, and a whole read commits once", async () => {
    const machine = pc();
    const devices = [{ key: older.spki, no: 1, eligible: true, label: "Phone" }, { key: newer.spki, no: 2, eligible: true, label: "Laptop" }, { key: newest.spki, no: 3, eligible: true, label: "Tablet" }];
    const { fetchPage, asked } = serve([answer({ last: false, devices: [devices[0]!] }), answer({ page: 1, last: false, devices: [devices[1]!] }), answer({ page: 2, devices: [devices[2]!] })]);
    const outcome = await readSnapshot(fetchPage, machine.ports);
    expect(asked).toEqual([null, SNAP_A, SNAP_A]);
    expect(outcome).toEqual({ committed: true, snapshot: SNAP_A, denials: 0, liftsRefused: 0 });
    expect(machine.committed.map((stage) => stage.snapshot.devices.map((device) => device.no))).toEqual([[1, 2, 3]]);
  });

  test("G1: a binding, identity or lock that changed during the read throws the stage away", async () => {
    for (const change of ["account", "serverId", "lock"] as const) {
      const machine = pc();
      const fetchPage = async (cursor: { snapshot: string | null }) => {
        if (cursor.snapshot === null) return answer({ last: false, devices: [] }, [{ kind: "add", id: "a1" }]);
        if (change === "lock") machine.state.lock = "lock-1";
        else machine.state[change] = `${machine.state[change]}-changed`;
        return answer({ page: 1 });
      };
      const outcome = await readSnapshot(fetchPage, machine.ports);
      expect({ change, outcome }).toEqual({ change, outcome: { committed: false, reason: "scope_changed", denials: 0 } });
      expect(machine.committed).toEqual([]);
    }
  });

  test("G1: a PC in no account reads nothing", async () => {
    const machine = pc({ scope: () => null });
    const { fetchPage, asked } = serve([answer()]);
    expect(await readSnapshot(fetchPage, machine.ports)).toEqual({ committed: false, reason: "unbound", denials: 0 });
    expect(asked).toEqual([]);
  });

  test("T15: denials apply first and an add commits only at a validated unchanged generation", async () => {
    const add: Mail = { kind: "add", id: "a1" };
    const remove: Mail = { kind: "remove", id: "r1" };
    // the add is read before the block, yet the block applies as it is read and the add only at the commit
    const machine = pc();
    const { fetchPage } = serve([answer({ last: false, devices: [], blocks: [block] }, [add]), answer({ page: 1 }, [remove])]);
    const outcome = await readSnapshot(fetchPage, machine.ports);
    expect(machine.events).toEqual(["deny block", "deny r1", "commit"]);
    expect(outcome).toEqual({ committed: true, snapshot: SNAP_A, denials: 2, liftsRefused: 0 });
    expect(machine.committed[0]?.adds).toEqual([add]);

    // another denial landed during the read (a handed block, a Revoke): gen moved past what this read raised
    const raced = pc();
    const racing = async (cursor: { snapshot: string | null }) => {
      if (cursor.snapshot === null) return answer({ last: false, devices: [], blocks: [block] }, [add]);
      raced.state.gen += 1;
      return answer({ page: 1 });
    };
    expect(await readSnapshot(racing, raced.ports)).toEqual({ committed: false, reason: "generation_changed", denials: 1 });
    expect(raced.committed).toEqual([]);
    expect(raced.events).toEqual(["deny block"]);
  });

  test("T15: a handed add or lift is staged for a whole read and never applied as it is handed; a handed denial applies at once", async () => {
    const machine = pc();
    const outcomes = await handRecords([{ kind: "add", id: "a1" }, block, lift, { kind: "junk", id: "j1" }], machine.ports);
    expect(outcomes).toEqual([
      { id: "a1", outcome: "staged" },
      { id: block.id, outcome: "applied" },
      { id: lift.id, outcome: "staged" },
      { id: "j1", outcome: "refused", code: "record_invalid" },
    ]);
    expect(machine.events).toEqual(["deny block", "read requested"]);
    expect(machine.committed).toEqual([]);
  });

  test("T52: a handed or partial-read lift cannot thaw; a complete accepted lift still needs PC-local age authority", async () => {
    const handed = pc();
    await handRecords([lift], handed.ports);
    expect(handed.committed).toEqual([]);

    const partial = pc();
    await readSnapshot(serve([answer({ last: false, lifts: [lift] }), new Error("timeout")]).fetchPage, partial.ports);
    expect(partial.committed).toEqual([]);

    // whole read: the service took both, but this PC's own order says only one signer is older than the blocked key
    const whole = pc({ liftOk: (candidate) => candidate.id === lift.id });
    const outcome = await readSnapshot(serve([answer({ lifts: [lift, youngLift] })]).fetchPage, whole.ports);
    expect(outcome).toEqual({ committed: true, snapshot: SNAP_A, denials: 0, liftsRefused: 1 });
    expect(whole.committed[0]?.lifts).toEqual([lift]);
  });

  test("T58: committed method version change journals once and never treats a bell as authority", async () => {
    const machine = pc({ methods: 1 });
    await readSnapshot(serve([answer({ methods_version: 2 })]).fetchPage, machine.ports);
    await readSnapshot(serve([answer({ methods_version: 2, version: 8 })]).fetchPage, machine.ports);
    expect(machine.journaled).toEqual([2]);

    // a read thrown away journals nothing, however its pages named the version
    const thrown = pc({ methods: 1 });
    await readSnapshot(serve([answer({ methods_version: 3, last: false, devices: [] }), answer({ page: 1, snapshot: SNAP_B, methods_version: 3 })]).fetchPage, thrown.ports);
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
    const receipts = (candidate: string, proved: boolean) => refusalReceipts(candidate, proved, {
      requestRead: () => { asked.push(candidate); },
      ordered: (k) => k === "key-known" || k === "key-empty",
      receipts: (k) => log.get(k) ?? [],
    });
    expect(receipts("key-known", true)).toEqual([{ id: "b1", outcome: "applied", n: 4 }]);
    expect(receipts("key-known", false)).toEqual([]);
    expect(receipts("key-stranger", true)).toEqual([]);
    expect(receipts("key-empty", true)).toEqual([]);
    // every refused sign-in asks for the catch-up, whether or not it gets receipts
    expect(asked).toEqual(["key-known", "key-known", "key-stranger", "key-empty"]);
  });
});

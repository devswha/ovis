import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountDeviceStore, type AccountRowPorts } from "./account-devices.ts";
import { keyOf, listOrigins, snapshotList as list, nameOf, SERVER } from "./account-devices.test-helpers.ts";
import { ITS_ME_MIN_AGE_MS, JOIN_HOLD_MS, type Sayer } from "./join-hold.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function machine(over: Partial<AccountRowPorts> = {}, first: { othersEver?: boolean; listKey?: string | null; otherRows?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "s2-29-"));
  dirs.push(dir);
  const clock = { now: 5 * ITS_ME_MIN_AGE_MS };
  const events: string[] = [];
  const binding = { othersEver: first.othersEver ?? true, listKey: first.listKey === undefined || first.listKey === null ? null : keyOf(first.listKey), otherRows: first.otherRows ?? false };
  const ports: AccountRowPorts = {
    journal: (entry) => { events.push(`journal ${entry.kind} ${nameOf(entry.key)}`); },
    closeSessions: () => {},
    heldByDevicesJson: () => false,
    admits: () => true,
    publish: (entry) => { events.push(`publish ${nameOf(entry.key)}`); },
    now: () => clock.now,
    admitOrigin: listOrigins(),
    firstDevice: {
      othersEver: () => binding.othersEver,
      setOthersEver: () => { events.push("others_ever"); binding.othersEver = true; },
      listKey: () => binding.listKey,
      otherRows: () => binding.otherRows,
    },
    ...over,
  };
  return { dir, clock, events, binding, ports, store: new AccountDeviceStore(dir, SERVER, ports) };
}

const established = (over: Partial<Sayer> = {}): Sayer => ({ key: keyOf("k-old"), drives: true, state: "live", no: 1, late: false, admitNo: null, admittedAt: 0, ...over });

describe("S2-29 the join hold and the first device (T34, T53, T67)", () => {
  test("T34: durable notice publication precedes any held row access and starts the ten seconds", () => {
    const { store, events, clock } = machine();
    store.commitList(list(["k-new"]));
    expect(events).toEqual(["journal admit k-new", "publish k-new"]);
    const [row] = store.rows();
    expect(store.access(row!.id)).toEqual({ refused: "join_hold", seconds: 10 });
    clock.now += JOIN_HOLD_MS - 1;
    expect(store.access(row!.id)).toEqual({ refused: "join_hold", seconds: 1 });
    clock.now += 1;
    expect(store.access(row!.id)).toEqual({ ok: true });

    // a notice that could not be published starts no ten seconds: the row stays held however long it waits
    let diskFull = true;
    const failing = machine({ publish: () => { if (diskFull) throw new Error("journal unseen set not written"); } });
    failing.store.commitList(list(["k-new"]));
    const [held] = failing.store.rows();
    failing.clock.now += 10 * JOIN_HOLD_MS;
    expect(failing.store.access(held!.id)).toEqual({ refused: "join_hold", seconds: null });
    diskFull = false;
    failing.store.republish();
    expect(failing.store.access(held!.id)).toEqual({ refused: "join_hold", seconds: 10 });
  });

  test("T53: timer or established older proved caller ends the hold only with a final unchanged admission check", () => {
    let admits = true;
    const { store, clock } = machine({ admits: () => admits });
    store.commitList({ ...list(["k-new"]), devices: [{ key: keyOf("k-new"), no: 5, label: "new", eligible: true }] });
    const [row] = store.rows();

    // who may say "It's me": a driving, live row with a lower order number, admitted here over an hour ago
    const refusedBy: [string, Sayer][] = [
      ["watch row", established({ drives: false })],
      ["in its own hold", established({ state: "hold" })],
      ["on hold for a read", established({ state: "waiting" })],
      ["not older", established({ no: 5 })],
      ["newer", established({ no: 9 })],
      ["late order number", established({ late: true })],
      ["admitted within the hour", established({ admittedAt: clock.now - ITS_ME_MIN_AGE_MS + 1 })],
      ["admission time ahead of the clock", established({ admittedAt: clock.now + 60_000 })],
      ["no age at all", established({ no: null, admitNo: null })],
      ["the held row itself", established({ key: keyOf("k-new") })],
    ];
    for (const [name, sayer] of refusedBy) expect({ name, ended: store.itsMe(row!.id, sayer) }).toEqual({ name, ended: false });
    expect(store.access(row!.id)).toMatchObject({ refused: "join_hold" });

    // an established older row ends it, but only if the admission check still passes at that moment
    admits = false;
    expect(store.itsMe(row!.id, established())).toBe(false);
    admits = true;
    expect(store.itsMe(row!.id, established())).toBe(true);
    expect(store.access(row!.id)).toEqual({ ok: true });

    // the timer also asks the admission check again: a row that fails it stays out after its ten seconds
    const timed = machine();
    timed.store.commitList(list(["k-new"]));
    const [later] = timed.store.rows();
    timed.clock.now += JOIN_HOLD_MS;
    timed.ports.admits = () => false;
    expect(timed.store.access(later!.id)).toEqual({ refused: "admission" });
    timed.ports.admits = () => true;
    expect(timed.store.access(later!.id)).toEqual({ ok: true });
    expect(new AccountDeviceStore(timed.dir, SERVER, timed.ports).live(later!.id)).toBe(true);
  });

  test("T67: first-device bypass requires proved same key and no other key, row or history, and cannot happen twice", () => {
    const first = () => machine({}, { othersEver: false, listKey: "k-first", otherRows: false });

    const ok = first();
    ok.store.commitList(list(["k-first"]));
    expect(ok.events).toEqual(["others_ever", "journal admit k-first", "publish k-first"]);
    expect(ok.store.access(ok.store.rows()[0]!.id)).toEqual({ ok: true });

    const cases: [string, ReturnType<typeof first>, ReturnType<typeof list>][] = [
      ["another key in the list", first(), list(["k-first", "k-other"])],
      ["another key removed", first(), list(["k-first"], ["k-gone"])],
      ["another row on this PC", machine({}, { othersEver: false, listKey: "k-first", otherRows: true }), list(["k-first"])],
      ["history: others_ever set", machine({}, { othersEver: true, listKey: "k-first" }), list(["k-first"])],
      ["key not proved in the link", machine({}, { othersEver: false, listKey: null }), list(["k-first"])],
      ["a different key", machine({}, { othersEver: false, listKey: "k-proved" }), list(["k-first"])],
    ];
    for (const [name, pc, read] of cases) {
      pc.store.commitList(read);
      const row = pc.store.rows().find((candidate) => candidate.key === keyOf("k-first"));
      expect({ name, access: pc.store.access(row!.id) }).toEqual({ name, access: { refused: "join_hold", seconds: 10 } });
    }

    // used up by its first use: the same key named again after it left takes the hold
    ok.store.commitList(list([]));
    ok.store.commitList(list(["k-first"]));
    expect(ok.store.access(ok.store.rows()[0]!.id)).toEqual({ refused: "join_hold", seconds: 10 });
  });
});

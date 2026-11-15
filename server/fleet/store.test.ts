import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FLEET_MAX, fleetMax, FleetStore, FleetStoreError, parseFleetStore } from "./store.ts";
import { Fleet } from "./sessions.ts";
import { machineKey } from "./test-helpers.ts";
import type { MachineKey } from "./test-helpers.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-store-"));
  dirs.push(dir);
  return dir;
}
const storePath = (dir: string) => join(dir, "fleet", "machines.json");
/** A file's POSIX mode; Windows keeps none (writePrivateState's modes apply on POSIX only), so it reads as wanted there. */
const mode = (path: string, wanted?: string) => process.platform === "win32" && wanted ? wanted : (statSync(path).mode & 0o777).toString(8);
const keys = (count: number) => Promise.all(Array.from({ length: count }, () => machineKey()));
const add = (store: FleetStore, key: MachineKey, name = "m") => store.add({ machine_id: key.id, public_key: key.spki, name });
function failure(run: () => unknown): FleetStoreError {
  try { run(); } catch (error) { if (error instanceof FleetStoreError) return error; throw error; }
  throw new Error("expected a FleetStoreError");
}

describe("FleetStore", () => {
  it("starts empty without a file and writes machines.json 0600 in a 0700 folder", async () => {
    const dir = stateDir();
    const store = new FleetStore({ stateDir: dir, now: () => 1_000 });
    expect(store.machines()).toEqual([]);
    const [key] = await keys(1);
    const made = add(store, key!, "build-01");
    expect(made).toEqual({ machine_id: key!.id, public_key: key!.spki, state: "pending", slot: null, invite_id: null, runtime_id: null, name: "build-01", created_at: 1_000, updated_at: 1_000, seen_at: null, pace_slot: 0 });
    expect(mode(storePath(dir), "600")).toBe("600");
    expect(mode(join(dir, "fleet"), "700")).toBe("700");
    expect(JSON.parse(readFileSync(storePath(dir), "utf8"))).toEqual({ v: 1, machines: [made], invites: [], batches: [], generation: null, hold: false, witness_id: null });
    expect(new FleetStore({ stateDir: dir }).machines()).toEqual([made]);
  });

  it("moves states only forward along pending, active, quarantined, revoked", async () => {
    const store = new FleetStore({ stateDir: stateDir() });
    const [a, b, c] = await keys(3);
    add(store, a!);
    expect(store.setState(a!.id, "pending").state).toBe("pending");
    expect(store.setState(a!.id, "active").state).toBe("active");
    expect(failure(() => store.setState(a!.id, "pending")).code).toBe("transition");
    expect(store.setState(a!.id, "quarantined").state).toBe("quarantined");
    expect(failure(() => store.setState(a!.id, "active")).code).toBe("transition");
    expect(store.setState(a!.id, "revoked").state).toBe("revoked");
    for (const state of ["pending", "active", "quarantined"] as const) expect(failure(() => store.setState(a!.id, state)).code).toBe("transition");
    add(store, b!);
    expect(store.setState(b!.id, "quarantined").state).toBe("quarantined");
    add(store, c!);
    expect(store.setState(c!.id, "revoked").state).toBe("revoked");
    expect(failure(() => store.setState("0".repeat(32), "active")).code).toBe("unknown");
  });

  it("refuses a record whose machine_id is not its key's fingerprint, a second record for one id, and more than its max", async () => {
    const store = new FleetStore({ stateDir: stateDir(), max: 2 });
    const [a, b, c, d] = await keys(4);
    expect(failure(() => store.add({ machine_id: b!.id, public_key: a!.spki })).code).toBe("invalid");
    add(store, a!);
    expect(failure(() => add(store, a!)).code).toBe("exists");
    add(store, b!);
    expect(failure(() => add(store, c!)).code).toBe("controller_limit");
    // a revoked machine holds no place
    store.setState(b!.id, "revoked");
    add(store, c!);
    expect(failure(() => add(store, d!)).code).toBe("controller_limit");
    expect(store.machines().map((machine) => machine.machine_id)).toEqual([a!.id, b!.id, c!.id]);
  });

  it("removes a record and tells every watcher of each change, and of none that changed nothing", async () => {
    const store = new FleetStore({ stateDir: stateDir() });
    const [a] = await keys(1);
    let told = 0;
    const stop = store.onChange(() => { told += 1; });
    add(store, a!);
    store.setState(a!.id, "active");
    store.setState(a!.id, "active");
    expect(store.remove(a!.id)).toBe(true);
    expect(store.remove(a!.id)).toBe(false);
    expect(told).toBe(3);
    stop();
    add(store, a!);
    expect(told).toBe(3);
    expect(store.machines().length).toBe(1);
  });

  it("refuses a corrupt or hand-edited file loudly, keeps its bytes and refuses every change", async () => {
    const [a, b] = await keys(2);
    const good = { machine_id: a!.id, public_key: a!.spki, state: "active", slot: 3, invite_id: "0123456789abcdef", runtime_id: "rt-1", name: "a", created_at: 1, updated_at: 2 };
    const documents: [string, string][] = [
      ["not JSON", "{\"v\":1,\"machines\":["],
      ["another version", JSON.stringify({ v: 2, machines: [good] })],
      ["an unknown top-level key", JSON.stringify({ v: 1, machines: [good], extra: true })],
      ["no machines list", JSON.stringify({ v: 1 })],
      ["machine_id of another key", JSON.stringify({ v: 1, machines: [{ ...good, machine_id: b!.id }] })],
      ["an unknown state", JSON.stringify({ v: 1, machines: [{ ...good, state: "trusted" }] })],
      ["an unknown record key", JSON.stringify({ v: 1, machines: [{ ...good, bridge_token: "00" }] })],
      ["a missing key", JSON.stringify({ v: 1, machines: [{ ...good, name: undefined }] })],
      ["one machine twice", JSON.stringify({ v: 1, machines: [good, good] })],
      ["a slot out of range", JSON.stringify({ v: 1, machines: [{ ...good, slot: 70_000 }] })],
      ["an empty list in a wrong shape", "[]"],
    ];
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
    try {
      for (const [what, text] of documents) {
        const dir = stateDir();
        mkdirSync(join(dir, "fleet"), { recursive: true });
        writeFileSync(storePath(dir), text, { mode: 0o600 });
        const store = new FleetStore({ stateDir: dir });
        expect(store.error, what).toBeInstanceOf(FleetStoreError);
        expect(store.error?.code, what).toBe("invalid");
        expect(() => store.machines(), what).toThrow(FleetStoreError);
        expect(failure(() => add(store, b!)).code, what).toBe("invalid");
        expect(readFileSync(storePath(dir), "utf8"), what).toBe(text);
      }
    } finally { console.error = original; }
    // loud: one line logged for each refused file (its wording is for people, not pinned here)
    expect(logged.length).toBe(documents.length);
    expect(parseFleetStore(JSON.stringify({ v: 1, machines: [good] }))).toEqual([{ ...good, seen_at: null }] as never);
  });

  it("keeps the changes of two stores on one folder, each reading the file again before it writes", async () => {
    const dir = stateDir();
    const one = new FleetStore({ stateDir: dir });
    const two = new FleetStore({ stateDir: dir });
    const [a, b, c] = await keys(3);
    add(one, a!);
    add(two, b!);
    one.setState(a!.id, "active");
    add(two, c!);
    expect(new FleetStore({ stateDir: dir }).machines().map((machine) => [machine.machine_id, machine.state]))
      .toEqual([[a!.id, "active"], [b!.id, "pending"], [c!.id, "pending"]]);
  });

  it("loses no machine when eight processes add one each at the same moment", async () => {
    const dir = stateDir();
    const added = await keys(8);
    const script = join(dir, "add.ts");
    writeFileSync(script, `import { FleetStore } from ${JSON.stringify(join(import.meta.dir, "store.ts"))};
const [stateDir, id, spki, go] = process.argv.slice(2);
const start = Number(go);
while (Date.now() < start) {}
new FleetStore({ stateDir }).add({ machine_id: id, public_key: spki });
`);
    const go = Date.now() + 1_500;
    const children = added.map((key) => Bun.spawn([process.execPath, script, dir, key.id, key.spki, String(go)], { stdout: "pipe", stderr: "pipe" }));
    const codes = await Promise.all(children.map(async (child) => [await child.exited, await new Response(child.stderr).text()] as const));
    expect(codes.filter(([code]) => code !== 0)).toEqual([]);
    const ids = new FleetStore({ stateDir: dir }).machines().map((machine) => machine.machine_id).sort();
    expect(ids).toEqual(added.map((key) => key.id).sort());
    expect(mode(storePath(dir), "600")).toBe("600");
  }, 30_000);
});

describe("fleetMax", () => {
  it("reads OVIS_FLEET_MAX as 1..1000 and refuses anything else loudly", () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
    try {
      expect(fleetMax({})).toBe(DEFAULT_FLEET_MAX);
      expect(fleetMax({ OVIS_FLEET_MAX: "1" })).toBe(1);
      expect(fleetMax({ OVIS_FLEET_MAX: "1000" })).toBe(1000);
      expect(logged).toEqual([]);
      for (const text of ["0", "1001", "-5", "12.5", "lots", "1e3"]) expect(fleetMax({ OVIS_FLEET_MAX: text })).toBe(DEFAULT_FLEET_MAX);
      expect(logged.length).toBe(6);
    } finally { console.error = original; }
  });

  describe("pace_slot (todo 37)", () => {
    const enrol = (store: FleetStore, key: MachineKey, slot: number | null = null) => {
      store.add({ machine_id: key.id, public_key: key.spki, slot });
      return store.setState(key.id, "active");
    };
    const slots = (store: FleetStore) => Object.fromEntries(store.machines().map((machine) => [machine.machine_id, machine.pace_slot]));

    it("gives each machine made active the lowest free slot and keeps every slot across an enrolment, a removal and a re-enrolment", async () => {
      const store = new FleetStore({ stateDir: stateDir(), max: 100 });
      const [a, b, c, d, e] = await keys(5);
      expect([enrol(store, a!, 1).pace_slot, enrol(store, b!, 2).pace_slot, enrol(store, c!, 3).pace_slot]).toEqual([0, 1, 2]);
      const before = slots(store);
      // an enrolment changes no other machine's slot
      expect(enrol(store, d!).pace_slot).toBe(3);
      expect({ ...slots(store), [d!.id]: undefined }).toEqual({ ...before, [d!.id]: undefined });
      // a removal (online: it heard auth_revoked) frees its slot and moves nobody
      const kept = slots(store);
      store.remove(b!.id);
      expect(slots(store)).toEqual(Object.fromEntries(Object.entries(kept).filter(([id]) => id !== b!.id)));
      // a re-enrolment into C's invite slot: C's key revoked, a new key enrolled there keeps C's pace slot
      store.setState(c!.id, "revoked");
      expect(enrol(store, e!, 3).pace_slot).toBe(2);
      expect(store.get(c!.id)!.pace_slot).toBeUndefined();
      // and a later machine takes the slot B left, the lowest free
      const [f] = await keys(1);
      expect(enrol(store, f!).pace_slot).toBe(1);
      expect(new FleetStore({ stateDir: dirs.at(-1)!, max: 100 }).machines()).toEqual(store.machines());
    });

    it("gives a slot freed by removing an offline machine out last, and only when no never-used slot is left", async () => {
      const dir = stateDir();
      const store = new FleetStore({ stateDir: dir, max: 3 });
      const [a, b, c, d] = await keys(4);
      enrol(store, a!);
      enrol(store, b!);
      store.remove(a!.id, { offline: true });
      expect(store.retiredPaceSlots()).toEqual([0]);
      expect(enrol(store, c!).pace_slot).toBe(2);
      expect(enrol(store, d!).pace_slot).toBe(0);
      expect(store.retiredPaceSlots()).toEqual([]);
      expect(JSON.parse(readFileSync(storePath(dir), "utf8")).retired_pace_slots).toBeUndefined();
    });

    it("gives machines made active before pace slots their slots when a fleet with its token starts, the lowest free, once; a held one skips quietly", async () => {
      const dir = stateDir();
      const store = new FleetStore({ stateDir: dir, max: 100 });
      const [a, b, c] = await keys(3);
      enrol(store, a!);
      for (const key of [b!, c!]) store.add({ machine_id: key.id, public_key: key.spki });
      // b and c were made active by a build without pace slots: their records have none
      const file = JSON.parse(readFileSync(storePath(dir), "utf8"));
      for (const record of file.machines) if (record.machine_id !== a!.id) { record.state = "active"; delete record.pace_slot; }
      writeFileSync(storePath(dir), JSON.stringify(file));
      const fresh = new FleetStore({ stateDir: dir, max: 100 });
      expect(fresh.machines().map((machine) => machine.pace_slot)).toEqual([0, undefined, undefined]);
      // held (this server has no token, todo 60): the start writes nothing and logs nothing about pace slots
      const unwritten = readFileSync(storePath(dir), "utf8");
      const logged = spyOn(console, "error");
      const held = new Fleet({ stateDir: dir, store: fresh });
      held.start();
      const paceLines = logged.mock.calls.filter((call) => String(call[0]).includes("pace slot"));
      logged.mockRestore();
      expect(paceLines).toEqual([]);
      expect(readFileSync(storePath(dir), "utf8")).toBe(unwritten);
      await held.close();
      // with the token the next start gives them
      const fleet = new Fleet({ stateDir: dir, store: fresh, tokenConfigured: true });
      fleet.start();
      expect(fresh.machines().map((machine) => machine.pace_slot)).toEqual([0, 1, 2]);
      const written = readFileSync(storePath(dir), "utf8");
      fleet.start();
      new Fleet({ stateDir: dir, store: new FleetStore({ stateDir: dir, max: 100 }), tokenConfigured: true }).start();
      expect(readFileSync(storePath(dir), "utf8")).toBe(written);
      await fleet.close();
    });

    it("reads a file written before pace slots, and refuses one that gives a slot twice", async () => {
      const dir = stateDir();
      const store = new FleetStore({ stateDir: dir });
      const [a, b] = await keys(2);
      add(store, a!);
      add(store, b!);
      const file = JSON.parse(readFileSync(storePath(dir), "utf8"));
      expect(new FleetStore({ stateDir: dir }).error).toBeUndefined();
      file.machines[0].pace_slot = 4;
      file.machines[1].pace_slot = 4;
      writeFileSync(storePath(dir), JSON.stringify(file));
      expect(new FleetStore({ stateDir: dir }).error?.code).toBe("invalid");
    });
  });
});

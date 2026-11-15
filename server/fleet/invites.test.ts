/**
 * The invites of a fleet store on a mkdtemp state folder (server/fleet/invites.ts), with the controller's clock injected:
 * what a mint makes and what it stores, the bounds of a mint, how invites are listed, a batch's digest and its
 * confirmation, the admission queue under a wave, the try budgets, a lock left by a crashed writer, and what a flood of
 * unknown invites costs. Sessions and routes are in enroll.contract.test.ts and routes-access.contract.test.ts.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import {
  batchDigest, DEFAULT_INVITE_LIFE_S, ENROLL_FAILURES_PER_ADDRESS, ENROLL_TRIES_PER_INVITE, FleetInvites, FleetRouteError, inviteKey, MAX_INVITE_LIFE_S,
  MAX_INVITES_PER_MINT, MAX_OPEN_INVITES, mintRequest, parseInvite,
} from "./invites.ts";
import type { Invite, InviteController } from "./invites.ts";
import { FleetStore } from "./store.ts";
import { machineKey, signEnroll, testOwner, turnFleetOn } from "./test-helpers.ts";

// each test makes a few synced store writes: on a loaded disk they can pass bun's 5 s default (as direct.contract.test.ts says)
setDefaultTimeout(30_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const T0 = Date.UTC(2026, 10, 13, 12);
const keys = generateKeyPair();
const CONTROLLER: InviteController = {
  server_id: deriveServerId(keys.publicKey), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.ovis.example", direct: ["ws://192.168.1.20:7319"],
};
const describeController = async () => CONTROLLER;

function setup(options: { max?: number } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-invites-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  let now = T0;
  const store = new FleetStore({ stateDir, max: options.max ?? 1000, now: () => now });
  turnFleetOn(stateDir);
  const alerts: unknown[] = [];
  const invites = new FleetInvites(store, { now: () => now, onAlert: (alert) => alerts.push(alert) });
  return { stateDir, store, invites, alerts, advance: (ms: number) => { now += ms; }, now: () => now, bytes: () => readFileSync(store.path) };
}
const mint = (invites: FleetInvites, body: Record<string, unknown> = {}) => invites.mint(mintRequest(body), describeController);
const binding = (seed: number) => new Uint8Array(32).fill(seed);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Every form a secret could be written in: raw, hex, base64 and base64url. */
function forms(secret: string): string[] {
  const raw = Buffer.from(secret, "base64url");
  return [raw.toString("latin1"), raw.toString("hex"), raw.toString("base64"), raw.toString("base64url"), secret];
}
async function failure(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) { if (error instanceof FleetRouteError) return error.code; throw error; }
  throw new Error("expected a FleetRouteError");
}

describe("a mint", () => {
  it("makes invite files of section 4 whose key is derived from their secret, and stores none of the secrets", async () => {
    const { invites, store, stateDir } = setup();
    const minted = await mint(invites, { count: 3, prefix: "vm-" });
    expect(minted.count).toBe(3);
    expect(minted.exp).toBe(Math.floor(T0 / 1000) + DEFAULT_INVITE_LIFE_S);
    for (const invite of minted.invites) {
      // the file as a machine reads it, unchanged by a round trip through its reader
      expect(parseInvite(Buffer.from(JSON.stringify(invite)))).toEqual(invite);
      expect(Object.keys(invite)).toEqual(["v", "id", "slot", "controller", "owner", "secret", "exp"]);
      expect(invite.controller).toEqual(CONTROLLER);
      expect(Buffer.from(invite.secret, "base64url")).toHaveLength(32);
    }
    const stored = store.document().invites;
    expect(stored.map((entry) => Object.keys(entry).sort())).toEqual(Array(3).fill(["batch_id", "created_at", "exp", "id", "name", "public_key", "slot", "used_by"]));
    for (const [index, entry] of stored.entries()) {
      const invite = minted.invites[index]!;
      expect([entry.id, entry.slot, entry.name, entry.batch_id, entry.exp, entry.used_by]).toEqual([invite.id, invite.slot, `vm-${invite.slot}`, minted.batch_id, invite.exp, null]);
      expect(entry.public_key).toBe(Buffer.from(inviteKey(Buffer.from(invite.secret, "base64url"), invite.id).publicKey).toString("hex"));
    }
    // no file under the state folder holds a secret in any form
    const files = readdirSync(stateDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1"));
    for (const invite of minted.invites) for (const form of forms(invite.secret)) for (const text of files) expect(text.includes(form)).toBe(false);
  });

  it("makes at most 256 per call and keeps at most 1024 open, a life of 1 h unless asked and never more than 24 h", async () => {
    const { invites, advance } = setup();
    expect(() => mintRequest({ count: MAX_INVITES_PER_MINT + 1 })).toThrow(FleetRouteError);
    expect(() => mintRequest({ count: 0 })).toThrow(FleetRouteError);
    expect(() => mintRequest({ life_s: MAX_INVITE_LIFE_S + 1 })).toThrow(FleetRouteError);
    expect(() => mintRequest({ prefix: "bad prefix" })).toThrow(FleetRouteError);
    expect(() => mintRequest({ secret: "x" })).toThrow(FleetRouteError);
    expect(mintRequest({})).toEqual({ count: 1, prefix: "machine-", life_s: DEFAULT_INVITE_LIFE_S, direct_hosts: [] });
    for (let index = 0; index < MAX_OPEN_INVITES / MAX_INVITES_PER_MINT; index++) await mint(invites, { count: MAX_INVITES_PER_MINT, life_s: 120 });
    expect(invites.openInvites()).toBe(MAX_OPEN_INVITES);
    expect(await failure(mint(invites, { count: 1 }))).toBe("too_many_invites");
    // expired invites are not open: room again, and the slots of the earlier ones stay theirs
    advance(121_000);
    expect(invites.openInvites()).toBe(0);
    const later = await mint(invites, { count: 1, life_s: MAX_INVITE_LIFE_S });
    expect(later.invites[0]!.slot).toBe(MAX_OPEN_INVITES);
    expect(later.exp).toBe(Math.floor((T0 + 121_000) / 1000) + MAX_INVITE_LIFE_S);
  }, 60_000);

  it("never voids an earlier invite: two mints side by side both stand and both admit", async () => {
    const { invites } = setup();
    const [first, second] = await Promise.all([mint(invites, { count: 2 }), mint(invites, { count: 2 })]);
    expect(new Set([...first!.invites, ...second!.invites].map((invite) => invite.slot)).size).toBe(4);
    expect(invites.list().map((row) => row.state)).toEqual(["unused", "unused", "unused", "unused"]);
    for (const invite of [first!.invites[0]!, second!.invites[0]!]) {
      const key = await machineKey();
      expect(await invites.enroll(signEnroll(key, invite, binding(1)), { binding: binding(1) })).toEqual({ machineId: key.id });
    }
  });

  it("is taken back whole when the controller has no carrier a machine could reach", async () => {
    const { invites, bytes } = setup();
    await mint(invites, { count: 1 });
    const before = bytes();
    expect(await failure(invites.mint(mintRequest({ count: 2 }), async () => null))).toBe("fleet_unavailable");
    let calls = 0;
    expect(await failure(invites.mint(mintRequest({ count: 2 }), async () => (++calls === 1 ? CONTROLLER : { ...CONTROLLER, relay: null, direct: [] })))).toBe("fleet_unavailable");
    expect(bytes().equals(before)).toBe(true);
  });

  it("names a direct host on the controller's direct port", async () => {
    const { invites } = setup();
    const minted = await mint(invites, { direct_hosts: ["build-01.lan"] });
    expect(minted.invites[0]!.controller.direct).toEqual(["ws://192.168.1.20:7319", "ws://build-01.lan:7319"]);
  });
});

describe("the invite list", () => {
  it("names each invite unused, used or expired on the controller's clock", async () => {
    const { invites, advance } = setup();
    const minted = await mint(invites, { count: 3, life_s: 60 });
    const key = await machineKey();
    await invites.enroll(signEnroll(key, minted.invites[1]!, binding(1)), { binding: binding(1) });
    expect(invites.list().map((row) => [row.slot, row.state])).toEqual([[0, "unused"], [1, "used"], [2, "unused"]]);
    advance(60_000);
    expect(invites.list().map((row) => [row.slot, row.state])).toEqual([[0, "expired"], [1, "used"], [2, "expired"]]);
    expect(JSON.stringify(invites.list())).not.toContain(minted.invites[0]!.secret);
  });
});

describe("a batch", () => {
  it("lists its pending machines with their fingerprints, its count and a digest, and a confirm with both activates exactly them", async () => {
    const { invites, store, bytes } = setup();
    const minted = await mint(invites, { count: 3, prefix: "vm-" });
    const enrolled = [];
    for (const invite of minted.invites.slice(0, 2)) {
      const key = await machineKey();
      expect(await invites.enroll(signEnroll(key, invite, binding(1)), { binding: binding(1) })).toEqual({ machineId: key.id });
      enrolled.push(key.id);
    }
    const [row] = invites.batches();
    expect(row).toMatchObject({ batch_id: minted.batch_id, count: 2, invites: { unused: 1, used: 2, expired: 0 } });
    expect(row!.machines.map((machine) => machine.fingerprint)).toEqual(enrolled.map((id) => id.match(/.{4}/g)!.join(" ")));
    expect(row!.digest).toBe(createHash("sha256").update([...enrolled].sort().join("")).digest("hex"));
    expect(row!.digest).toBe(batchDigest(enrolled));
    // a refused confirm changes nothing
    const before = bytes();
    expect(await failure(invites.confirm(minted.batch_id, 3, row!.digest))).toBe("batch_changed");
    expect(await failure(invites.confirm(minted.batch_id, 2, "0".repeat(64)))).toBe("batch_changed");
    expect(await failure(invites.confirm("0".repeat(16), 2, row!.digest))).toBe("unknown_batch");
    expect(bytes().equals(before)).toBe(true);
    expect(await invites.confirm(minted.batch_id, 2, row!.digest)).toEqual({ batch_id: minted.batch_id, activated: [...enrolled].sort() });
    expect(store.machines().map((machine) => machine.state)).toEqual(["active", "active"]);
    expect(invites.batches()).toEqual([]);
  });

  it("activates only its own batch: another batch's pending machines stay pending", async () => {
    const { invites, store } = setup();
    const first = await mint(invites, { count: 1 });
    const second = await mint(invites, { count: 1 });
    const [one, two] = [await machineKey(), await machineKey()];
    await invites.enroll(signEnroll(one, first.invites[0]!, binding(1)), { binding: binding(1) });
    await invites.enroll(signEnroll(two, second.invites[0]!, binding(2)), { binding: binding(2) });
    const row = invites.batches().find((entry) => entry.batch_id === first.batch_id)!;
    expect(await invites.confirm(first.batch_id, row.count, row.digest)).toEqual({ batch_id: first.batch_id, activated: [one.id] });
    expect(store.get(one.id)?.state).toBe("active");
    expect(store.get(two.id)?.state).toBe("pending");
    expect(invites.batches().map((entry) => entry.batch_id)).toEqual([second.batch_id]);
  });

  it("refuses a confirm whose digest predates one more enrolment into the batch, and activates nothing", async () => {
    const { invites, store } = setup();
    const minted = await mint(invites, { count: 2 });
    const first = await machineKey();
    await invites.enroll(signEnroll(first, minted.invites[0]!, binding(1)), { binding: binding(1) });
    const shown = invites.batches()[0]!;
    const second = await machineKey();
    await invites.enroll(signEnroll(second, minted.invites[1]!, binding(2)), { binding: binding(2) });
    expect(await failure(invites.confirm(minted.batch_id, shown.count, shown.digest))).toBe("batch_changed");
    expect(store.machines().every((machine) => machine.state === "pending")).toBe(true);
  });
});

describe("the admission queue", () => {
  it("admits a wave of 100 enrolments on 100 invites, each exactly once, with far fewer store writes than machines", async () => {
    const { invites, store } = setup();
    const minted = await mint(invites, { count: 100, prefix: "vm-" });
    const machineKeys = await Promise.all(minted.invites.map(() => machineKey()));
    let writes = 0;
    const unwatch = store.onChange(() => { writes++; });
    const results = await Promise.all(minted.invites.map((invite, index) => invites.enroll(signEnroll(machineKeys[index]!, invite, binding(index)), { binding: binding(index) })));
    unwatch();
    expect(results).toEqual(machineKeys.map((key) => ({ machineId: key.id })));
    expect(store.machines()).toHaveLength(100);
    expect(new Set(store.machines().map((machine) => machine.slot)).size).toBe(100);
    console.log(JSON.stringify({ event: "measure.enroll_wave", machines: 100, store_writes: writes }));
    expect(writes).toBeLessThan(100);
  }, 60_000);

  it("gives one key presenting one invite many times at once the same answer and one machine", async () => {
    const { invites, store } = setup();
    const [invite] = (await mint(invites)).invites;
    const key = await machineKey();
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => invites.enroll(signEnroll(key, invite!, binding(index)), { binding: binding(index) })));
    expect(new Set(results.map((result) => JSON.stringify(result)))).toEqual(new Set([JSON.stringify({ machineId: key.id })]));
    expect(store.machines()).toHaveLength(1);
  });

  it("quarantines the slot when a second key presents a used invite: neither key is admitted, the second is not kept, an alert is raised", async () => {
    const { invites, store, alerts } = setup();
    const [invite] = (await mint(invites)).invites;
    const first = await machineKey();
    const second = await machineKey();
    expect(await invites.enroll(signEnroll(first, invite!, binding(1)), { binding: binding(1) })).toEqual({ machineId: first.id });
    expect(await invites.enroll(signEnroll(second, invite!, binding(2)), { binding: binding(2) })).toEqual({ code: "auth_revoked", cause: "quarantined" });
    expect(store.machines().map((machine) => [machine.machine_id, machine.state, machine.slot])).toEqual([[first.id, "quarantined", invite!.slot]]);
    expect(readFileSync(store.path, "utf8")).not.toContain(second.spki);
    expect(alerts).toEqual([{ kind: "quarantined", reason: "second_key", machine_id: first.id, slot: invite!.slot, invite_id: invite!.id }]);
    // the first key asking again is refused too
    expect(await invites.enroll(signEnroll(first, invite!, binding(3)), { binding: binding(3) })).toEqual({ code: "auth_revoked", cause: "quarantined" });
  });

  it("racing two keys on one invite admits one and quarantines it", async () => {
    const { invites, store } = setup();
    const [invite] = (await mint(invites)).invites;
    const [one, two] = [await machineKey(), await machineKey()];
    const results = await Promise.all([one, two].map((key, index) => invites.enroll(signEnroll(key, invite!, binding(index)), { binding: binding(index) })));
    expect(results.filter((result) => "machineId" in result)).toHaveLength(1);
    expect(results.filter((result) => "code" in result)).toEqual([{ code: "auth_revoked", cause: "quarantined" }]);
    expect(store.machines().map((machine) => machine.state)).toEqual(["quarantined"]);
  });

  it("stops admitting an invite the moment it expires, judged by the controller's clock only", async () => {
    const { invites, advance, bytes } = setup();
    const [invite] = (await mint(invites, { life_s: 60 })).invites;
    advance(60_000);
    const key = await machineKey();
    const before = bytes();
    const enroll = { ...signEnroll(key, invite!, binding(1)), now: 0 };
    expect(await invites.enroll(enroll, { binding: binding(1) })).toEqual({ code: "auth_failed", cause: "expired" });
    expect(bytes().equals(before)).toBe(true);
  });

  it("re-checks the expiry in the queue: an invite that expires between the first checks and its turn admits nobody", async () => {
    const { invites, advance, bytes } = setup();
    const [invite] = (await mint(invites, { life_s: 60 })).invites;
    const key = await machineKey();
    advance(59_999);
    const before = bytes();
    // the checks before the queue run before the first await: the clock moves past exp before the queue's turn
    const pending = invites.enroll(signEnroll(key, invite!, binding(1)), { binding: binding(1) });
    advance(1);
    expect(await pending).toEqual({ code: "auth_failed", cause: "expired" });
    expect(bytes().equals(before)).toBe(true);
    expect(invites.list()[0]!.state).toBe("expired");
  });

  it("refuses past OVIS_FLEET_MAX machines resource_exhausted controller_limit", async () => {
    const { invites } = setup({ max: 1 });
    const minted = await mint(invites, { count: 2 });
    const [one, two] = [await machineKey(), await machineKey()];
    expect(await invites.enroll(signEnroll(one, minted.invites[0]!, binding(1)), { binding: binding(1) })).toEqual({ machineId: one.id });
    expect(await invites.enroll(signEnroll(two, minted.invites[1]!, binding(2)), { binding: binding(2) })).toEqual({ code: "resource_exhausted", cause: "controller_limit" });
  });
});

describe("the try budgets", () => {
  it("refuses a bad ENROLL rate_limited after five refused tries, yet still admits the valid one, and keeps the budget in memory only", async () => {
    const { invites, bytes, store } = setup();
    const [invite] = (await mint(invites)).invites;
    const key = await machineKey();
    const before = bytes();
    for (let index = 0; index < ENROLL_TRIES_PER_INVITE; index++) {
      expect(await invites.enroll(signEnroll(key, invite!, binding(9)), { binding: binding(index) })).toEqual({ code: "auth_failed", cause: "signature" });
    }
    expect(await invites.enroll(signEnroll(key, invite!, binding(9)), { binding: binding(7) })).toEqual({ code: "auth_failed", cause: "rate_limited" });
    expect(bytes().equals(before)).toBe(true);
    expect(await invites.enroll(signEnroll(key, invite!, binding(1)), { binding: binding(1) })).toEqual({ machineId: key.id });
    expect(store.machines().map((machine) => machine.machine_id)).toEqual([key.id]);
  });

  it("cannot be spent to lock the real machine out: 100 junk ENROLLs for a real invite id, then the real machine enrols", async () => {
    const { invites, store, bytes } = setup();
    const [invite] = (await mint(invites)).invites;
    const key = await machineKey();
    const junk = { ...signEnroll(key, invite!, binding(1)), signature: Buffer.alloc(64, 7).toString("base64url") };
    const before = bytes();
    const started = performance.now();
    const answers = new Set<string>();
    for (let index = 0; index < 100; index++) answers.add(JSON.stringify(await invites.enroll(junk, { binding: binding(1) })));
    const perJunk = (performance.now() - started) / 100;
    console.log(JSON.stringify({ event: "measure.enroll_junk_for_a_real_invite", requests: 100, us_per_request: Math.round(perJunk * 1000) }));
    expect([...answers].sort()).toEqual([JSON.stringify({ code: "auth_failed", cause: "rate_limited" }), JSON.stringify({ code: "auth_failed", cause: "signature" })].sort());
    expect(bytes().equals(before)).toBe(true);
    expect(await invites.enroll(signEnroll(key, invite!, binding(2)), { binding: binding(2) })).toEqual({ machineId: key.id });
    expect(store.machines()).toHaveLength(1);
  });

  it("refuses a source address rate_limited after 20 refusals, never another address, and never touches the phones' pairing budget", async () => {
    const { invites, store } = setup();
    const [invite] = (await mint(invites)).invites;
    const key = await machineKey();
    const unknown = { ...signEnroll(key, invite!, binding(1)), invite_id: "0".repeat(16) };
    for (let index = 0; index < ENROLL_FAILURES_PER_ADDRESS; index++) expect(await invites.enroll(unknown, { binding: binding(1), source: "10.0.0.9" })).toEqual({ code: "auth_failed", cause: "unknown" });
    expect(await invites.enroll(signEnroll(key, invite!, binding(1)), { binding: binding(1), source: "10.0.0.9" })).toEqual({ code: "auth_failed", cause: "rate_limited" });
    expect(await invites.enroll(signEnroll(key, invite!, binding(2)), { binding: binding(2), source: "10.0.0.10" })).toEqual({ machineId: key.id });
    expect(store.machines()).toHaveLength(1);
  });

  it("bounds what a flood of unknown invites costs, and a real machine enrols right after it", async () => {
    const { invites, store } = setup();
    const [invite] = (await mint(invites)).invites;
    const key = await machineKey();
    const flood = { ...signEnroll(key, invite!, binding(1)), invite_id: "0".repeat(16) };
    Bun.gc(true);
    const heap = process.memoryUsage().heapUsed;
    const started = performance.now();
    for (let index = 0; index < 20_000; index++) await invites.enroll({ ...flood, invite_id: index.toString(16).padStart(16, "0") }, { binding: binding(1), source: `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}` });
    const elapsed = performance.now() - started;
    Bun.gc(true);
    const grown = process.memoryUsage().heapUsed - heap;
    console.log(JSON.stringify({ event: "measure.enroll_flood", requests: 20_000, ms: Math.round(elapsed), us_per_request: Math.round(elapsed * 50) / 1000, heap_growth_bytes: grown }));
    // no signature is checked for an id the store does not hold, and the address book holds at most 4096 windows
    expect(elapsed / 20_000).toBeLessThan(1);
    expect(grown).toBeLessThan(8 * 1024 * 1024);
    expect(await invites.enroll(signEnroll(key, invite!, binding(2)), { binding: binding(2), source: "10.0.0.1" })).toEqual({ machineId: key.id });
    expect(store.machines()).toHaveLength(1);
  }, 60_000);
});

describe("the store lock", () => {
  it("takes over at once a lock whose writer's process is gone, rather than refusing changes for 30 s", async () => {
    const { invites, store } = setup();
    // a process that ran and ended: its pid is free
    const ended = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    const pid = Number(ended.stdout.trim());
    mkdirSync(join(store.path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(`${store.path}.lock`, String(pid), { mode: 0o600 });
    // a live holder's lock would make this wait LOCK_WAIT_MS (5 s) and fail busy: it is taken over instead
    await mint(invites, { count: 1 });
    expect(invites.openInvites()).toBe(1);
  });

  it("waits for a lock a live writer holds and then refuses busy, writing nothing", async () => {
    const { invites, store, bytes } = setup();
    await mint(invites, { count: 1 });
    const before = bytes();
    writeFileSync(`${store.path}.lock`, "1", { mode: 0o600 });
    expect(await failure(mint(invites, { count: 1 }))).toBe("fleet_store_busy");
    rmSync(`${store.path}.lock`);
    expect(bytes().equals(before)).toBe(true);
    expect(hash(bytes())).toBe(hash(before));
  }, 20_000);
});

describe("an invite file read by a machine", () => {
  it("is refused whole for any broken rule", () => {
    const good: Invite = { v: 1, id: "0123456789abcdef", slot: 1, controller: CONTROLLER, owner: testOwner(CONTROLLER), secret: Buffer.alloc(32, 7).toString("base64url"), exp: 1 };
    expect(parseInvite(Buffer.from(JSON.stringify(good)))).toEqual(good);
    for (const bad of [{ ...good, slot: 65536 }, { ...good, id: "0123" }, { ...good, controller: { ...CONTROLLER, direct: ["ws://127.0.0.1:1"] } }, { ...good, controller: { ...CONTROLLER, relay: "wss://relay.example/x" } }, { ...good, exp: -1 }]) {
      expect(() => parseInvite(Buffer.from(JSON.stringify(bad)))).toThrow();
    }
    expect(() => parseInvite(Buffer.from("{"))).toThrow();
  });
});

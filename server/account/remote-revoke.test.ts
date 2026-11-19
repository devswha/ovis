import { afterEach, describe, expect, test } from "bun:test";
import { exportAccountKey, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import type { DeviceStore } from "../devices.ts";
import { relayConnection, relayFixture } from "../relay/test-helpers.ts";
import { applyAccountRecords } from "./records.ts";
import { handleRelayRequest } from "../relay/routes.ts";

const ACCOUNT = "acct_1";
const SERVER_ID = "0123456789abcdef0123456789abcdef";
const fixtures: ReturnType<typeof relayFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

interface Key { keys: CryptoKeyPair; spki: string }
async function key(): Promise<Key> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

function pc() {
  const f = relayFixture(false, { accountOpensAll: true });
  fixtures.push(f);
  return { f, devices: f.app.context.services.devices };
}

/** A drive member of the account here, admitted now: each one joins this PC after the ones before it. */
async function member(devices: DeviceStore): Promise<Key & { id: string }> {
  const k = await key();
  const id = devices.pairRelay(devices.startPairing().code, "Phone", k.spki)!.device.id;
  devices.linkAccountKey(id, k.spki, k.spki, ACCOUNT);
  return { ...k, id };
}

/** A request from `caller` through the relay, signed in with its key. */
async function remote(f: ReturnType<typeof relayFixture>, caller: Key & { id: string }) {
  const link = await relayConnection(f);
  await link.auth({ keys: caller.keys, publicKey: caller.spki, id: caller.id });
  return async (method: "GET" | "POST" | "DELETE", target: string) => {
    const response = await link.open(target, { method, headers: [["content-type", "application/json"], ["x-herdr-machine", "1"]] }).response;
    const text = await response.text();
    return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as { error?: { code: string; message: string }; devices?: { id: string; remote_revoke?: string }[]; revoke_all?: string } };
  };
}

/** A request on this PC itself: loopback, no forwarding, the app's own origin. */
const local = (f: ReturnType<typeof relayFixture>) => async (method: string, target: string) => {
  const base = `http://127.0.0.1:${f.app.port}`;
  const response = await fetch(base + target, { method, headers: { origin: base, "x-herdr-machine": "1" } });
  return { status: response.status };
};

describe("remote Revokes reach the caller itself and the rows that joined after it (rule B)", () => {
  test("T19: remote self or all-newer targets pass, but older or incomparable duplicates refuse the whole Revoke", async () => {
    const { f, devices } = pc();
    const [older, caller, newer, self] = [await member(devices), await member(devices), await member(devices), await member(devices)];
    const ask = await remote(f, caller);
    // the device list says, for this caller, what it may Revoke from afar
    const listed = (await ask("GET", "/api/devices")).body;
    expect(Object.fromEntries(listed.devices!.map((row) => [row.id, row.remote_revoke]))).toMatchObject({ [older.id]: "older", [caller.id]: "allowed", [newer.id]: "allowed" });
    expect(listed.revoke_all).toBe("local_only");
    // an older row is refused, with the words that say where it is done
    const refused = await ask("DELETE", `/api/devices/${older.id}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toEqual({ code: "older_device", message: "removing an older device is done from that PC or from an older device" });
    expect(devices.has(older.id)).toBe(true);
    // a newer row, and itself, pass
    expect((await ask("DELETE", `/api/devices/${newer.id}`)).status).toBe(204);
    expect(devices.has(newer.id)).toBe(false);
    // its own row: the Revoke ends the very session that asked, so the answer may not arrive; the row is gone
    const own = await remote(f, self);
    await own("DELETE", `/api/devices/${self.id}`).catch(() => undefined);
    expect(devices.has(self.id)).toBe(false);

    // a key with one row newer and one row older than the caller: the whole Revoke is refused
    const shared = await key();
    const first = devices.pairRelay(devices.startPairing().code, "Old", shared.spki)!.device.id;
    const middle = await member(devices);
    const second = devices.pairRelayApproved("New", shared.spki, { path: "account", addedBy: middle.id })!.device.id;
    const fromMiddle = await remote(f, middle);
    expect((await fromMiddle("DELETE", `/api/devices/${second}`)).status).toBe(403);
    expect(devices.has(first) && devices.has(second)).toBe(true);
  });

  test("T20: every remote grant is refused Revoke all and a verified local caller can do it", async () => {
    const { f, devices } = pc();
    const [oldest] = [await member(devices), await member(devices)];
    const refused = await (await remote(f, oldest))("POST", "/api/devices/revoke-all");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toEqual({ code: "local_required", message: "Revoke all is done at that PC" });
    expect(devices.list(null)).toHaveLength(2);
    expect((await local(f)("POST", "/api/devices/revoke-all")).status).toBe(200);
    expect(devices.list(null)).toHaveLength(0);
  });

  test("T36: signed leave or an older member's authorized remove can commit, with all duplicates checked", async () => {
    const { devices } = pc();
    const [older, target, leaving] = [await member(devices), await member(devices), await member(devices)];
    const remove = (of: string, by: Key) => signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: of, issued_at: new Date().toISOString(), id: newRecordId(), signer: by.spki }, by.keys.privateKey);
    // a newer member signs the remove of an older one: refused, nothing changes
    expect((await applyAccountRecords(devices, [await remove(older.spki, leaving)], SERVER_ID))[0]).toMatchObject({ outcome: "refused", code: "older_device" });
    expect(devices.has(older.id)).toBe(true);
    // an older member's remove of a newer one commits
    expect((await applyAccountRecords(devices, [await remove(target.spki, older)], SERVER_ID))[0]!.outcome).toBe("applied");
    expect(devices.has(target.id)).toBe(false);
    // a signed leave always commits
    expect((await applyAccountRecords(devices, [await remove(leaving.spki, leaving)], SERVER_ID))[0]!.outcome).toBe("applied");
    expect(devices.has(leaving.id)).toBe(false);
    // a key that also has a row older than the signer: the whole remove is refused
    const shared = await key();
    const early = devices.pairRelay(devices.startPairing().code, "Early", shared.spki)!.device.id;
    devices.linkAccountKey(early, shared.spki, shared.spki, ACCOUNT);
    const signer = await member(devices);
    devices.pairRelayApproved("Late", shared.spki, { path: "account", addedBy: signer.id });
    expect((await applyAccountRecords(devices, [await remove(shared.spki, signer)], SERVER_ID))[0]).toMatchObject({ outcome: "refused", code: "older_device" });
    expect(devices.has(early)).toBe(true);
  });

  test("T37: account-joined row Revoke of a newer row grants no signed remove authority", async () => {
    const { f, devices } = pc();
    const [first, caller] = [await member(devices), await member(devices)];
    const added = devices.pairRelayApproved("Added", (await key()).spki, { path: "account", addedBy: first.id })!.device.id;
    // the caller may Revoke the row that joined after it, from afar
    expect((await (await remote(f, caller))("DELETE", `/api/devices/${added}`)).status).toBe(204);
    // and that gives it no right to sign the remove of a key that joined before it
    const remove = await signAccountRecord({ v: 1, kind: "remove", account: ACCOUNT, key: first.spki, issued_at: new Date().toISOString(), id: newRecordId(), signer: caller.spki }, caller.keys.privateKey);
    expect((await applyAccountRecords(devices, [remove], SERVER_ID))[0]).toMatchObject({ outcome: "refused", code: "older_device" });
    expect(devices.has(first.id)).toBe(true);
  });

  test("T20: resetting the relay identity, which ends every relay row, is done at the PC only", async () => {
    const { f, devices } = pc();
    await member(devices);
    const refused = await handleRelayRequest(new Request("http://127.0.0.1/api/relay/reset-identity", { method: "POST", headers: { origin: "http://127.0.0.1", "x-herdr-update": "1" } }), "/api/relay/reset-identity", f.app.context, null, false);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("local_required");
    expect(devices.list(null)).toHaveLength(1);
  });
});


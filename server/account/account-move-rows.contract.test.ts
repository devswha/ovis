import { afterEach, expect, spyOn, test } from "bun:test";
import { accountDeviceId, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { FrameType } from "../../shared/relay-mux.ts";
import { bounded, deferred, relayConnection } from "../relay/test-helpers.ts";
import { FROM, INTO, MERGE, movePc, reopen } from "./account-move.test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ask, phone, type Pc, type Phone } from "./pairing.test-helpers.ts";
import { applyAccountRecords } from "./records.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

async function setup() {
  const fx = await movePc({ memberAge: 2 * 60 * 60_000 });
  pcs.push(fx.pc);
  const serverId = fx.services.relay.currentIdentity()?.server_id;
  if (!serverId) throw new Error("missing PC identity");
  return { ...fx, serverId };
}

test("a member row keeps its pairing, ceases to approve, and still signs in after restart", async () => {
  const { pc, member, serverId, order } = await setup();
  const before = pc.stored().find(row => row.id === member.row.id);
  if (!before) throw new Error("member not on disk");
  expect((await order()).body).toEqual({ state: "moved", account: INTO });
  const after = pc.stored().find(row => row.id === before.id);
  expect(after).toMatchObject({
    id: before.id, role: before.role, token_hash: before.token_hash, relay_public_key: before.relay_public_key,
    origin: before.origin, before_merge: { account: FROM, merge: MERGE, at: expect.any(String) },
  });
  expect([after?.account, after?.linked_at, after?.member_approved_in, after?.account_add, after?.joined_by]).toEqual(Array(5).fill(undefined));
  expect(pc.devices.isAccountApproverSession(before.id, member.key.spki)).toBe(false);
  expect(await pc.status()).toMatchObject({ account: INTO, members: 0, before_merge: [before.id], unlinked: [before.id] });
  expect(await pc.listed()).toEqual([expect.objectContaining({ id: before.id, before_merge: true, account_key: member.key.spki })]);
  const device = { id: before.id, keys: member.key.keys, publicKey: member.key.spki };
  const link = await relayConnection(pc, { serverId });
  await link.auth(device);
  expect((await ask(link, "/api/account/status")).status).toBe(200);
  const add = await signAccountRecord({ v: 1, kind: "add", account: INTO, key: (await phone()).spki,
    issued_at: new Date().toISOString(), id: newRecordId(), signer: member.key.spki, role: "drive", label: "Guest" }, member.key.keys.privateKey);
  expect(await applyAccountRecords(pc.devices, [add], serverId)).toMatchObject([{ outcome: "refused", code: "signer_not_member" }]);
  expect(pc.devices.removeAccountKey(member.key.spki, INTO, { id: newRecordId(), issuedAt: new Date().toISOString() })).toBe(false);
  expect(pc.devices.sessionRow(before.id)).not.toBeNull();
  await pc.app.stop();
  const restart = reopen(pc);
  try {
    expect(restart.context.services.devices.failsClosed).toBe(false);
    const reconnected = await relayConnection({ ...pc, app: restart }, { serverId });
    await reconnected.auth(device);
    expect((await ask(reconnected, "/api/account/status")).body).toMatchObject({ account: INTO });
  } finally { await restart.stop(); }
});

test("a live listed row survives the move and keeps its old remote limits; a held row is not carried", async () => {
  const { pc, services, member, serverId, order } = await setup();
  const live = await phone();
  const held = await phone();
  pc.account.registerDevice(FROM, live.spki, "Live");
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const time = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
  try {
    pc.account.registerDevice(FROM, held.spki, "Held");
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const id = accountDeviceId(serverId, live.spki);
    expect(pc.devices.sessionRow(id)?.key).toBe(live.spki);
    const link = await relayConnection(pc, { serverId });
    await link.auth({ id, keys: live.keys, publicKey: live.spki });
    expect((await order()).body).toEqual({ state: "moved", account: INTO });
    expect(pc.stored().find(row => row.id === id)).toMatchObject({
      relay_public_key: live.spki, before_merge: { account: FROM, merge: MERGE, listed: true },
    });
    expect(pc.stored().find(row => row.relay_public_key === held.spki)).toBeUndefined();
    const all = await ask(link, "/api/devices/revoke-all", { method: "POST", body: {} });
    expect([all.status, all.body.error?.code]).toEqual([403, "local_required"]);
    expect((await ask(link, `/api/devices/${member.row.id}`, { method: "DELETE" })).status).toBe(403);
  } finally { time.mockRestore(); }
});

test("only an old key's own signed remove revokes its old pairing; replay does not apply", async () => {
  const { pc, member, serverId, order } = await setup();
  expect((await order()).status).toBe(200);
  const remove = (signer: Phone) => signAccountRecord({
    v: 1, kind: "remove", account: FROM, key: member.key.spki, issued_at: new Date().toISOString(),
    id: newRecordId(), signer: signer.spki,
  }, signer.keys.privateKey);
  const submit = async (record: Awaited<ReturnType<typeof remove>>) =>
    (await pc.local("/api/account/records", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { records: [record] } })).body.results;
  const other = await remove(await phone());
  expect(await submit(other)).toEqual([{ id: other.id, outcome: "refused", code: "account_mismatch" }]);
  const link = await relayConnection(pc, { serverId });
  await link.auth({ id: member.row.id, keys: member.key.keys, publicKey: member.key.spki });
  const ended = deferred<string>();
  link.onFrame = frame => { if (frame.type === FrameType.SESSION_ERROR) ended.resolve(frame.payload.code); };
  const own = await remove(member.key);
  expect(await submit(own)).toEqual([{ id: own.id, outcome: "applied" }]);
  expect(await bounded(ended.promise)).toBe("auth_revoked");
  expect(pc.devices.isTombstoned(member.key.spki)).toBe(true);
  expect(await submit(own)).toEqual([{ id: own.id, outcome: "refused", code: "account_mismatch" }]);
});

test("linking an ordinary old pairing into the new account drops its mark", async () => {
  const { pc, member, order } = await setup();
  expect((await order()).status).toBe(200);
  const replacement = await phone();
  expect(pc.devices.linkAccountKey(member.row.id, member.key.spki, replacement.spki, INTO)).not.toBeNull();
  const row = pc.stored().find(device => device.id === member.row.id);
  expect(row?.account).toBe(INTO);
  expect(row?.before_merge).toBeUndefined();
});

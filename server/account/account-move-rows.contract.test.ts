import { afterEach, expect, spyOn, test } from "bun:test";
import { accountDeviceId, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { FrameType } from "../../shared/relay-mux.ts";
import { folderTombstones } from "../devices.ts";
import { bounded, deferred, relayConnection } from "../relay/test-helpers.ts";
import { FROM, INTO, MERGE, movePc, reopen } from "./account-move.test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ask, phone, type Pc, type Phone } from "./pairing.test-helpers.ts";
import { applyAccountRecords } from "./records.ts";
import { EXPIRY_DAYS } from "./row-expiry.ts";

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
    const webhook = await ask(link, "/api/alerts/webhook", { method: "POST", body: {} });
    expect([webhook.status, webhook.body.error?.code]).toEqual([403, "member_required"]);
    expect((await ask(link, `/api/devices/${member.row.id}`, { method: "DELETE" })).status).toBe(403);
  } finally { time.mockRestore(); }
});

test("a listed row is retired when the registry already holds its key", async () => {
  const { pc, services, member, serverId } = await setup();
  const listed = await phone();
  const id = accountDeviceId(serverId, listed.spki);
  pc.account.registerDevice(FROM, listed.spki, "Listed");
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const time = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
  try {
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const rows = services.accountRows;
    expect(rows?.access(id)).toEqual({ ok: true });
    const listedRow = rows?.row(id);
    if (!rows || !listedRow) throw new Error("missing listed row");
    expect(listedRow.state).toBe("live");
    // The same key has an ordinary pairing now, but the listed registry still holds its earlier admission.
    const duplicate = spyOn(rows, "rows").mockReturnValueOnce([{ ...listedRow, key: member.key.spki }]);
    try { pc.devices.settleMovedRows({ from: FROM, merge: MERGE, at: new Date().toISOString() }); }
    finally { duplicate.mockRestore(); }
    expect(rows.row(id)).toBeNull();
    expect(pc.stored().filter((row) => row.relay_public_key === member.key.spki)).toEqual([expect.objectContaining({ id: member.row.id })]);
  } finally { time.mockRestore(); }
});

test("carried listed rows expire from their original admission or last sign-in, not from the move", async () => {
  const { pc, services, serverId, order } = await setup();
  const day = 86_400_000;
  const start = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(start);
  try {
    const idle = await phone();
    const recent = await phone();
    const device = (key: Phone) => ({ id: accountDeviceId(serverId, key.spki), keys: key.keys, publicKey: key.spki });
    for (const key of [idle, recent]) pc.account.registerDevice(FROM, key.spki, "Listed");
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    clock.mockReturnValue(start + 30 * day);
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(services.accountRows?.access(device(idle).id)).toEqual({ ok: true });
    const used = await relayConnection(pc, { serverId });
    await used.auth(device(recent));
    expect((await order()).body).toEqual({ state: "moved", account: INTO });
    expect(pc.stored().filter(row => row.before_merge?.listed).map(row => row.id).sort()).toEqual([device(idle).id, device(recent).id].sort());
    clock.mockReturnValue(start + (EXPIRY_DAYS + 1) * day);
    const signIn = async (key: Phone) => {
      const link = await relayConnection(pc, { serverId });
      return bounded(Promise.race([link.auth(device(key)).then(() => true, () => false), link.serverError.then(() => false)]));
    };
    expect(await signIn(recent)).toBe(true);
    expect(await signIn(idle)).toBe(false);
  } finally { clock.mockRestore(); }
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
  expect(folderTombstones(pc.stateDir)).toContainEqual(expect.objectContaining({ key: own.key, account: FROM, records: [own] }));
  expect(await submit(own)).toEqual([{ id: own.id, outcome: "refused", code: "account_mismatch" }]);
});

test("a locked PC refuses a before-merge row's own signed remove", async () => {
  const { pc, services, member, serverId, order } = await setup();
  expect((await order()).status).toBe(200);
  expect(services.safetyLog?.appendLock({ account: INTO })).toMatchObject({ outcome: "applied" });
  const record = await signAccountRecord({ v: 1, kind: "remove", account: FROM, key: member.key.spki,
    issued_at: new Date().toISOString(), id: newRecordId(), signer: member.key.spki }, member.key.keys.privateKey);
  expect(await applyAccountRecords(pc.devices, [record], serverId)).toMatchObject([{ outcome: "refused", code: "signer_not_member" }]);
});

test("a new-account remove keeps its signed evidence without dropping the old pairing", async () => {
  const { pc, member, order } = await setup();
  expect((await order()).status).toBe(200);
  const record = await signAccountRecord({ v: 1, kind: "remove", account: INTO, key: member.key.spki,
    issued_at: new Date().toISOString(), id: newRecordId(), signer: member.key.spki }, member.key.keys.privateKey);
  expect(pc.devices.removeAccountKey(record.key, INTO, { id: record.id, issuedAt: record.issued_at, signed: record })).toBe(true);
  expect(pc.devices.accountRemovals()).toEqual([record]);
  expect(pc.devices.sessionRow(member.row.id)?.key).toBe(member.key.spki);
  expect(pc.devices.linkAccountKey(member.row.id, member.key.spki, member.key.spki, INTO)).toBeNull();
  await pc.app.stop();
  const restart = reopen(pc);
  try {
    expect(restart.context.services.devices.accountRemovals()).toEqual([record]);
    expect(restart.context.services.devices.sessionRow(member.row.id)?.key).toBe(member.key.spki);
  } finally { await restart.stop(); }
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

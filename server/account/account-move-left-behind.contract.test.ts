import { afterEach, expect, spyOn, test } from "bun:test";
import { accountDeviceId } from "../../shared/account-records.ts";
import { bounded, deferred, relayConnection } from "../relay/test-helpers.ts";
import { ask, phone, type Pc } from "./pairing.test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { FROM, HEADERS, INTO, MERGE, filesOf, listForPress, movePc } from "./account-move.test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });
async function setup(options?: Parameters<typeof movePc>[0]) {
  const fx = await movePc({ memberAge: 2 * 60 * 60_000, ...options });
  pcs.push(fx.pc);
  return fx;
}
const press = (pc: Pc) => pc.local("/api/account/one-press", { method: "POST", headers: HEADERS, body: { account: INTO } });

test("a left-behind PC says its account was merged and clears no binding or device rows", async () => {
  const { pc, services } = await setup();
  const paths = ["account-pc.json", "devices.json", "account-devices.json"];
  const before = filesOf(pc.stateDir, paths);
  const binding = PcAccountState.open(pc.stateDir).binding();
  if (!binding) throw new Error("missing binding");
  pc.account.setMergeState?.(MERGE, "finished");
  await services.accountMailbox.pull();
  await services.accountMailbox.readSnapshot();
  await services.accountMailbox.confirmsListing(binding.bind_id);
  expect(await pc.status()).toMatchObject({ account: FROM, account_merged: true });
  expect((await pc.local("/api/health")).body).toMatchObject({ account_merged: true });
  expect(filesOf(pc.stateDir, paths)).toEqual(before);
});

test("a merge first reported by a snapshot appears in account status", async () => {
  let code = "snapshot_gone";
  let refuse = false;
  const { pc, services } = await setup({ accountFetch: (request, fake) =>
    refuse && new URL(request.url).pathname === "/v1/pc/snapshot"
      ? Promise.resolve(Response.json({ error: { code } }, { status: 410 })) : fake.fetch(request) });
  refuse = true;
  const snapshot = () => services.accountMailbox.snapshotPage(FROM, { snapshot: null, page: 0 });
  expect(await snapshot()).toEqual({ snapshot_gone: true });
  code = "account_merged";
  await expect(snapshot()).rejects.toMatchObject({ status: 410, code });
  expect(await pc.status()).toMatchObject({ account: FROM, account_merged: true });
});

test("a delayed snapshot success cannot hide a newer merge refusal", async () => {
  const sent = deferred<void>();
  const release = deferred<void>();
  let delay = false;
  const { pc, services } = await setup({ accountFetch: async (request, fake) => {
    const answer = await fake.fetch(request);
    if (delay && new URL(request.url).pathname === "/v1/pc/snapshot") {
      delay = false;
      sent.resolve();
      await release.promise;
    }
    return answer;
  } });
  delay = true;
  const earlier = services.accountMailbox.snapshotPage(FROM, { snapshot: null, page: 0 });
  try {
    await bounded(sent.promise);
    pc.account.setMergeState(MERGE, "finished");
    expect(await services.accountMailbox.mergedAway(FROM)).toBe(true);
    expect(await pc.status()).toMatchObject({ account_merged: true });
  } finally { release.resolve(); await earlier; }
  expect(await pc.status()).toMatchObject({ account_merged: true });
});

test("a snapshot on the replacement binding does not count as a complete pull", async () => {
  const sent = deferred<void>();
  const release = deferred<void>();
  let delay = false;
  const { pc, services } = await setup({ accountFetch: async (request, fake) => {
    const answer = await fake.fetch(request);
    if (delay && new URL(request.url).pathname === "/v1/pc/mailbox") {
      delay = false;
      sent.resolve();
      await release.promise;
    }
    return answer;
  } });
  await listForPress(pc, INTO);
  expect(await services.accountMailbox.admission(INTO)).toMatchObject({ account: INTO });
  const binding = pc.devices.standingAccountBinding();
  const listing = pc.account.pcs(INTO)[0]?.listing_id;
  if (!binding || !listing) throw new Error("missing binding or listing");
  const unknown = "d".repeat(16);
  services.accountMailbox.askedFirst(unknown, Date.now() - 1);
  delay = true;
  const reading = services.accountMailbox.pull();
  try {
    await bounded(sent.promise);
    pc.devices.settleMovedRows({ from: FROM, merge: MERGE, at: new Date().toISOString() });
    pc.devices.rebindAccount(binding.bind_id, { account: INTO, listing_id: listing, merge: MERGE });
  } finally { release.resolve(); await reading; }
  expect(pc.devices.account()).toBe(INTO);
  expect(services.accountMailbox.unreadKey(unknown)).toBe(true);
  await services.accountMailbox.pull();
  expect(services.accountMailbox.unreadKey(unknown)).toBe(false);
});

test.each([
  [FROM, "account_mismatch"],
  [INTO, "in_account"],
] as const)("one press keeps the original refusal when named for %s and the proved call still succeeds", async (named, code) => {
  const { pc, services } = await setup();
  services.relay.setRelayAccount(named);
  await listForPress(pc, INTO);
  const answer = await press(pc);
  expect([answer.status, answer.body.error?.code, pc.devices.account()]).toEqual([409, code, FROM]);
});

test.each([
  [404, null],
  [429, "try_again"],
  [503, null],
] as const)("a proved mailbox refusal (%s) does not authorize a left-behind press", async (status, code) => {
  let refuse = false;
  const { pc, services } = await setup({ accountFetch: async (request, fake) => refuse && new URL(request.url).pathname === "/v1/pc/mailbox"
    ? Response.json({ error: { code } }, { status }) : fake.fetch(request) });
  pc.account.setMergeState(MERGE, "finished");
  await services.accountMailbox.pull();
  expect(await pc.status()).toMatchObject({ account: FROM, account_merged: true });
  await listForPress(pc, INTO);
  const paths = ["account-pc.json", "devices.json", "account-devices.json"];
  const before = filesOf(pc.stateDir, paths);
  const named = services.relay.savedRelayAccount();
  refuse = true;
  const answer = await press(pc);
  expect([answer.status, answer.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(filesOf(pc.stateDir, paths)).toEqual(before);
  expect(services.relay.savedRelayAccount()).toBe(named);
});

test("a left-behind PC cannot carry listed rows that the merged account no longer lets it check", async () => {
  const { pc, services } = await setup({ memberAge: undefined });
  const serverId = services.relay.currentIdentity()?.server_id;
  if (!serverId) throw new Error("Missing PC identity");
  const lost = await phone();
  const past = spyOn(Date, "now").mockReturnValue(Date.now() - JOIN_HOLD_MS - 1_000);
  try {
    pc.account.registerDevice(FROM, lost.spki, "Lost phone");
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  } finally { past.mockRestore(); }
  const id = accountDeviceId(serverId, lost.spki);
  expect(pc.devices.sessionRow(id)?.key).toBe(lost.spki);
  pc.account.removeDevice(FROM, lost.spki);
  await listForPress(pc, INTO);
  pc.account.setMergeState(MERGE, "finished");
  expect((await press(pc)).status).toBe(200);
  expect(pc.devices.sessionRow(id)).toBeNull();
  expect(pc.stored().find(row => row.id === id)).toBeUndefined();
});

test("when the service says the old account was merged, one press keeps all pairs and moves to the named account", async () => {
  const { pc, services, member } = await setup();
  pc.account.completions = true;
  await listForPress(pc, INTO);
  expect(services.relay.savedRelayAccount()).not.toBe(INTO);
  pc.account.setMergeState?.(MERGE, "finished");
  const before = pc.stored().map(row => row.id);
  const removal: string[] = [];
  pc.devices.onRevoke(member.row.id, () => removal.push(member.row.id));
  const answer = await press(pc);
  expect(answer.status).toBe(200);
  expect(pc.devices.account()).toBe(INTO);
  expect(services.relay.savedRelayAccount()).toBe(INTO);
  expect(pc.stored().map(row => row.id)).toEqual(before);
  expect(pc.stored()).toEqual([expect.objectContaining({ before_merge: { account: FROM, merge: null, at: expect.any(String) } })]);
  expect(pc.devices.isTombstoned(member.key.spki)).toBe(false);
  expect(removal).toEqual([]);
});

test("one press remains local-only for a PC that has been left behind", async () => {
  const { pc, services, member } = await setup();
  pc.account.setMergeState?.(MERGE, "finished");
  const serverId = services.relay.currentIdentity()?.server_id;
  if (!serverId) throw new Error("missing PC relay identity");
  const link = await relayConnection(pc, { serverId });
  await link.auth({ id: member.row.id, publicKey: member.key.spki, keys: member.key.keys });
  const answer = await ask(link, "/api/account/one-press", { method: "POST", body: { account: INTO } });
  expect([answer.status, answer.body.error?.code]).toEqual([403, "owner_only"]);
  expect(pc.devices.account()).toBe(FROM);
});

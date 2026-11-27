import { afterEach, expect, spyOn, test } from "bun:test";
import { accountDeviceId } from "../../shared/account-records.ts";
import { relayConnection } from "../relay/test-helpers.ts";
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

test("one press does not take a PC out of an account whose proved call still succeeds", async () => {
  const { pc } = await setup();
  const answer = await press(pc);
  expect([answer.status, answer.body.error?.code, pc.devices.account()]).toEqual([409, "in_account", FROM]);
});

test.each([
  [404, null, 409, "in_account"],
  [429, "try_again", 503, "account_unavailable"],
  [503, null, 503, "account_unavailable"],
] as const)("a proved mailbox refusal (%s) does not authorize a left-behind press", async (status, code, reply, expected) => {
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
  expect([answer.status, answer.body.error?.code]).toEqual([reply, expected]);
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

import { afterEach, expect, test } from "bun:test";
import { relayConnection } from "../relay/test-helpers.ts";
import { ask, type Pc } from "./pairing.test-helpers.ts";
import { FROM, HEADERS, INTO, MERGE, filesOf, listForPress, movePc } from "./account-move.test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });
async function setup() {
  const fx = await movePc({ memberAge: 2 * 60 * 60_000 });
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

test("when the service says the old account was merged, one press keeps all pairs and moves to the named account", async () => {
  const { pc, services, member } = await setup();
  pc.account.completions = true;
  await listForPress(pc, INTO);
  expect(services.relay.setRelayAccount(INTO)).toBe(true);
  pc.account.setMergeState?.(MERGE, "finished");
  const before = pc.stored().map(row => row.id);
  const removal: string[] = [];
  pc.devices.onRevoke(member.row.id, () => removal.push(member.row.id));
  const answer = await press(pc);
  expect(answer.status).toBe(200);
  expect(pc.devices.account()).toBe(INTO);
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

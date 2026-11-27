import { afterEach, expect, test } from "bun:test";
import { newInvite } from "../../shared/account-list-join.ts";
import { accountRouteAction } from "./account-row-rights.ts";
import { DISPATCH_MUTATIONS } from "../dispatch-routes.ts";
import { relayConnection } from "../relay/test-helpers.ts";
import { ask, phone, type Pc } from "./pairing.test-helpers.ts";
import { ACCOUNT_SERVICE, FROM, INTO, MOVE, movePc } from "./account-move.test-helpers.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });
async function setup(options?: Parameters<typeof movePc>[0]) {
  const fixture = await movePc(options);
  pcs.push(fixture.pc);
  return fixture;
}

test("the PC's own window moves in one request, sees the new status, and can repeat the order", async () => {
  const { pc, order } = await setup();
  expect(await pc.status()).toMatchObject({ account: FROM, account_move: { state: "idle" }, before_merge: [] });
  const first = await order();
  expect(first.status).toBe(200);
  expect(first.body).toEqual({ state: "moved", account: INTO });
  expect((await order()).body).toEqual(first.body);
  expect(await pc.status()).toMatchObject({ account: INTO, account_move: { state: "idle" }, members: 0, before_merge: [] });
});

test.each([
  ["established", 2 * 60 * 60_000, 200, undefined],
  ["ten minutes old", 10 * 60_000, 409, "too_new"],
] as const)("a %s drive member ordering through the relay receives the right answer", async (_kind, memberAge, status, code) => {
  const { pc, services, body, member } = await setup({ memberAge });
  const serverId = services.relay.currentIdentity()?.server_id;
  if (!serverId) throw new Error("missing PC identity");
  const link = await relayConnection(pc, { serverId });
  await link.auth({ id: member.row.id, keys: member.key.keys, publicKey: member.key.spki });
  const answer = await ask(link, MOVE, { method: "POST", body });
  expect([answer.status, answer.body.error?.code]).toEqual([status, code]);
  if (code === "too_new") expect(Number(answer.headers.get("retry-after"))).toBeGreaterThan(0);
  else {
    expect(answer.body).toEqual({ state: "moved", account: INTO });
    expect((await ask(link, "/api/account/status")).body).toMatchObject({ account: INTO });
  }
});

test.each(["unlinked", "before_merge", "watch", "cookie"] as const)("a %s pairing does not authorize an account move", async (kind) => {
  const { pc, services, body } = await setup();
  const key = await phone();
  const headers = { "x-herdr-machine": "1" };
  if (kind === "cookie") {
    const paired = pc.devices.pair(pc.devices.startPairing().code, "Browser", "drive");
    if (!paired) throw new Error("could not pair browser");
    const reply = await pc.local(MOVE, { method: "POST", headers: { ...headers, cookie: `ovis_device=${paired.token}` }, body });
    expect([reply.status, reply.body.error?.code]).toEqual([403, "not_member"]);
    return;
  }
  const paired = pc.devices.pairRelay(pc.devices.startPairing().code, "Phone", key.spki);
  const serverId = services.relay.currentIdentity()?.server_id;
  if (!paired || !serverId) throw new Error("could not pair relay device");
  if (kind === "watch") pc.devices.update(paired.device.id, { role: "watch" });
  if (kind === "before_merge") {
    expect(pc.devices.linkAccountKey(paired.device.id, key.spki, key.spki, FROM)).not.toBeNull();
    expect((await pc.local(MOVE, { method: "POST", headers, body })).status).toBe(200);
  }
  const link = await relayConnection(pc, { serverId });
  await link.auth({ id: paired.device.id, keys: key.keys, publicKey: key.spki });
  const reply = await ask(link, MOVE, { method: "POST", body });
  expect([reply.status, reply.body.error?.code]).toEqual([403, kind === "watch" ? "read_only" : "not_member"]);
});

test.each([
  ["not_in_account", 409, false, true, {}],
  ["other_account", 409, true, true, { from: "another" }],
  ["invalid_move", 400, true, true, { merge_id: "-" + "a".repeat(64) }],
  ["not_found", 404, false, false, {}],
] as const)("the account move route refuses %s", async (code, status, bound, accountOpensAll, change) => {
  const { order } = await setup({ bound, server: { accountOpensAll } });
  const answer = await order(change);
  expect([answer.status, answer.body.error?.code]).toEqual([status, code]);
});

test("an invite for another service is refused without returning the secret", async () => {
  const { order } = await setup();
  const { line } = await newInvite("https://other.test", INTO, null);
  const answer = await order({ invite: line });
  expect([answer.status, answer.body.error?.code]).toEqual([409, "invite_invalid"]);
  expect(JSON.stringify(answer.body)).not.toContain(line);
});

test("a list on the invite refuses the move even from the PC's own window", async () => {
  const { order } = await setup();
  const { line } = await newInvite(ACCOUNT_SERVICE, INTO, "a".repeat(64));
  const answer = await order({ invite: line });
  expect([answer.status, answer.body.error?.code]).toEqual([409, "list_account"]);
});

test("the move route is registered for a live account session", () => {
  expect(DISPATCH_MUTATIONS.POST).toContain(MOVE);
  expect(accountRouteAction("POST", MOVE)).toEqual({ action: "move_account" });
});

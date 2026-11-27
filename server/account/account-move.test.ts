import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { accountDeviceId, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { privateStateFs } from "../private-state.ts";
import { bounded, deferred, TestClock } from "../relay/test-helpers.ts";
import { ACCOUNT_SERVICE, FROM, INTO, JOURNAL, LISTING, MERGE, filesOf, movePc } from "./account-move.test-helpers.ts";
import { DeviceJournal } from "./device-journal.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { phone, type Pc } from "./pairing.test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });
async function setup(options?: Parameters<typeof movePc>[0]) {
  const fixture = await movePc(options);
  pcs.push(fixture.pc);
  return { ...fixture, path: join(fixture.pc.stateDir, JOURNAL) };
}
const route = (request: Request) => new URL(request.url).pathname;

test("the journal is already private and complete when the transfer challenge is asked", async () => {
  let check: (() => void) | undefined;
  const fx = await setup({ accountFetch: async (req, fake) => {
    if (check && route(req) === "/v1/pc/challenge" && Object.hasOwn(await req.clone().json(), "transfer")) {
      const inspect = check; check = undefined; inspect();
    }
    return fake.fetch(req);
  } });
  let observed: unknown;
  let mode: number | undefined;
  check = () => { observed = JSON.parse(readFileSync(fx.path, "utf8")); mode = statSync(fx.path).mode & 0o777; };
  expect((await fx.order()).status).toBe(200);
  expect(observed).toEqual({ v: 1, merge_id: MERGE, from: { account: FROM, bind_id: expect.stringMatching(/^[0-9a-f]{32}$/) },
    server_id: fx.services.relay.currentIdentity()?.server_id, into: INTO, invite: fx.body.invite, by: "pc",
    started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  if (process.platform !== "win32") expect(mode).toBe(0o600);
  expect(existsSync(fx.path)).toBe(false);
});

test.each(["try_again", "directory_full", "list_account"])("a final transfer refusal preserves %s", async code => {
  const fx = await setup({ accountFetch: async (req, fake) => route(req) === "/v1/pc/transfer"
    ? Response.json({ error: { code } }, { status: 409 }) : fake.fetch(req) });
  const answer = await fx.order();
  expect([answer.status, answer.body.error?.code]).toEqual([409, code]);
});

test.each(["mailbox", "snapshot"])("a failed old-account %s read refuses a new move without writing intent", async path => {
  let broken = false;
  const fx = await setup({ accountFetch: async (req, fake) => broken && route(req) === `/v1/pc/${path}`
    ? new Response(null, { status: 503 }) : fake.fetch(req) });
  const before = filesOf(fx.pc.stateDir, ["account-pc.json"]);
  broken = true;
  const answer = await fx.order();
  expect([answer.status, answer.body.error?.code]).toEqual([503, "account_unavailable"]);
  expect(existsSync(fx.path)).toBe(false);
  expect(filesOf(fx.pc.stateDir, ["account-pc.json"])).toEqual(before);
});

test("a move reads the old account's uncollected removals before carrying listed devices", async () => {
  const { pc, services, order } = await setup();
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
  expect((await order()).status).toBe(200);
  expect(pc.devices.sessionRow(id)).toBeNull();
  expect(pc.stored().find(row => row.id === id)).toBeUndefined();
});

test("a confirmed transfer saves the pairings before the binding, then the relay name before unlinking the journal", async () => {
  const fx = await setup({ memberAge: 2 * 60 * 60_000 });
  const pair = await phone();
  fx.pc.account.registerDevice(FROM, pair.spki, "Listed");
  expect(await fx.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const time = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
  const expected = ["devices.json", "account-devices.json", "account-pc.json", "account.json", JOURNAL];
  const writes: string[] = [];
  const rename = privateStateFs.renameSync;
  const unlink = privateStateFs.unlinkSync;
  const saved = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    rename(from, to);
    const name = basename(String(to));
    if (name !== JOURNAL && existsSync(fx.path) && expected.includes(name) && !writes.includes(JOURNAL)) writes.push(name);
  });
  const removed = spyOn(privateStateFs, "unlinkSync").mockImplementation(path => {
    unlink(path);
    if (path === fx.path) writes.push(JOURNAL);
  });
  try {
    expect(await fx.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const id = fx.services.relay.currentIdentity()?.server_id;
    if (!id) throw new Error("missing test PC identity");
    expect(fx.pc.devices.sessionRow(accountDeviceId(id, pair.spki))?.key).toBe(pair.spki);
    writes.length = 0;
    expect((await fx.order()).body).toEqual({ state: "moved", account: INTO });
    expect(writes).toEqual(expected);
  } finally { removed.mockRestore(); saved.mockRestore(); time.mockRestore(); }
});

test("the same merge joins one in-flight transfer and a different merge is refused", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let transfers = 0;
  const fx = await setup({ accountFetch: async (req, fake) => {
    if (route(req) === "/v1/pc/transfer") { transfers++; entered.resolve(); await release.promise; }
    return fake.fetch(req);
  } });
  const first = fx.order();
  try {
    await bounded(Promise.race([entered.promise, first.then(reply => { throw new Error(`No transfer: ${reply.status}`); })]));
    const repeated = fx.order();
    const different = await fx.order({ merge_id: "merge_different" });
    expect([different.status, different.body.error?.code]).toEqual([409, "move_in_progress"]);
    release.resolve();
    expect((await first).body).toEqual({ state: "moved", account: INTO });
    expect((await repeated).body).toEqual({ state: "moved", account: INTO });
    expect(transfers).toBe(1);
  } finally { release.resolve(); }
});

test.each([FROM, INTO] as const)("a refused transfer settles according to whereami (%s), not the refusal alone", async (account) => {
  const fx = await setup({ memberAge: 2 * 60 * 60_000, accountFetch: async (req, fake) => {
    if (route(req) === "/v1/pc/transfer") {
      if (account === INTO) expect((await fake.fetch(req)).ok).toBe(true);
      return Response.json({ error: { code: "invite_invalid" } }, { status: 409 });
    }
    if (route(req) === "/v1/pc/whereami" && account === FROM) return Response.json({ account, listing_id: LISTING, merge: "open" });
    return fake.fetch(req);
  } });
  const paths = ["account-pc.json", "devices.json"];
  const before = filesOf(fx.pc.stateDir, paths);
  const answer = await fx.order();
  if (account === FROM) {
    expect([answer.status, answer.body.error?.code]).toEqual([409, "invite_invalid"]);
    expect(filesOf(fx.pc.stateDir, paths)).toEqual(before);
  } else expect(answer.body).toEqual({ state: "moved", account: INTO });
  expect(fx.pc.devices.account()).toBe(account);
  expect(existsSync(fx.path)).toBe(false);
});

test("an unanswered transfer holds unlisting, and a cancelled ticket lifts the guard", async () => {
  let confirmed = false;
  const fx = await setup({ memberAge: 2 * 60 * 60_000, accountFetch: async (req, fake) => {
    if (route(req) === "/v1/pc/transfer") return new Response(null, { status: 503 });
    if (route(req) === "/v1/pc/whereami" && confirmed) return Response.json({ account: FROM, listing_id: LISTING, merge: "cancelled" });
    return fake.fetch(req);
  } });
  const pending = await fx.order();
  expect([pending.status, pending.headers.get("retry-after"), pending.body]).toEqual([202, "5", { state: "pending" }]);
  expect(existsSync(fx.path)).toBe(true);
  expect(fx.pc.devices.clearAccountBinding("unlisted", "account")).toBe(false);
  const before = PcAccountState.open(fx.pc.stateDir).binding()?.bind_id;
  if (!before) throw new Error("guard allowed the standing binding to end");
  expect(await fx.services.accountMailbox.readSnapshot()).toMatchObject({ committed: false, reason: "unconfirmed" });
  confirmed = true;
  fx.services.accountMove?.resume();
  await fx.services.accountMove?.idle();
  expect(existsSync(fx.path)).toBe(false);
  expect(fx.pc.devices.account()).toBe(FROM);
  expect(fx.pc.devices.clearAccountBinding("unlisted", "account")).toBe(true);
});

test("Revoke all wins over a pending move", async () => {
  const fx = await setup({ accountFetch: async (req, fake) => route(req) === "/v1/pc/transfer" ? new Response(null, { status: 503 }) : fake.fetch(req) });
  expect((await fx.order()).status).toBe(202);
  fx.pc.devices.revokeAll();
  fx.services.accountMove?.resume();
  await fx.services.accountMove?.idle();
  expect(fx.pc.devices.account()).toBeNull();
  expect(existsSync(fx.path)).toBe(false);
});

test("move admission age uses the injected clock", async () => {
  const fx = await setup({ memberAge: 2 * 60 * 60_000 });
  const { AccountMove } = await import("./account-move.ts");
  const clock = new TestClock();
  clock.advance(Date.parse(fx.member.row.created_at) + 30 * 60_000);
  const { devices, relay, accountMailbox, accountHolds, safetyLog } = fx.services;
  const mover = AccountMove.open({ stateDir: fx.pc.stateDir, sibling: null, devices, relay, mailbox: accountMailbox, holds: accountHolds, safety: safetyLog, clock });
  try {
    expect(await mover.order({ ...fx.body, by: fx.member.row.id, callerKey: fx.member.key.spki })).toMatchObject({
      refused: { code: "too_new", retryAfter: 1800 },
    });
    expect(existsSync(fx.path)).toBe(false);
  } finally { mover.stop(); }
});

test("an unreadable journal is set aside and reported once without stopping mailbox pulls", async () => {
  const fx = await setup();
  writeFileSync(fx.path, "{", { mode: 0o600 });
  expect(await fx.services.accountMailbox.freshen()).toBe(true);
  expect(await fx.pc.status()).toMatchObject({ account_move: { state: "refuses", code: "journal_unreadable" } });
  expect(await fx.pc.status()).toMatchObject({ account_move: { state: "idle" } });
  expect(existsSync(fx.path)).toBe(false);
  const [quarantined, ...others] = readdirSync(fx.pc.stateDir).filter(name => name.startsWith(`${JOURNAL}.corrupt-`));
  if (quarantined === undefined) throw new Error("No quarantined move journal");
  expect(others).toEqual([]);
  expect(readFileSync(join(fx.pc.stateDir, quarantined), "utf8")).toBe("{");
  expect(DeviceJournal.open(fx.pc.stateDir).entries()).toContainEqual(expect.objectContaining({ kind: "account", how: "journal_unreadable" }));
});

test.each(["corrupt", "pending"] as const)("a %s journal cannot hold a signed mailbox remove", async journal => {
  const fx = await setup({ memberAge: 2 * 60 * 60_000,
    accountFetch: (req, fake) => route(req) === "/v1/pc/transfer" ? Promise.resolve(new Response(null, { status: 503 })) : fake.fetch(req) });
  if (journal === "corrupt") writeFileSync(fx.path, "{", { mode: 0o600 });
  else expect((await fx.order()).status).toBe(202);
  const serverId = fx.services.relay.currentIdentity()?.server_id;
  if (!serverId) throw new Error("Missing PC identity");
  const { key, row } = fx.member;
  const remove = await signAccountRecord({ v: 1, kind: "remove", account: FROM, key: key.spki,
    issued_at: new Date().toISOString(), id: newRecordId(), signer: key.spki }, key.keys.privateKey);
  const queued = await fx.pc.account.fetch(new Request(`${ACCOUNT_SERVICE}/v1/records`, { method: "POST",
    headers: { authorization: `Bearer ${fx.pc.account.issueToken(FROM)}` },
    body: JSON.stringify({ server_ids: [serverId], record: remove }) }));
  expect(queued.ok).toBe(true);
  await fx.services.accountMailbox.pull();
  expect(fx.pc.devices.sessionRow(row.id)).toBeNull();
  expect(fx.pc.devices.accountRemovals()).toEqual([remove]);
});

test("a move whose transfer did not answer retries after five seconds on its own", async () => {
  let online = false;
  const fx = await setup({ accountFetch: async (req, fake) => route(req) === "/v1/pc/transfer" && !online ? new Response(null, { status: 429 }) : fake.fetch(req) });
  const { AccountMove } = await import("./account-move.ts");
  const clock = new TestClock();
  const { devices, relay, accountMailbox, accountHolds, safetyLog } = fx.services;
  const mover = AccountMove.open({ stateDir: fx.pc.stateDir, sibling: null, devices, relay, mailbox: accountMailbox, holds: accountHolds, safety: safetyLog, clock });
  try {
    expect(await mover.order({ ...fx.body, by: "pc" })).toEqual({ state: "pending" });
    online = true;
    clock.advance(4_999);
    await mover.idle();
    expect(devices.account()).toBe(FROM);
    clock.advance(1);
    await mover.idle();
    expect(devices.account()).toBe(INTO);
    expect(existsSync(fx.path)).toBe(false);
  } finally { mover.stop(); }
});

test("a retry still runs after a transiently unreadable journal could not be quarantined", async () => {
  let online = false;
  const fx = await setup({ accountFetch: async (req, fake) => route(req) === "/v1/pc/transfer" && !online ? new Response(null, { status: 429 }) : fake.fetch(req) });
  const { AccountMove } = await import("./account-move.ts");
  const clock = new TestClock();
  const { devices, relay, accountMailbox, accountHolds, safetyLog } = fx.services;
  const mover = AccountMove.open({ stateDir: fx.pc.stateDir, sibling: null, devices, relay, mailbox: accountMailbox, holds: accountHolds, safety: safetyLog, clock });
  try {
    expect(await mover.order({ ...fx.body, by: "pc" })).toEqual({ state: "pending" });
    const saved = readFileSync(fx.path);
    writeFileSync(fx.path, "{");
    const rename = privateStateFs.renameSync;
    const fault = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
      if (from === fx.path) throw Object.assign(new Error("Sharing violation"), { code: "EBUSY" });
      return rename(from, to);
    });
    try { clock.advance(5_000); await mover.idle(); } finally { fault.mockRestore(); }
    writeFileSync(fx.path, saved);
    online = true;
    clock.advance(15_000);
    await mover.idle();
    expect(devices.account()).toBe(INTO);
  } finally { mover.stop(); }
});

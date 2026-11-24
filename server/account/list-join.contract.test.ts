/**
 * A PC is added to an account that keeps a signed list (docs/account.md, "A PC is added to the list"): a person at the
 * PC and the phone that adds it see one number, the person says so at the PC, and the PC joins by the list alone,
 * pinned from its first moment. The account service's word adds it nowhere.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryToText, readBody } from "../../shared/account-list-entry.ts";
import { readJoinLine, type JoinLine } from "../../shared/account-list-join.ts";
import { openWrap, wrapEpochKey, wrapFromText, wrapToText } from "../../shared/account-list-seal.ts";
import { cardHolds, inviteRefusal, joinEntry } from "../../shared/account-list.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { fromBase64Url } from "../../shared/relay-pair-sas.ts";
import { listMember, TestList, type ListMember } from "./list.test-helpers.ts";
import { ask, ended, pairingPc, signedInWith, vouchFor, type Body, type Pc } from "./pairing.test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";

const ACCOUNT = "acct_1";
const OTHER = "acct_2";
const TOKEN = "list-join-token";
/** This PC's own window: the access token from loopback, no proxy (dispatch.ts ownWindow). */
const own = { authorization: `Bearer ${TOKEN}` };

const pcs: Pc[] = [];
const keptDirs: string[] = [];
afterEach(async () => {
  for (const pc of pcs.splice(0)) await pc.close();
  for (const dir of keptDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Hook = (request: Request, forward: () => Promise<Response>) => Promise<Response>;

/** A PC in no account, named for ACCOUNT and listed in it by a sign-in, as `ovis add` leaves it before anybody presses Add. */
async function listedPc() {
  const hook: { on: Hook | null } = { on: null };
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux", token: TOKEN, accountListAddPollMs: 0 }, startRelay: false,
    accountFetch: (request, service) => hook.on ? hook.on(request, () => service.fetch(request)) : service.fetch(request) });
  made.account.opensAll = true;
  made.account.listAccounts = "*";
  made.account.completions = true;
  pcs.push(made);
  const post = (path: string, body: unknown = {}, header = "x-herdr-machine") => made.local(path, { method: "POST", headers: { ...own, [header]: "1" }, body });
  if ((await post("/api/relay/start", undefined, "x-herdr-update")).status !== 200) throw new Error("The relay did not start");
  const { services } = made.app.context;
  const identity = services.relay.currentIdentity()!;
  const endpoint = bytesToHex(importPublicKey(identity.public_key));
  if ((await post("/api/account/relay-account", { account: ACCOUNT })).status !== 204) throw new Error("The account was not named");
  const directory = (account: string, path: string, method: string) => made.account.fetch(new Request(`https://account.test${path}`, { method,
    headers: { authorization: `Bearer ${made.account.issueToken(account, { twoStep: true })}` },
    body: JSON.stringify(method === "PUT" ? { label: "PC", public_key: endpoint, relay: "wss://relay.ovis.sh" } : {}) }));
  const listIn = async (account: string) => { if (!(await directory(account, `/v1/pcs/${identity.server_id}`, "PUT")).ok) throw new Error("The PC was not listed"); };
  await listIn(ACCOUNT);
  return {
    pc: made, services, serverId: identity.server_id, endpoint, hook, post, listIn,
    /** A device of the account presses Add: the account admits this PC (the phone does it before it places the entry). */
    admit: async (account = ACCOUNT) => { if (!(await directory(account, `/v1/pcs/${identity.server_id}/admit`, "POST")).ok) throw new Error("The PC was not admitted"); },
    start: () => post("/api/account/list/add", { account: ACCOUNT }),
    state: async () => (await made.local("/api/account/list/add", { headers: own })).body,
    status: async () => (await made.local("/api/account/status", { headers: own })).body,
    confirm: async (digits: unknown) => post("/api/account/list/add/confirm", { digits }),
    binding: () => (JSON.parse(readFileSync(join(made.stateDir, "account-pc.json"), "utf8")) as { binding: Record<string, unknown> | null }).binding,
  };
}

type Listed = Awaited<ReturnType<typeof listedPc>>;

/** The number as both sides come to it: the phone commits, the PC answers, the phone reveals, the PC shows it. */
async function compared(made: Listed, account: TestList, adder = account.first): Promise<{ phone: string; shown: Body }> {
  const number = await account.compare(made.endpoint, adder);
  await number.commit();
  // the PC takes the commitment and answers with its nonce
  expect(await made.state()).toMatchObject({ state: "waiting" });
  const phone = await number.reveal();
  if (phone === null) throw new Error("The PC did not answer the commitment");
  return { phone, shown: await made.state() };
}

describe("a PC in no account is added to an account that keeps a signed list", () => {
  test("the phone and the PC show one number, the person says so at the PC, and the PC joins by the list, pinned from its first moment", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    expect((await made.start()).body).toEqual({ state: "waiting", run: expect.stringMatching(/^[0-9a-f]{16}$/), account: ACCOUNT, list: account.id, until: expect.any(String) });
    expect((await made.status()).waiting_for_add).toBe(true);
    const { phone, shown } = await compared(made, account);
    expect(shown).toEqual({ state: "number", run: expect.any(String), account: ACCOUNT, list: account.id, digits: phone, until: expect.any(String) });
    expect((await made.confirm(phone)).body).toMatchObject({ state: "confirmed" });
    // the phone's Add: the account admits the PC, then the entry
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toEqual({ state: "added", run: expect.any(String), account: ACCOUNT, list: account.id });
    expect(made.pc.devices.account()).toBe(ACCOUNT);
    // bound by the list: no binding on the service's word ever stood, and the pin is in the binding itself
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
    expect(made.binding()).not.toHaveProperty("service");
    expect(made.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in", list: account.id });
    expect(made.pc.devices.listFollowed()).toBe(true);
    expect((await made.status()).waiting_for_add).toBe(false);
    // the account's page stops showing the PC as only listed
    expect(made.pc.account.requests.some((line) => line.includes("/v1/pc/complete"))).toBe(true);
  });

  test("a device the list holds opens the PC at once, and one only the account service names does not", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const phone = await listMember();
    await account.addDevice(phone);
    await made.start();
    const number = await compared(made, account);
    await made.confirm(number.phone);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "added" });
    await made.services.accountList!.settled();
    expect(made.services.accountRows!.rows().map((row) => row.key).sort()).toEqual([account.first.key, phone.key].sort());
    // what the account service says from then on moves nothing: a snapshot that names another device, and one that lists this PC no more
    const stranger = await listMember();
    made.pc.account.registerDevice(ACCOUNT, stranger.key, "Stranger");
    await made.services.accountMailbox.pull();
    await made.services.accountList!.settled();
    expect(made.services.accountRows!.rows().map((row) => row.key).sort()).toEqual([account.first.key, phone.key].sort());
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
    // a member removes a device: it goes at the next read
    await account.remove(phone.key);
    await made.services.accountMailbox.pull();
    await made.services.accountList!.settled();
    expect(made.services.accountRows!.rows().map((row) => row.key)).toEqual([account.first.key]);
  });

  test("after a restart with the account service away, the PC is still in the account by its list and holds the list's devices", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const phone = await listMember();
    await account.addDevice(phone);
    await made.start();
    await made.confirm((await compared(made, account)).phone);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "added" });
    await made.services.accountList!.settled();
    // what the PC keeps on disk, as it stood when it stopped
    const kept = mkdtempSync(join(tmpdir(), "ovis-list-join-"));
    keptDirs.push(kept);
    // its files only: the socket it listens on for recovery is no state
    cpSync(made.pc.stateDir, kept, { recursive: true, filter: (path) => !statSync(path).isSocket() });
    await made.pc.close();
    pcs.splice(pcs.indexOf(made.pc), 1);
    // the same state, and an account service that answers nothing
    const again = await pairingPc({ server: { accountOpensAll: true, platform: "linux", token: TOKEN }, startRelay: false,
      prepare: (dir) => cpSync(kept, dir, { recursive: true }), accountFetch: async () => { throw new Error("The account service is away"); } });
    pcs.push(again);
    const { services } = again.app.context;
    await services.accountList!.settled();
    expect(again.devices.account()).toBe(ACCOUNT);
    expect(again.devices.listFollowed()).toBe(true);
    expect(services.accountList!.status()).toMatchObject({ pinned: true, standing: "in", list: account.id });
    expect(services.accountRows!.rows().map((row) => row.key).sort()).toEqual([account.first.key, phone.key].sort());
  });

  test("only an entry the device whose number was confirmed signed adds the PC: another member's entry joins nothing", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const other = await listMember();
    await account.addDevice(other);
    await made.start();
    // the person compared with the account's first device, and said yes to that number
    const { phone } = await compared(made, account);
    expect((await made.confirm(phone)).body).toMatchObject({ state: "confirmed" });
    // another device of the account signs the PC in
    await made.admit();
    await account.addPostedPc(made.endpoint, other);
    expect(await made.state()).toMatchObject({ state: "ended", why: "other_adder" });
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
  });

  test("a poll that names its run learns nothing of the run that replaced it", async () => {
    const made = await listedPc();
    await TestList.start(made.pc.account, ACCOUNT);
    const started = (await made.start()).body as { run: string };
    expect((await made.pc.local(`/api/account/list/add?run=${started.run}`, { headers: own })).body).toMatchObject({ state: "waiting", run: started.run });
    expect((await made.pc.local(`/api/account/list/add?run=${"0".repeat(16)}`, { headers: own })).body).toEqual({ state: "replaced" });
    expect((await made.post("/api/account/list/add/cancel", { run: "0".repeat(16) })).body).toEqual({ state: "replaced" });
    expect((await made.pc.local(`/api/account/list/add?run=x`, { headers: own })).status).toBe(400);
    expect((await made.post("/api/account/list/add/cancel", { run: started.run })).body).toMatchObject({ state: "ended", why: "cancelled" });
  });

  test("without the person's yes at the PC nothing is joined, whatever the list then holds", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    const { phone } = await compared(made, account);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "number", digits: phone });
    expect(made.pc.devices.account()).toBeNull();
    // and the account service's word adds it nowhere: an account with a list takes a PC by the list alone
    const pressed = await made.post("/api/account/one-press", { account: ACCOUNT });
    expect([pressed.status, pressed.body.error?.code]).toEqual([409, "list_add"]);
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
  });

  test("a yes to another number than the one on the screen confirms nothing", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    const { phone } = await compared(made, account);
    const other = phone === "000000" ? "000001" : "000000";
    expect((await made.confirm(12)).status).toBe(400);
    // a wrong number ends that number, and the answer names none
    const wrong = await made.confirm(other);
    expect([wrong.status, wrong.body.error?.code]).toEqual([409, "wrong_number"]);
    expect(JSON.stringify(wrong.body)).not.toContain(phone);
    // the right one confirms nothing any more: the device has to ask again
    expect((await made.confirm(phone)).status).toBe(409);
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "waiting" });
    expect(made.pc.devices.account()).toBeNull();
  });

  test("a No at the PC ends the add: the entry a member then places joins nothing", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    await compared(made, account);
    expect((await made.post("/api/account/list/add/cancel")).body).toMatchObject({ state: "ended", account: ACCOUNT, why: "cancelled" });
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "ended", account: ACCOUNT, why: "cancelled" });
    expect(made.pc.devices.account()).toBeNull();
  });

  test("a service that names a list of its own shows the PC a number the phone never shows, and its entry joins nothing", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    // the lie: another list, which the service made with a key of its own, named to this PC as its account's
    const lie = await TestList.start(made.pc.account, OTHER);
    await made.listIn(OTHER);
    made.hook.on = async (request, forward) => {
      const answer = await forward();
      if (new URL(request.url).pathname !== "/v2/pc/list" || !answer.ok) return answer;
      return Response.json({ ...await answer.json() as object, list: lie.id });
    };
    expect((await made.start()).body).toMatchObject({ state: "waiting", list: lie.id });
    // the phone of the account finds no card of this PC on its own list: it has no number to show
    await expect(account.compare(made.endpoint)).rejects.toThrow("The PC posted no keys");
    const forged = await compared(made, lie);
    expect(forged.shown).toMatchObject({ state: "number", digits: forged.phone });
    // nobody at the PC says yes to a number no phone shows; the service's own entry is there all the same
    await made.admit(OTHER);
    await lie.addPostedPc(made.endpoint);
    expect(await made.state()).toMatchObject({ state: "number" });
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
  });

  test("a yes to a list that is another account's joins nothing", async () => {
    const made = await listedPc();
    await TestList.start(made.pc.account, ACCOUNT);
    const lie = await TestList.start(made.pc.account, OTHER);
    await made.listIn(OTHER);
    made.hook.on = async (request, forward) => {
      const answer = await forward();
      if (new URL(request.url).pathname !== "/v2/pc/list" || !answer.ok) return answer;
      return Response.json({ ...await answer.json() as object, list: lie.id });
    };
    await made.start();
    const forged = await compared(made, lie);
    await made.confirm(forged.phone);
    await made.admit(OTHER);
    await lie.addPostedPc(made.endpoint);
    const ended = await made.state();
    expect(ended.state).not.toBe("added");
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
  });
});

/** `ovis join` up to the account service's listing: the PC redeems the invite of the line on its own proof, as the command does. */
async function redeemed(made: Listed, invite: { line: string }) {
  const line = await readJoinLine(invite.line, { service: "https://account.test", followsLists: true });
  const proof = (await made.post("/api/account/pc-proof")).body as { challenge_id: string; proof: string };
  const signature = await line.signRedeem({ server_id: made.serverId, public_key: made.endpoint, challenge_id: proof.challenge_id });
  const answer = await made.pc.account.fetch(new Request("https://account.test/v1/pc-invites/redeem", { method: "POST", body: JSON.stringify({
    invite_key: line.key, invite_signature: signature, server_id: made.serverId, public_key: made.endpoint, relay: "wss://relay.ovis.sh", label: "PC", challenge_id: proof.challenge_id, proof: proof.proof }) }));
  if (!answer.ok) throw new Error(`The invite was not redeemed: ${answer.status} ${await answer.text()}`);
  return line;
}

/** The command's side of a join the PC makes by itself: it asks where the list stands, has the PC build the body, signs it with the line, and has it placed. */
async function joinsByItself(made: Listed, list: string, line: JoinLine, change: { entry?: (text: string) => string } = {}) {
  const scope = { account: ACCOUNT, list, invite: line.key };
  const prepared = await made.post("/api/account/list/join/prepare", scope);
  if (prepared.body.state !== "prepared") return prepared;
  const { seq, enc, seal, wraps } = prepared.body as unknown as { seq: number; enc: string; seal: { epoch: number; opens: string } | null; wraps: { epoch: number; wrap: string }[] };
  // the names' key, which only the line opens, wrapped again for the PC
  const held = seal === null ? undefined : wraps.find((wrap) => wrap.epoch === seal.epoch);
  const opened = seal === null || held === undefined ? null : await openWrap({ list, epoch: seal.epoch, commitment: seal.opens, wrap: wrapFromText(held.wrap), member: { key: line.key, privateKey: line.encryptionKey } });
  const own = opened !== null && opened.open ? await wrapEpochKey({ list, epoch: opened.value, member: enc }) : null;
  const built = await made.post("/api/account/list/join/body", { ...scope, seq });
  if (built.body.state !== "body") return built;
  const entry = entryToText(await line.signJoin(readBody(fromBase64Url(built.body.body as string))));
  return await made.post("/api/account/list/join/place", { ...scope, entry: change.entry?.(entry) ?? entry, ...(own === null ? {} : { wraps: [{ epoch: seal!.epoch, member: enc, wrap: wrapToText(own) }] }) });
}

describe("a PC joins a signed list with the line of an invite (ovis join)", () => {
  test("a plain invite: the PC posts its card, a device of the account adds it, and the PC joins by the list the line names", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await redeemed(made, await account.invite({ auto: false }));
    const waiting = await made.post("/api/account/list/join", { account: ACCOUNT, list: account.id });
    expect(waiting.body).toEqual({ state: "waiting", standing: "waiting" });
    expect(made.pc.devices.account()).toBeNull();
    // a device chooses Add on the card of the PC that joined with its invite
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect((await made.post("/api/account/list/join", { account: ACCOUNT, list: account.id })).body).toEqual({ state: "added", account: ACCOUNT });
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
    expect(made.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
    expect(made.pc.account.accountList(ACCOUNT)!.state.pcs[made.endpoint]).toMatchObject({ how: "added" });
  });

  test("an invite for one PC to join by itself: the PC builds its join, the line signs it, the PC places it and joins, with nobody else awake", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const phone = await listMember();
    await account.addDevice(phone);
    const invite = await account.invite({ auto: true });
    const line = await redeemed(made, invite);
    const joined = await joinsByItself(made, account.id, line);
    expect(joined.body).toEqual({ state: "added", account: ACCOUNT });
    const held = made.pc.account.accountList(ACCOUNT)!;
    expect(held.state.pcs[made.endpoint]).toMatchObject({ how: "joined", invite: invite.key, removed: null });
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
    expect(made.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
    // the devices of the list open it, and the names' key came with the join
    expect(made.services.accountRows!.rows().map((row) => row.key).sort()).toEqual([account.first.key, phone.key].sort());
    expect(held.wraps.some((wrap) => wrap.member === held.state.pcs[made.endpoint]!.enc)).toBe(true);
    // a machine that joined by itself is no signer: it lets nobody into the list
    expect(made.services.accountList!.canAllow()).toBe(false);
    expect(made.services.accountList!.allowRefusal()).toBe("not_signer");
  });

  test("the PC places only the join it built itself", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const line = await redeemed(made, await account.invite({ auto: true }));
    const placed = made.pc.account.accountList(ACCOUNT)!.head.seq;
    // another join the line would sign too: this PC's relay key with a key of somebody else's choosing
    const stranger = await listMember();
    const state = made.pc.account.accountList(ACCOUNT)!.state;
    const other = await joinEntry(line, { key: stranger.key, privateKey: stranger.keys.privateKey, enc: stranger.enc, endpoint: made.endpoint }, state, Math.floor(Date.now() / 1000), null);
    const refused = await joinsByItself(made, account.id, line, { entry: () => other.text });
    expect([refused.status, refused.body.error?.code]).toEqual([409, "not_written"]);
    expect(made.pc.account.accountList(ACCOUNT)!.head.seq).toBe(placed);
    expect(made.pc.devices.account()).toBeNull();
  });

  test("a PC joins by itself only with an invite made for one PC, and never with one a person adds a PC with", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    for (const [options, code] of [[{ auto: true, uses: 2 }, "invite_uses"], [{ auto: false }, "invite_plain"]] as const) {
      const invite = await account.invite(options);
      const line = await readJoinLine(invite.line, { service: "https://account.test", followsLists: true });
      const refused = await made.post("/api/account/list/join/prepare", { account: ACCOUNT, list: account.id, invite: line.key });
      expect([refused.status, refused.body.error?.code]).toEqual([409, code]);
    }
    const unknown = await listMember();
    const refused = await made.post("/api/account/list/join/prepare", { account: ACCOUNT, list: account.id, invite: unknown.key });
    expect([refused.status, refused.body.error?.code]).toEqual([409, "invite_unknown"]);
    expect(made.pc.devices.account()).toBeNull();
  });

  test("an invite that was used lets no second PC in", async () => {
    const first = await listedPc();
    const account = await TestList.start(first.pc.account, ACCOUNT);
    const invite = await account.invite({ auto: true });
    expect((await joinsByItself(first, account.id, await redeemed(first, invite))).body).toMatchObject({ state: "added" });
    // the list holds the join: every member counts the invite as spent
    const line = await readJoinLine(invite.line, { service: "https://account.test", followsLists: true });
    expect(inviteRefusal(first.pc.account.accountList(ACCOUNT)!.state, line.key)).toBe("invite_spent");
  });

  test("the list moved between the body and the placement: the PC is told to prepare again, and then joins", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const line = await redeemed(made, await account.invite({ auto: true }));
    const scope = { account: ACCOUNT, list: account.id, invite: line.key };
    const prepared = await made.post("/api/account/list/join/prepare", scope);
    const built = await made.post("/api/account/list/join/body", { ...scope, seq: (prepared.body as { seq?: number }).seq });
    const entry = entryToText(await line.signJoin(readBody(fromBase64Url(built.body.body as string))));
    // a member writes meanwhile
    await account.addDevice(await listMember());
    expect((await made.post("/api/account/list/join/place", { ...scope, entry })).body).toEqual({ state: "again" });
    expect(made.pc.devices.account()).toBeNull();
    account.refresh();
    expect((await joinsByItself(made, account.id, line)).body).toEqual({ state: "added", account: ACCOUNT });
  });

  test("the join routes are this PC's own window's alone, and name the account this PC was set up for", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    for (const path of ["/api/account/list/join", "/api/account/list/join/prepare", "/api/account/list/join/body", "/api/account/list/join/place"]) {
      const base = `http://127.0.0.1:${made.pc.app.port}`;
      const answer = await fetch(`${base}${path}`, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-herdr-machine": "1", "x-forwarded-for": "100.64.0.9", ...own }, body: JSON.stringify({ account: ACCOUNT, list: account.id }) });
      expect(answer.status).toBe(403);
    }
    const other = await made.post("/api/account/list/join", { account: OTHER, list: account.id });
    expect([other.status, other.body.error?.code]).toEqual([409, "account_mismatch"]);
  });
});

describe("a device that scans the PC's QR code names the list over that pairing, in the place of its link", () => {
  /** The device of the account that scans: it pairs with the code made for the account, and its account vouches for its key. */
  async function scanned(made: Listed, device: ListMember, options: { vouch?: boolean; account?: string } = {}) {
    const code = made.pc.devices.startAccountPairing(options.account ?? ACCOUNT).code;
    const key = { keys: device.keys, spki: device.key };
    if (options.vouch !== false) await vouchFor(made.pc, options.account ?? ACCOUNT, key);
    const paired = await signedInWith(made.pc, code, key, { serverId: made.serverId });
    return { ...paired, names: (list: string, account = ACCOUNT) => ask(paired.session, "/api/account/list/named", { method: "POST", body: { account, list } }) };
  }

  test("the PC hands its card over the pairing, the device signs it in, and the PC joins by that list, pinned", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const phone = await scanned(made, account.first);
    const waiting = await phone.names(account.id);
    expect([waiting.status, waiting.body.state]).toEqual([200, "waiting"]);
    // the card came over the pairing the QR code made, and is this PC's own for that list
    const { key, enc, card } = waiting.body as unknown as { key: string; enc: string; card: string };
    expect(await cardHolds({ key, enc, list: account.id, endpoint: made.endpoint, invite: null }, card)).toBe(true);
    expect(made.pc.account.accountList(ACCOUNT)!.posts.map((post) => [post.endpoint, post.key])).toEqual([[made.endpoint, key]]);
    expect(made.pc.devices.account()).toBeNull();
    await made.admit();
    await account.addPostedPc(made.endpoint);
    expect((await phone.names(account.id)).body).toEqual({ state: "added", account: ACCOUNT });
    expect(made.binding()).toMatchObject({ account: ACCOUNT, list: account.id });
    expect(made.binding()).not.toHaveProperty("service");
    expect(made.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
    // no member was written by the pairing: the devices are the list's
    expect(made.pc.stored()).toEqual([]);
    expect(made.services.accountRows!.rows().map((row) => row.key)).toEqual([account.first.key]);
  });

  test("an entry another key signed joins nothing: the PC is added by the device that scanned it", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const other = await listMember();
    await account.addDevice(other);
    const phone = await scanned(made, account.first);
    await phone.names(account.id);
    await made.admit();
    await account.addPostedPc(made.endpoint, other);
    const refused = await phone.names(account.id);
    expect([refused.status, refused.body.error?.code]).toEqual([409, "other_adder"]);
    expect(made.pc.devices.account()).toBeNull();
  });

  test("a device its account does not vouch for names nothing, and goes", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const phone = await scanned(made, account.first, { vouch: false });
    const refused = await phone.names(account.id);
    expect([refused.status, refused.body.error?.code]).toEqual([403, "unverified_device"]);
    // turned away, as a link its account does not vouch for is: its session ends
    expect(await ended(phone.session)).toBe("auth_revoked");
    expect(made.pc.account.accountList(ACCOUNT)!.posts).toEqual([]);
    expect(made.pc.devices.account()).toBeNull();
  });

  test("a list of another account, another account than the code's, and a second list from one device are refused", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    const theirs = await TestList.start(made.pc.account, OTHER);
    const phone = await scanned(made, account.first);
    // the code was made for ACCOUNT: a device that names another account is turned away as its link would be
    const other = await scanned(await listedPc(), account.first);
    const mismatch = await other.names(theirs.id, OTHER);
    expect([mismatch.status, mismatch.body.error?.code]).toEqual([409, "account_mismatch"]);
    // a list that is not ACCOUNT's own, named as if it were: nothing of it is taken
    expect((await phone.names(theirs.id)).body.state).toBe("waiting");
    await made.listIn(OTHER);
    await made.admit(OTHER);
    await theirs.addPostedPc(made.endpoint).catch(() => undefined);
    expect((await phone.names(theirs.id)).body.state).not.toBe("added");
    const second = await phone.names(account.id);
    expect([second.status, second.body.error?.code]).toEqual([409, "pairing_ended"]);
    expect(made.pc.devices.account()).toBeNull();
    expect(made.binding()).toBeNull();
  });

  test("only a device that waits to link names a list: a device this PC already holds does not", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    // paired with a code of this PC's own, as `ovis pair` makes one
    const { code } = made.pc.devices.startPairing();
    const paired = await signedInWith(made.pc, code, undefined, { serverId: made.serverId });
    const refused = await ask(paired.session, "/api/account/list/named", { method: "POST", body: { account: ACCOUNT, list: account.id } });
    expect(refused.status).toBe(403);
    expect(made.pc.devices.account()).toBeNull();
  });
});

describe("what stays as it was", () => {
  test("an account with no list takes the PC in one press, and the add by the list says there is none", async () => {
    const made = await listedPc();
    expect((await made.start()).body).toEqual({ state: "no_list", account: ACCOUNT });
    expect((await made.status()).waiting_for_add).toBe(false);
    await made.admit();
    const pressed = await made.post("/api/account/one-press", { account: ACCOUNT });
    expect([pressed.status, pressed.body.account]).toEqual([200, ACCOUNT]);
    expect(made.binding()).toMatchObject({ account: ACCOUNT, service: true });
    expect(made.binding()).not.toHaveProperty("list");
  });

  test("a PC already in an account, and one named for another account, start no add", async () => {
    const made = await listedPc();
    await TestList.start(made.pc.account, ACCOUNT);
    const other = await made.post("/api/account/list/add", { account: OTHER });
    expect([other.status, other.body.error?.code]).toEqual([409, "account_mismatch"]);
    expect((await made.post("/api/account/list/add", {})).status).toBe(400);
  });

  test("the number is shown to this PC's own window alone", async () => {
    const made = await listedPc();
    const account = await TestList.start(made.pc.account, ACCOUNT);
    await made.start();
    await compared(made, account);
    // the access token from another origin's page, or with no token at all
    for (const path of ["/api/account/list/add"]) {
      const answer = await fetch(`http://127.0.0.1:${made.pc.app.port}${path}`, { headers: { "x-forwarded-for": "100.64.0.9", ...own } });
      expect(answer.status).toBe(403);
      expect(JSON.stringify(await answer.json())).not.toMatch(/[0-9]{6}/);
    }
  });

  test("a Revoke all that ends while one press still asks whether the account keeps a list makes that press bind nothing", async () => {
    const made = await listedPc();
    await made.admit();
    // the owner revokes every device while the PC's first question to the account service is out
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname === "/v2/pc/list") PcAccountState.open(made.pc.stateDir).raiseGen();
      return await forward();
    };
    const pressed = await made.post("/api/account/one-press", { account: ACCOUNT });
    expect([pressed.status, pressed.body.error?.code]).toEqual([409, "revoked"]);
    expect(made.pc.devices.account()).toBeNull();
  });

  test("an account that made its list a moment ago takes no PC in one press: the service refuses the take, and the PC forgets that it had none", async () => {
    const made = await listedPc();
    // the PC heard that the account keeps no list
    expect((await made.start()).body).toEqual({ state: "no_list", account: ACCOUNT });
    await made.admit();
    // the account makes its list, and the service refuses the take of an admission for it
    const account = await TestList.start(made.pc.account, ACCOUNT);
    made.hook.on = async (request, forward) => new URL(request.url).pathname === "/v1/pc/admission"
      ? Response.json({ error: { code: "list_add", message: "This account keeps a signed list" } }, { status: 409 }) : await forward();
    const pressed = await made.post("/api/account/one-press", { account: ACCOUNT });
    expect([pressed.status, pressed.body.error?.code]).toEqual([409, "list_add"]);
    expect(made.pc.devices.account()).toBeNull();
    // and the next ask goes by the list, with no half minute of the old answer in between
    made.hook.on = null;
    expect((await made.start()).body).toMatchObject({ state: "waiting", list: account.id });
  });

  test("while the account service does not answer, one press binds nothing", async () => {
    const made = await listedPc();
    await TestList.start(made.pc.account, ACCOUNT);
    await made.admit();
    made.hook.on = async (request, forward) => new URL(request.url).pathname === "/v2/pc/list" ? new Response("away", { status: 503 }) : await forward();
    const pressed = await made.post("/api/account/one-press", { account: ACCOUNT });
    expect([pressed.status, pressed.body.error?.code]).toEqual([503, "account_unavailable"]);
    expect(made.pc.devices.account()).toBeNull();
  });
});

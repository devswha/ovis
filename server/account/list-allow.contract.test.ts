/**
 * A PC lets a new device into its account's signed list (docs/account.md, "A PC allows a device into the list"): a
 * person at the PC compares the digits in its own window, or types them at `ovis approve`, and the PC signs the entry
 * that lets the device in with its own list key. A PC that follows no list, and a join that brings no card, are let in
 * as before.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { entryFromText, entryHash, readBody } from "../../shared/account-list-entry.ts";
import { openSealed, openWrap, wrapFromText } from "../../shared/account-list-seal.ts";
import { readKind, readNames } from "../../shared/account-list.ts";
import { accountDeviceId } from "../../shared/account-records.ts";
import { channelBinding, importPublicKey } from "../../shared/relay-e2ee.ts";
import { ACCOUNT_LIST_ALLOW, ACCOUNT_LIST_FEATURE, FrameType, PAIR_INTENT_ACCOUNT, PAIR_SAS_FEATURE, type MuxFrame } from "../../shared/relay-mux.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import { bounded, deferred, relayConnection } from "../relay/test-helpers.ts";
import { claimKey, listMember, memberCard, TestList, type ListMember } from "./list.test-helpers.ts";
import { ask, pairingPc, vouchFor, type Pc } from "./pairing.test-helpers.ts";

const ACCOUNT = "acct_1";
const TOKEN = "list-allow-token";
/** This PC's own window: the access token from loopback, no proxy (dispatch.ts ownWindow). */
const own = { authorization: `Bearer ${TOKEN}` };

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

type Hook = (request: Request, forward: () => Promise<Response>) => Promise<Response>;

/** A PC added to the account in one press, with no member in its devices.json: a join is decided in its own window. */
async function boundPc() {
  const hook: { on: Hook | null } = { on: null };
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux", token: TOKEN }, startRelay: false,
    accountFetch: (request, service) => hook.on ? hook.on(request, () => service.fetch(request)) : service.fetch(request) });
  made.account.opensAll = true;
  made.account.listAccounts = "*";
  pcs.push(made);
  const local = (path: string, body: unknown, header: string) => made.local(path, { method: "POST", headers: { ...own, [header]: "1" }, body });
  if ((await local("/api/relay/start", undefined, "x-herdr-update")).status !== 200) throw new Error("The relay did not start");
  const { services } = made.app.context;
  const identity = services.relay.currentIdentity()!;
  const endpoint = bytesToHex(importPublicKey(identity.public_key));
  if ((await local("/api/account/relay-account", { account: ACCOUNT }, "x-herdr-machine")).status !== 204) throw new Error("The account was not named");
  const token = made.account.issueToken(ACCOUNT, { twoStep: true });
  const call = (path: string, method: string) => made.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(method === "PUT" ? { label: "PC", public_key: endpoint, relay: "wss://relay.ovis.sh" } : {}) }));
  await call(`/v1/pcs/${identity.server_id}`, "PUT");
  await call(`/v1/pcs/${identity.server_id}/admit`, "POST");
  const pressed = await local("/api/account/one-press", { account: ACCOUNT }, "x-herdr-machine");
  if (pressed.status !== 200) throw new Error(`The PC was not added: ${pressed.status} ${JSON.stringify(pressed.body)}`);
  const list = services.accountList!;
  const pull = async () => { await services.accountMailbox.pull(); await list.settled(); };
  return { pc: made, services, serverId: identity.server_id, endpoint, list, pull, hook };
}

/** The same PC, pinned to the account's list as a PC a person added: its own key signs for the list. */
async function allowingPc() {
  const made = await boundPc();
  const account = await TestList.start(made.pc.account, ACCOUNT);
  await made.pull();
  expect(await made.list.wantList(account.id)).toMatchObject({ status: { pinned: false } });
  await account.addPostedPc(made.endpoint);
  await made.pull();
  expect(made.list.status()).toMatchObject({ pinned: true, standing: "in" });
  const ownKey = made.pc.account.accountList(ACCOUNT)!.state.pcs[made.endpoint]!.key!;
  return { ...made, account, ownKey };
}

type Bound = Awaited<ReturnType<typeof boundPc>>;

/** The new device's join: its admission, then PAIR_REQUEST with the account intent, with its card where it says so. */
async function join(made: Bound, device: ListMember, options: { card?: { enc: string; card: string }; features?: readonly string[] } = {}) {
  await vouchFor(made.pc, ACCOUNT, { keys: device.keys, spki: device.key });
  const link = await relayConnection(made.pc, { serverId: made.serverId });
  const frames: MuxFrame[] = [];
  let heard: (() => void) | undefined;
  link.onFrame = (frame) => { frames.push(frame); heard?.(); };
  const next = async (type: number): Promise<MuxFrame> => {
    for (;;) {
      const index = frames.findIndex((frame) => frame.type === type || frame.type === FrameType.SESSION_ERROR);
      if (index >= 0) return frames.splice(index, 1)[0]!;
      const arrived = deferred<void>();
      heard = arrived.resolve;
      await bounded(arrived.promise, 30_000);
    }
  };
  await link.hello(options.features ?? [PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT, ACCOUNT_LIST_ALLOW]);
  // the answer to this HELLO, not the WELCOME with no feature that rides ahead of it
  const welcome = await next(FrameType.WELCOME);
  if (welcome.type !== FrameType.WELCOME) throw new Error(`The HELLO was refused: ${JSON.stringify(welcome.payload)}`);
  const binding = channelBinding(link.channel);
  if (!binding) throw new Error("No channel binding");
  const nonce = randomPairNonce();
  link.mux.sendSession({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: {
    label: "Android · Chrome", public_key: device.key, commitment: toBase64Url(pairCommitment(binding, device.key, nonce)),
    ...(options.card ? { list_enc: options.card.enc, list_card: options.card.card } : {}),
  } });
  const challenge = await next(FrameType.PAIR_CHALLENGE);
  if (challenge.type !== FrameType.PAIR_CHALLENGE) throw new Error(`The join was refused: ${JSON.stringify(challenge.payload)}`);
  link.mux.sendSession({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  const digits = pairDigits(binding, device.key, nonce, fromBase64Url(challenge.payload.nonce));
  return { link, next, digits, features: welcome.payload.features };
}

async function ownJoin(made: Bound): Promise<{ id: string; digits?: string }> {
  const approvals = made.services.relay.approvals;
  const found = deferred<void>();
  const stop = approvals.subscribe(() => { if (approvals.ownJoins().length > 0) found.resolve(); });
  if (approvals.ownJoins().length > 0) found.resolve();
  await bounded(found.promise).finally(stop);
  const base = `http://127.0.0.1:${made.pc.app.port}`;
  const listed = await (await fetch(`${base}/api/relay/joins`, { headers: own })).json() as { joins: { id: string; digits?: string }[] };
  return listed.joins[0]!;
}

async function decide(made: Bound, body: unknown): Promise<number> {
  const base = `http://127.0.0.1:${made.pc.app.port}`;
  return (await fetch(`${base}/api/relay/join`, { method: "POST", headers: { origin: base, "x-herdr-update": "1", "content-type": "application/json", ...own }, body: JSON.stringify(body) })).status;
}

/** The whole Allow as a person does it: the device asks with its card, the PC's own window allows, the device confirms. */
async function allowed(made: Bound, device: ListMember, card: { enc: string; card: string }) {
  const asked = await join(made, device, { card });
  const waiting = await ownJoin(made);
  expect(waiting.digits).toBe(asked.digits);
  expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
  asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
  return { ...asked, answer: await asked.next(FrameType.AUTH_OK) };
}

const entriesPlaced = (made: Bound) => made.pc.account.requests.filter((line) => line.includes("/v2/pc/list/entries")).length;

describe("a PC that a person added lets a new device into the list from its own window", () => {
  test("it signs the device's entry with its own key, the service places it, and the device is in the list and on this PC", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const { answer, features, link } = await allowed(made, phone, { enc: phone.enc, card });
    expect(features).toContain(ACCOUNT_LIST_ALLOW);
    if (answer.type !== FrameType.AUTH_OK) throw new Error(`The device was not let in: ${JSON.stringify(answer.payload)}`);

    // the list holds the entry, signed by this PC's key, and the service's word had no part in who signed
    const held = made.pc.account.accountList(ACCOUNT)!;
    expect(held.state.signers[phone.key]).toMatchObject({ as: "device", power: "full", ended: null, by: made.ownKey });
    expect(held.state.devices[phone.key]).toMatchObject({ role: "drive", until: null, enc: phone.enc });
    const seq = held.state.signers[phone.key]!.seq;
    const entry = entryFromText(held.entries[seq]!);
    expect(readBody(entry.body).signer).toBe(made.ownKey);

    // the device is told the list and the place of its entry over the session whose digits were compared
    expect(answer.payload).toMatchObject({ role: "drive", device_id: accountDeviceId(made.serverId, phone.key), list: { id: made.account.id, seq, hash: entryHash(entry.body) } });
    // it is a device of the list here, not a pairing of this PC's own, with no join hold
    expect(made.pc.devices.hasKey(phone.key)).toBe(false);
    expect(made.services.accountRows!.rows().map((row) => [row.key, row.state])).toContainEqual([phone.key, "live"]);
    expect(made.list.status()).toMatchObject({ devices: 2, head: { seq } });
    // the session of the join told the device where it is in the list, and serves nothing else: its key was sent with
    // the comparison, never signed with here
    expect((await ask(link, "/api/preferences")).status).toBe(403);
    // it signs in with its list key, as any device of the list, and that session is its own
    const again = await relayConnection(made.pc, { serverId: made.serverId });
    expect(await again.auth({ keys: phone.keys, publicKey: phone.key, id: accountDeviceId(made.serverId, phone.key) }, [ACCOUNT_LIST_FEATURE], [ACCOUNT_LIST_FEATURE])).toMatchObject({ role: "drive" });
    expect((await ask(again, "/api/preferences")).status).toBe(200);
  });

  test("the device's name is sealed under the list's key, and the device is given that key", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    await allowed(made, phone, { enc: phone.enc, card });
    const held = made.pc.account.accountList(ACCOUNT)!;
    const seq = held.state.signers[phone.key]!.seq;
    const kind = readKind(readBody(entryFromText(held.entries[seq]!).body));
    if (kind?.kind !== "device" || kind.sealed === null) throw new Error("The entry carries no names");
    // the wrap the PC sent with the entry opens with the device's own key, to the key the list committed to
    const wrap = held.wraps.find((item) => item.member === phone.enc && item.epoch === 0);
    const opened = await openWrap({ list: made.account.id, epoch: 0, commitment: held.state.epochs[0]!.opens, wrap: wrap ? wrapFromText(wrap.wrap) : null, member: phone.encKey });
    if (!opened.open) throw new Error(`The device cannot open its wrap: ${opened.why}`);
    expect(bytesToHex(opened.value.key)).toBe(bytesToHex(made.account.epochKey.key));
    const names = await openSealed({ place: { list: made.account.id, seq }, epoch: opened.value, sealed: kind.sealed.bytes });
    if (!names.open) throw new Error(`The names do not open: ${names.why}`);
    expect(readNames(names.value)).toEqual({ label: "Android · Chrome", os: null });
    // no log line and no answer of the PC named the device
    expect(JSON.stringify(made.list.status())).not.toContain("Android");
  });

  test("the digits typed at `ovis approve` do the same", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const asked = await join(made, phone, { card: { enc: phone.enc, card } });
    const waiting = await ownJoin(made);
    expect(await decide(made, { id: waiting.id, digits: asked.digits })).toBe(200);
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    expect(await asked.next(FrameType.AUTH_OK)).toMatchObject({ type: FrameType.AUTH_OK });
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toMatchObject({ as: "device", by: made.ownKey });
  });

  test("nothing is signed before both people said the digits match", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const asked = await join(made, phone, { card: { enc: phone.enc, card } });
    const waiting = await ownJoin(made);
    expect(await decide(made, { id: waiting.id, decision: "decline" })).toBe(200);
    expect((await asked.next(FrameType.AUTH_OK)).type).toBe(FrameType.SESSION_ERROR);
    expect(entriesPlaced(made)).toBe(0);
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
  });
});

describe("what the PC does when the entry does not go in", () => {
  /** A join the person allowed that the PC did not let in: the device hears what a refused join always heard. */
  async function refused(made: Awaited<ReturnType<typeof allowingPc>>, phone: ListMember, card: { enc: string; card: string }) {
    const before = made.pc.account.accountList(ACCOUNT)!.head;
    const { answer } = await allowed(made, phone, card);
    expect(answer.type === FrameType.SESSION_ERROR && answer.payload.code).toBe("auth_failed");
    // nothing was written in its place: no entry, no device of the list, no pairing of this PC's own
    expect(made.pc.account.accountList(ACCOUNT)!.head).toEqual(before);
    expect(made.pc.devices.hasKey(phone.key)).toBe(false);
    expect(made.services.accountRows!.rows().some((row) => row.key === phone.key)).toBe(false);
  }

  test("a device whose key no sign-in of the account claimed is not let in: the service's lock holds, and the PC asks once", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    await refused(made, phone, { enc: phone.enc, card: await memberCard(phone, made.account.id) });
    expect(entriesPlaced(made)).toBe(1);
  });

  test("a card that is not this key's for this list is never signed over, and the service is not asked", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const other = await listMember();
    // another device's card, and this device's card for another list
    await refused(made, phone, { enc: phone.enc, card: await memberCard(other, made.account.id) });
    await refused(made, phone, { enc: phone.enc, card: await memberCard(phone, "ab".repeat(32)) });
    expect(entriesPlaced(made)).toBe(0);
  });

  test("a head that moved under it is read, and the entry signed again on the new head", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    let raced = false;
    made.hook.on = async (request, forward) => {
      if (!raced && new URL(request.url).pathname === "/v2/pc/list/entries") {
        raced = true;
        // a member lets another device in just before this PC's entry arrives
        await made.account.addDevice(await listMember());
      }
      return await forward();
    };
    const { answer } = await allowed(made, phone, { enc: phone.enc, card });
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK });
    expect(entriesPlaced(made)).toBe(2);
    const held = made.pc.account.accountList(ACCOUNT)!;
    expect(held.state.signers[phone.key]).toMatchObject({ as: "device", by: made.ownKey, seq: held.head.seq });
    expect(made.list.status()).toMatchObject({ devices: 3 });
  });

  test("a head that keeps moving ends the tries: the device is not let in, and nothing is written", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    made.pc.account.tamperList(made.account.id, { headMoved: true });
    await refused(made, phone, { enc: phone.enc, card });
    expect(entriesPlaced(made)).toBe(4);
  });

  test("a service that is reading the list again is sent the same entry again, and then takes it", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const sent: string[] = [];
    made.pc.account.tamperList(made.account.id, { rebuilding: true });
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname !== "/v2/pc/list/entries") return await forward();
      sent.push(JSON.stringify((await request.clone().json() as { entries: string[] }).entries));
      const answer = await forward();
      made.pc.account.untamperList(made.account.id);
      return answer;
    };
    const { answer } = await allowed(made, phone, { enc: phone.enc, card });
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]!);
  });

  test("a service that changes the list for nobody ends it at once", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    made.pc.account.tamperList(made.account.id, { stopped: true });
    await refused(made, phone, { enc: phone.enc, card });
    expect(entriesPlaced(made)).toBe(1);
    // what the PC holds is as it was: its own devices still get in
    expect(made.list.status()).toMatchObject({ pinned: true, standing: "in" });
  });

  test("an answer that is lost is no refusal: the log says the entry is in, and the device is let in", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    let lost = false;
    made.hook.on = async (request, forward) => {
      const answer = await forward();
      if (!lost && new URL(request.url).pathname === "/v2/pc/list/entries") { lost = true; throw new Error("The answer was lost"); }
      return answer;
    };
    const { answer } = await allowed(made, phone, { enc: phone.enc, card });
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK });
    expect(entriesPlaced(made)).toBe(1);
  });

  test("a key this PC itself keeps out is signed for by nobody here", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    made.pc.devices.removeAccountKey(phone.key, ACCOUNT, { id: "a".repeat(32), issuedAt: new Date().toISOString() });
    await refused(made, phone, { enc: phone.enc, card });
    expect(entriesPlaced(made)).toBe(0);
  });
});

describe("a PC that cannot sign for a list lets a device in as before", () => {
  test("a PC that follows no list does not take a card: the join makes its own pairing, and no list is named", async () => {
    const made = await boundPc();
    const phone = await listMember();
    const asked = await join(made, phone, { card: { enc: phone.enc, card: await memberCard(phone, "ab".repeat(32)) } });
    expect(asked.features).not.toContain(ACCOUNT_LIST_ALLOW);
    const waiting = await ownJoin(made);
    expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    const answer = await asked.next(FrameType.AUTH_OK);
    if (answer.type !== FrameType.AUTH_OK) throw new Error("The device was not let in");
    expect(answer.payload).not.toHaveProperty("list");
    expect(made.pc.devices.hasKey(phone.key)).toBe(true);
    expect(made.pc.account.requests.some((line) => line.includes("/v2/pc/list/entries"))).toBe(false);
  });

  test("on a pinned PC a join that brings no card is the PC's own pairing, as before", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const asked = await join(made, phone, { features: [PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT] });
    const waiting = await ownJoin(made);
    expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    const answer = await asked.next(FrameType.AUTH_OK);
    if (answer.type !== FrameType.AUTH_OK) throw new Error("The device was not let in");
    expect(answer.payload).not.toHaveProperty("list");
    expect(made.pc.devices.hasKey(phone.key)).toBe(true);
    expect(entriesPlaced(made)).toBe(0);
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
  });

  test("a PC on which an alarm stands takes no card: it lets nobody new into the list", async () => {
    const made = await allowingPc();
    expect(made.list.allowRefusal()).toBeNull();
    // the first device signs a second history from entry 0, and the service shows it to this PC
    const other = await listMember();
    const forked = await made.account.sign({ kind: "device", key: other.key, power: "full", role: "drive", until: null, enc: other.enc,
      card: await memberCard(other, made.account.id), sealed: null, rotates: false }, made.account.first, { seq: 0, hash: made.account.id });
    made.pc.account.tamperList(made.account.id, { reader: { server_id: made.serverId }, fork: [forked] });
    await made.pull();
    made.list.tick();
    await made.list.settled();
    expect(made.list.status().alarm).toBe("fork");
    expect(made.list.allowRefusal()).toBe("alarm");
    const phone = await listMember();
    const asked = await join(made, phone, { card: { enc: phone.enc, card: await memberCard(phone, made.account.id) } });
    expect(asked.features).not.toContain(ACCOUNT_LIST_ALLOW);
  });

  test("a PC the list removed is in no list, and says so before any card is sent", async () => {
    const made = await allowingPc();
    await made.account.remove(made.ownKey);
    await made.pull();
    expect(made.list.allowRefusal()).toBe("not_pinned");
    expect(made.list.canAllow()).toBe(false);
  });
});

describe("a join a member allowed from afar", () => {
  test("is let in only when an entry of the list lets the device in: this PC signs nothing for it", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await memberCard(phone, made.account.id);
    expect(await made.list.allowDevice({ key: phone.key, enc: phone.enc, card, label: "Phone" }, false)).toEqual({ refused: "not_in_list", detail: null });
    expect(entriesPlaced(made)).toBe(0);
    // the member signs and places the entry itself; this PC reads it, and lets the device in
    await made.account.addDevice(phone);
    const outcome = await made.list.allowDevice({ key: phone.key, enc: phone.enc, card, label: "Phone" }, false);
    expect(outcome).toEqual({ allowed: { id: made.account.id, ...made.account.place } });
    expect(entriesPlaced(made)).toBe(0);
    expect(made.services.accountRows!.rows().map((row) => [row.key, row.state])).toContainEqual([phone.key, "live"]);
  });
});

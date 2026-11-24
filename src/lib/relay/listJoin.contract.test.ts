/**
 * A new device joins its account through a PC that is pinned to the account's signed list (docs/account.md, "A PC
 * allows a device into the list"), end to end between the two: the app's own channel (shared/relay-channel.ts) on one
 * side, a real PC with its account, its relay session, its own window's approval and its copy of the list on the
 * other, and the account service in memory.
 */
import { afterEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { claimKey, listMember, memberCard, TestList, type ListMember } from "../../../server/account/list.test-helpers.ts";
import { pairingPc, vouchFor, type Pc } from "../../../server/account/pairing.test-helpers.ts";
import { RelaySession } from "../../../server/relay/session.ts";
import { bounded, deferred } from "../../../server/relay/test-helpers.ts";
import { entryFromText, entryHash } from "../../../shared/account-list-entry.ts";
import { accountDeviceId } from "../../../shared/account-records.ts";
import { ListMismatchError, type RelayChannelOptions } from "../../../shared/relay-channel.ts";
import { exportPublicKey, generateKeyPair, importPublicKey, openDaemonSecureChannel, type Transport } from "../../../shared/relay-e2ee.ts";
import { ACCOUNT_LIST_ALLOW, ACCOUNT_LIST_FEATURE, MuxProtocolError } from "../../../shared/relay-mux.ts";
import { accountDevice, withAccountDevice } from "../account/accountDevice.ts";
import { openRelayChannel, type RelaySocket } from "./channel.ts";
import { MemoryDeviceStore } from "./device.test.ts";
import { failureOf } from "./shellState.ts";

const ACCOUNT = "acct_1";
const TOKEN = "list-join-token";
/** The PC's own window: the access token from loopback, no proxy. */
const own = { authorization: `Bearer ${TOKEN}` };

const pcs: Pc[] = [];
const closes: (() => void)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) close();
  for (const pc of pcs.splice(0)) await pc.close();
});

/** The carrier between the app's channel and the PC's session: what one sends, the other hears. */
class Carrier implements RelaySocket {
  binaryType: BinaryType = "arraybuffer";
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  closed = false;
  get readyState(): number { return this.closed ? 3 : 1; }
  constructor(readonly daemon: Transport) {}
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.closed) throw new Error("Socket closed");
    if (typeof data !== "string" && !(data instanceof ArrayBuffer)) throw new Error("Unexpected carrier type");
    this.daemon.onmessage?.({ data, isBinary: typeof data !== "string" });
  }
  deliver(data: string | ArrayBuffer): void {
    if (!this.closed) this.onmessage?.(new MessageEvent("message", { data }));
  }
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.daemon.onclose?.(code, reason);
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

/** A PC a person added to the account and to its list, pinned to that list: its own key signs for it. */
async function pinnedPc() {
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux", token: TOKEN }, startRelay: false });
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
  const pull = async (): Promise<void> => { await services.accountMailbox.pull(); await list.settled(); };
  const account = await TestList.start(made.account, ACCOUNT);
  await pull();
  await list.wantList(account.id);
  await account.addPostedPc(endpoint);
  await pull();
  expect(list.status()).toMatchObject({ pinned: true, standing: "in" });

  const serverId = identity.server_id;
  const e2ee = generateKeyPair();
  const offer = { v: 1 as const, server_id: serverId, server_public_key: exportPublicKey(e2ee.publicKey), relay: "wss://relay.example" };
  /** The app opens a channel to the PC, as shell.tsx does for a join or for a sign-in. */
  const open = (options: Omit<RelayChannelOptions, "socket">) => {
    let session: RelaySession | undefined;
    let carrier: Carrier;
    const daemon: Transport = {
      onmessage: null, onclose: null, onerror: null,
      send: (data) => carrier.deliver(data),
      // as on a WebSocket, the PC's close reaches the phone in a later task than the frames it sent first
      close: (code, reason) => { setImmediate(() => carrier.close(code, reason)); },
    };
    carrier = new Carrier(daemon);
    closes.push(() => carrier.close());
    const early: (string | ArrayBuffer)[] = [];
    void openDaemonSecureChannel(daemon, { daemonKeyPair: e2ee, events: { onmessage: (data) => { if (session) session.receive(data); else early.push(data); } } }).then((channel) => {
      session = new RelaySession({ channel, services, port: made.app.port, serverId, serverVersion: "0.4.20", minSupportedClient: "0.4.20", routingOverhead: 0, maxWireMessageBytes: 64 * 1024 });
      for (const data of early.splice(0)) session.receive(data);
    }, () => {});
    const opening = openRelayChannel(offer, { ...options, socket: () => { queueMicrotask(() => carrier.deliver(JSON.stringify({ type: "assigned", connection_id: "ab".repeat(16) }))); return carrier; } });
    void opening.catch(() => {});
    return opening;
  };
  /** The join the PC's own window shows, once it is there. */
  const ownJoin = async (): Promise<{ id: string; digits?: string; list?: boolean }> => {
    const approvals = services.relay.approvals;
    const found = deferred<void>();
    const stop = approvals.subscribe(() => { if (approvals.ownJoins().length > 0) found.resolve(); });
    if (approvals.ownJoins().length > 0) found.resolve();
    await bounded(found.promise).finally(stop);
    const listed = await (await fetch(`http://127.0.0.1:${made.app.port}/api/relay/joins`, { headers: own })).json() as { joins: { id: string; digits?: string; list?: boolean }[] };
    return listed.joins[0]!;
  };
  /** A person at the PC presses Allow in its own window. */
  const allowHere = async (id: string): Promise<number> => {
    const base = `http://127.0.0.1:${made.app.port}`;
    return (await fetch(`${base}/api/relay/join`, { method: "POST", headers: { origin: base, "x-herdr-update": "1", "content-type": "application/json", ...own }, body: JSON.stringify({ id, decision: "approve" }) })).status;
  };
  /** A device that signed in to the account and rang at this PC, and the join it opens with its account key. */
  const join = async (device: ListMember, card: string | null) => {
    await vouchFor(made, ACCOUNT, { keys: device.keys, spki: device.key });
    const shown = deferred<string>();
    const matched = deferred<void>();
    const store = new MemoryDeviceStore();
    const opening = open({
      store, intent: "account", accountKey: { private_key: device.keys.privateKey, public_spki: device.key },
      ...(card === null ? {} : { listCard: { list: account.id, enc: device.enc, card } }),
      compare: async (digits) => { shown.resolve(digits); await matched.promise; },
    });
    return { opening, store, digits: bounded(shown.promise, 10_000), match: () => matched.resolve() };
  };
  return { made, services, serverId, offer, account, open, ownJoin, allowHere, join };
}

test("a new device brings its card to a pinned PC, a person at the PC allows it, and the device is handed its place in the list and signs in with its list key", async () => {
  const { made, serverId, offer, account, open, ownJoin, allowHere, join } = await pinnedPc();
  const phone = await listMember();
  const card = await claimKey(made.account, ACCOUNT, account.id, phone);
  const asked = await join(phone, card);
  const waiting = await ownJoin();
  // both screens show the same digits, and the PC's own window is told that the list lets this join in
  expect([waiting.digits, waiting.list]).toEqual([await asked.digits, true]);
  expect(await allowHere(waiting.id)).toBe(200);
  asked.match();
  const joined = await bounded(asked.opening, 15_000);
  // the PC took the card, signed the entry itself and names its place: the very entry the log holds for this key
  expect(joined.server.features).toContain(ACCOUNT_LIST_ALLOW);
  const held = made.account.accountList(ACCOUNT)!;
  const seq = held.state.signers[phone.key]!.seq;
  expect(joined.listPlace).toEqual({ id: account.id, seq, hash: entryHash(entryFromText(held.entries[seq]!).body) });
  // no pairing of this device's own stands behind it, on the device or on the PC
  expect(await asked.store.get(serverId)).toBeUndefined();
  expect(made.devices.hasKey(phone.key)).toBe(false);
  joined.close();
  // and it signs in as any device of the list, with the key the list now holds for it
  const again = await bounded(open({
    store: withAccountDevice(new MemoryDeviceStore(), accountDevice(offer, { private_key: phone.keys.privateKey, public_spki: phone.key })), accountListKey: true,
  }), 10_000);
  expect([again.device.device_id, again.server.features?.includes(ACCOUNT_LIST_FEATURE)]).toEqual([accountDeviceId(serverId, phone.key), true]);
  again.close();
}, 30_000);

test("a device whose key no sign-in of the account claimed is told so, in words of its own, and is in no list", async () => {
  const { made, account, ownJoin, allowHere, join } = await pinnedPc();
  const phone = await listMember();
  // a card that holds for this list, and no claim of the key at the account service
  const asked = await join(phone, await memberCard(phone, account.id));
  const waiting = await ownJoin();
  expect(await allowHere(waiting.id)).toBe(200);
  asked.match();
  const refused = await bounded(asked.opening.then(() => null, (error: unknown) => error), 15_000);
  expect(refused instanceof MuxProtocolError && [refused.code, refused.message]).toEqual(["auth_failed", "list_not_claimed"]);
  expect(failureOf(refused, { code: false, paired: false, codeless: true, compared: true })).toBe("list-not-claimed");
  expect(made.account.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
  expect(made.devices.hasKey(phone.key)).toBe(false);
}, 30_000);

test("a device whose card is for another list stops before any digits are shown", async () => {
  const { made, open } = await pinnedPc();
  const phone = await listMember();
  const other = "6d".repeat(32);
  await vouchFor(made, ACCOUNT, { keys: phone.keys, spki: phone.key });
  let shown = false;
  const refused = await bounded(open({
    store: new MemoryDeviceStore(), intent: "account", accountKey: { private_key: phone.keys.privateKey, public_spki: phone.key },
    listCard: { list: other, enc: phone.enc, card: await memberCard(phone, other) }, compare: async () => { shown = true; },
  }).then(() => null, (error: unknown) => error), 10_000);
  expect([refused instanceof ListMismatchError, shown]).toEqual([true, false]);
}, 30_000);

import { afterEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { exportAccountKey, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, deferred, relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";

// When its enrollment ends, a PC reads its mailbox at once, so the account's directory shows it seen
// within seconds rather than on the next five-minute pull (docs/account.md, "Account service API").

type Fixture = ReturnType<typeof relayFixture>;
type Link = Awaited<ReturnType<typeof relayConnection>>;

const SERVER_ID = "0123456789abcdef0123456789abcdef";
const ACCOUNT = "acct_1";
const guard = [["content-type", "application/json"], ["x-herdr-machine", "1"]] as const;
const fixtures: Fixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

async function post(link: Link, target: string, body: unknown) {
  const request = link.open(target, { method: "POST", headers: guard, body: "stream" });
  void request.stream.sendBody(new Response(JSON.stringify(body)).body ?? new ReadableStream()).catch(() => {});
  const response = await request.response;
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/**
 * A PC listed in `ACCOUNT`'s directory at the fake account service, whose first member linked it: its
 * enrollment waits for that member. `answer` stands in for the service; it defaults to the fake.
 */
async function linkedPc(answer?: (request: Request, service: FakeAccountService) => Promise<Response>, url = "https://account.test") {
  const service = new FakeAccountService();
  const seen: string[] = [];
  const mailboxRead = deferred<void>();
  const fetch = async (request: Request) => {
    const path = new URL(request.url).pathname;
    seen.push(path);
    const response = await (answer ?? ((r: Request) => service.fetch(r)))(request, service);
    if (path === "/v1/pc/mailbox") mailboxRead.resolve();
    return response;
  };
  const f = relayFixture(false, { accountService: { url, fetch } });
  fixtures.push(f);
  const identity = rotateRelayIdentity(f.stateDir);
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  const lastSeen = async () => {
    const { pcs } = await (await service.fetch(new Request("https://account.test/v1/pcs", { headers: { authorization: `Bearer ${token}` } }))).json() as { pcs: { last_seen_at: string | null }[] };
    return pcs[0]?.last_seen_at ?? null;
  };
  const legacy = await relayDevice(f);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = await exportAccountKey(keys.publicKey);
  const record = await signAccountRecord({ v: 1, kind: "link", account: ACCOUNT, key: spki, server_id: SERVER_ID, device_id: legacy.id, old_key: legacy.publicKey,
    issued_at: new Date().toISOString(), id: newRecordId(), signer: spki }, keys.privateKey);
  const before = await relayConnection(f);
  await before.auth(legacy);
  expect((await post(before, "/api/account/link", { record })).status).toBe(200);
  const link = await relayConnection(f);
  await link.auth({ keys, publicKey: spki, id: legacy.id });
  expect(f.app.context.services.accountHolds.enrolling()).toBe(true);
  const enroll = () => post(link, "/api/account/enroll", { account: ACCOUNT, records: [] });
  return { f, service, seen, mailboxRead, lastSeen, enroll, deviceId: legacy.id };
}

const mailboxReads = (seen: string[]) => seen.filter((path) => path === "/v1/pc/mailbox").length;

test("the end of an enrollment reads the mailbox at once, so the directory shows the PC seen", async () => {
  const { seen, mailboxRead, lastSeen, enroll } = await linkedPc();
  expect(mailboxReads(seen)).toBe(0);
  expect(await lastSeen()).toBeNull();
  expect((await enroll()).status).toBe(200);
  // the five-minute timer never ticks here: only the end of the enrollment can have started this pull
  await bounded(mailboxRead.promise, 3_000);
  expect(mailboxReads(seen)).toBe(1);
  expect(await lastSeen()).not.toBeNull();
});

test("the enrollment's answer arrives while the pull it started is still held at the service", async () => {
  const gate = deferred<void>();
  const { seen, mailboxRead, enroll } = await linkedPc(async (request, service) => { await gate.promise; return service.fetch(request); });
  let pullEnded = false;
  void mailboxRead.promise.then(() => { pullEnded = true; });
  const answer = await bounded(enroll(), 3_000).catch(() => null);
  const heldWhenAnswered = !pullEnded;
  gate.resolve();
  expect(answer?.status).toBe(200);
  expect(heldWhenAnswered).toBe(true);
  await bounded(mailboxRead.promise, 3_000);
  expect(seen).toEqual(["/v1/pc/challenge", "/v1/pc/mailbox"]);
});

test("an enrollment that ends while a pull is under way joins it rather than starting a second", async () => {
  const release = deferred<void>();
  const { f, seen, enroll, deviceId } = await linkedPc(async (request, service) => { await release.promise; return service.fetch(request); });
  const holds = f.app.context.services.accountHolds;
  // the answer does not wait for the pull it starts, which stays under way
  expect((await enroll()).status).toBe(200);
  expect(seen).toEqual(["/v1/pc/challenge"]);
  // the PC is brought into an enrollment again, and that one ends too while the first pull still waits
  holds.startEnrolling(deviceId, { stale: true });
  holds.confirmEnrolling(deviceId);
  const ended = deferred<void>();
  const end = holds.endEnrolling.bind(holds);
  holds.endEnrolling = () => { end(); ended.resolve(); };
  const second = enroll();
  await bounded(ended.promise, 3_000);
  release.resolve();
  expect((await second).status).toBe(200);
  // every run queued on the mailbox is over once a settle queued after them is
  await f.app.context.services.accountMailbox.settle();
  expect(seen).toEqual(["/v1/pc/challenge", "/v1/pc/mailbox"]);
});

test("with the account service turned off, an enrollment's end calls nothing", async () => {
  const { f, seen, enroll } = await linkedPc(undefined, "off");
  expect((await enroll()).status).toBe(200);
  await f.app.context.services.accountMailbox.settle();
  expect(seen).toEqual([]);
});

test("a PC in no account ends no enrollment and calls nothing", async () => {
  const seen: string[] = [];
  const service = new FakeAccountService();
  const f = relayFixture(false, { accountService: { url: "https://account.test", fetch: (request) => { seen.push(new URL(request.url).pathname); return service.fetch(request); } } });
  fixtures.push(f);
  rotateRelayIdentity(f.stateDir);
  const device = await relayDevice(f);
  const link = await relayConnection(f);
  await link.auth(device);
  expect((await post(link, "/api/account/enroll", { account: ACCOUNT, records: [] })).status).toBe(403);
  await f.app.context.services.accountMailbox.settle();
  expect(seen).toEqual([]);
});

test("a pull that fails leaves the enrollment's answer as it was, and shows as the mailbox's error", async () => {
  const { f, seen, enroll } = await linkedPc(async () => new Response("{}", { status: 503 }));
  const answer = await enroll();
  expect(answer).toEqual({ status: 200, body: { results: [] } });
  await f.app.context.services.accountMailbox.settle();
  expect(seen).toEqual(["/v1/pc/challenge"]);
  expect(f.app.context.services.accountMailbox.error).toContain("503");
});

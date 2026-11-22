/**
 * Adding this PC to an account in one press (docs/account.md, "One press"): POST /api/account/one-press binds a PC in
 * no account to the account its local owner is signed in to, on the account service's word for that account alone.
 * Conditions of security-triage: only the PC's owner here names the account, the PC's named account and the service's
 * answer must both be it, and nothing is bound otherwise.
 */
import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId, exportAccountKey } from "../../shared/account-records.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { handleRequest, type ServerContext } from "../dispatch.ts";
import { createServer } from "../index.ts";
import { ask, linkRecord, memberRow, pairingPc, phone, provingDevice, sendLink, setUpFor, vouchFor, type Pc } from "./pairing.test-helpers.ts";
import { bounded, relayConnection, TestClock } from "../relay/test-helpers.ts";
import { ACCOUNT_OPENS_ALL_FEATURE, FrameType } from "../../shared/relay-mux.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { pressOnce } from "./one-press.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

async function pc(options: Parameters<typeof pairingPc>[0] = {}): Promise<Pc> {
  const made = await pairingPc({ ...options, server: { accountOpensAll: true, ...options.server } });
  made.account.opensAll = true;
  pcs.push(made);
  return made;
}

/** What the owner's signed-in browser does first: lists this PC in `account` and admits it in one press (S1). */
async function admitAt(f: Pc, account: string, twoStep: boolean | null = true): Promise<void> {
  const identity = f.app.context.services.relay.currentIdentity();
  if (!identity) throw new Error("The PC has no relay identity");
  const token = f.account.issueToken(account, { twoStep });
  const call = (path: string, method: string, body: unknown) =>
    f.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  const listed = await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" });
  if (!listed.ok) throw new Error(`The PC was not listed: ${listed.status} ${await listed.text()}`);
  const admitted = await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {});
  if (!admitted.ok) throw new Error(`The PC was not admitted: ${admitted.status} ${await admitted.text()}`);
}

const press = (f: Pc, account: string) => f.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account } });

async function firstPcWithPhone(f: Pc, completions = true) {
  f.account.completions = completions;
  const clock = new TestClock();
  f.devices.useClock(clock);
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1", null);
  expect((await press(f, "acct_1")).status).toBe(200);
  const token = f.account.issueToken("acct_1");
  const key = await phone();
  f.account.registerSessionKey(token, key.spki, "Phone");
  expect(await f.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const identity = f.app.context.services.relay.currentIdentity()!;
  const serverId = identity.server_id;
  const id = accountDeviceId(serverId, key.spki);
  const future = Date.now() + JOIN_HOLD_MS + 1;
  const time = spyOn(Date, "now").mockImplementation(() => future);
  f.closes.push(() => time.mockRestore());
  const device = { id, keys: key.keys, publicKey: key.spki };
  expect(f.devices.sessionRow(id)?.role).toBe("drive");
  expect(f.stored().some(row => row.relay_public_key === key.spki)).toBe(false);
  const url = `https://account.test/v1/pcs/${serverId}`;
  const headers = { authorization: `Bearer ${token}` };
  return { device, serverId, clock,
    remove: async () => { expect((await f.account.fetch(new Request(url, { method: "DELETE", headers }))).status).toBe(204); },
    relist: async () => {
      const answer = await f.account.fetch(new Request(url, { method: "PUT", headers, body: JSON.stringify({
        label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.test",
      }) }));
      expect(answer.status).toBe(200);
      const { pc: listed } = await answer.json();
      expect(listed.server_id).toBe(serverId);
      expect(listed.admitted_at ?? null).toBeNull();
      expect(listed.completed_at ?? null).toBeNull();
    },
  };
}

test("removed PC: not_listed closes the open account session and keeps the local pairing", async () => {
  let refusal: unknown;
  const f = await pc({ accountFetch: async (request, service) => {
    const response = await service.fetch(request);
    if (new URL(request.url).pathname === "/v1/pc/snapshot" && response.status === 403) refusal = await response.clone().json();
    return response;
  } });
  const { device, serverId, remove } = await firstPcWithPhone(f);
  const local = await phone();
  const paired = f.devices.pairRelay(f.devices.startPairing().code, "Local", local.spki)!.device;
  using audit = spyOn(console, "info").mockImplementation(() => {});
  const link = await relayConnection(f, { serverId });
  expect(await link.auth(device)).toMatchObject({ role: "drive" });
  const second = await relayConnection(f, { serverId });
  expect(await second.auth(device)).toMatchObject({ role: "drive" });
  await remove();
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(refusal).toMatchObject({ error: { code: "not_listed" } });
  expect(await bounded(link.serverError, 2000)).toBe("auth_revoked");
  await bounded(Promise.all([link.closed, second.closed]), 2000);
  expect(f.devices.serviceBinding()).toBeNull();
  expect(f.devices.sessionRow(device.id)).toBeNull();
  const next = await relayConnection(f, { serverId });
  await expect(next.auth(device)).rejects.toThrow("Relay closed before admission");
  expect(await next.serverError).toBe("auth_failed");
  const own = await relayConnection(f, { serverId });
  expect(await own.auth({ id: paired.id, keys: local.keys, publicKey: local.spki })).toMatchObject({ role: paired.role });
  const time = expect.any(String);
  expect(audit.mock.calls.map(([line]) => JSON.parse(line))).toEqual(expect.arrayContaining([
    { time, event: "relay.session.accepted", role: "drive", origin: "account", device_no: expect.any(Number) },
    { time, event: "relay.session.closed", reason: "auth_revoked" },
    { time, event: "account.snapshot.refused", status: 403, reason: "not_listed" },
    { time, event: "account.binding.cleared", reason: "unlisted" },
    { time, event: "account.sessions.closed", count: 2 },
    { time, event: "relay.session.accepted", role: paired.role, origin: "local-pairing", device_no: expect.any(Number) },
  ]));
});

test("removed PC: an idle PC learns of removal at the five-minute poll", async () => {
  jest.useFakeTimers();
  try {
    const f = await pc();
    const { remove } = await firstPcWithPhone(f);
    await remove();
    jest.advanceTimersByTime(5 * 60_000);
    jest.useRealTimers();
    // Join the serialized mailbox turn, without asking for another snapshot.
    await f.app.context.services.accountMailbox.settle();
    expect(f.devices.account()).toBeNull();
  } finally { jest.useRealTimers(); }
});

test("removed PC: a grant after the last answer lapsed waits for the service, not the next periodic poll", async () => {
  let validating = false;
  const asked = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const f = await pc({ accountFetch: async (request, service) => {
    if (validating) { asked.resolve(); await resume.promise; }
    return service.fetch(request);
  } });
  const { device, serverId, remove, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  const next = await relayConnection(f, { serverId });
  validating = true;
  const verdict = next.auth(device).then(() => "admitted", () => next.serverError);
  try {
    expect(await bounded(Promise.race([asked.promise.then(() => "checking"), verdict]))).toBe("checking");
    await remove();
  } finally { resume.resolve(); }
  expect(await bounded(verdict)).toBe("auth_failed");
});

const ACCOUNT_LISTING_ERRORS = "account-listing-errors-1";
const LISTING_CONFIRMED_MS = 60_000;
const listingFeatures = [ACCOUNT_LISTING_ERRORS];
const completionChecks = (f: Pc) => f.account.requests.filter(path => path === "POST /v1/pc/complete").length;
/** One sign-in of an account device on a connection of its own: "admitted", or the code the PC ended it with. */
async function signIn(f: Parameters<typeof relayConnection>[0], serverId: string, device: Parameters<Awaited<ReturnType<typeof relayConnection>>["auth"]>[0],
  features: readonly string[] = listingFeatures, required: readonly string[] = []): Promise<string> {
  const link = await relayConnection(f, { serverId });
  return link.auth(device, features, required).then(() => "admitted", () => bounded(link.serverError));
}
/** The same as a signed-in app opens a PC of its account: the PC must take account sign-ins at all. */
const accountOpen = (f: Parameters<typeof relayConnection>[0], serverId: string, device: Parameters<typeof signIn>[2], features: readonly string[] = listingFeatures) =>
  signIn(f, serverId, device, [ACCOUNT_OPENS_ALL_FEATURE, ...features], [ACCOUNT_OPENS_ALL_FEATURE]);
const lastClear = (stateDir: string) => JSON.parse(readFileSync(join(stateDir, "account-pc.json"), "utf8")).clears.at(-1);

test("listing confirmation: an outage says so, clears nothing and cannot interrupt a local pairing", async () => {
  let offline = false;
  const f = await pc({ accountFetch: async (req, svc) => offline ? new Response(null, { status: 503 }) : svc.fetch(req) });
  const { device, serverId, clock } = await firstPcWithPhone(f);
  const local = await phone();
  const paired = f.devices.pairRelay(f.devices.startPairing().code, "Local", local.spki)!.device;
  const binding = f.devices.serviceBinding();
  clock.advance(LISTING_CONFIRMED_MS);
  offline = true;
  using audit = spyOn(console, "info").mockImplementation(() => {});
  expect(await signIn(f, serverId, { id: paired.id, keys: local.keys, publicKey: local.spki }, [])).toBe("admitted");
  // An app from before the two codes would forget its key over auth_failed: an outage is no word against the key.
  expect(await signIn(f, serverId, device, [])).toBe("internal_error");
  expect(await signIn(f, serverId, device)).toBe("account_unreachable");
  expect(audit.mock.calls.map(([line]) => JSON.parse(line)).filter(line => line.event === "relay.session.closed").map(line => line.reason))
    .toEqual(["account_unreachable", "account_unreachable"]);
  expect(f.devices.serviceBinding()).toBe(binding);
  expect(f.devices.sessionRow(device.id)?.role).toBe("drive");
  offline = false;
  expect(await signIn(f, serverId, device)).toBe("admitted");
});

test("listing confirmation: an account service that does not answer is an outage before the device's own 10 seconds run out", async () => {
  const asked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hung = false;
  const f = await pc({ accountFetch: async (req, svc) => {
    if (hung) { asked.resolve(); await release.promise; }
    return svc.fetch(req);
  } });
  const { device, serverId, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  hung = true;
  const session = new TestClock();
  const link = await relayConnection(f, { serverId, clock: session });
  const verdict = link.auth(device, listingFeatures).then(() => "admitted", () => bounded(link.serverError));
  try {
    await bounded(asked.promise);
    session.advance(3_999);
    expect(await Promise.race([verdict, Promise.resolve("waiting")])).toBe("waiting");
    session.advance(1);
    expect(await verdict).toBe("account_unreachable");
  } finally { hung = false; release.resolve(); }
  expect(f.devices.serviceBinding()).not.toBeNull();
});

test("listing confirmation: a reconnect burst shares one check until exactly 60 monotonic seconds", async () => {
  const f = await pc();
  const { device, serverId, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  const start = completionChecks(f);
  await Promise.all([signIn(f, serverId, device), signIn(f, serverId, device), signIn(f, serverId, device)]);
  expect(completionChecks(f) - start).toBe(1);
  clock.advance(LISTING_CONFIRMED_MS - 1);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  expect(completionChecks(f) - start).toBe(1);
  clock.advance(1);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  expect(completionChecks(f) - start).toBe(2);
});

test("listing confirmation: neither an outage, a failed check nor a clock set back stretches a positive answer", async () => {
  let offline = false;
  const f = await pc({ accountFetch: async (req, svc) => offline ? new Response(null, { status: 503 }) : svc.fetch(req) });
  const { device, serverId, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  offline = true;
  clock.advance(LISTING_CONFIRMED_MS - 1);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  clock.advance(1);
  expect(await signIn(f, serverId, device)).toBe("account_unreachable");
  expect(await signIn(f, serverId, device)).toBe("account_unreachable");
  offline = false;
  const start = completionChecks(f);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  expect(completionChecks(f) - start).toBe(1);
  const wall = Date.now();
  const time = spyOn(Date, "now");
  time.mockImplementation(() => wall - 1);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  expect(completionChecks(f) - start).toBe(2);
  // a sleep the monotonic clock did not count: only the wall clock moved
  time.mockImplementation(() => wall + LISTING_CONFIRMED_MS);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  expect(completionChecks(f) - start).toBe(3);
});

test.each(["unbind", "listing_changed", "identity_reset"] as const)("listing confirmation: %s supersedes a warm grant", async why => {
  const f = await pc();
  const { device, serverId, remove, relist } = await firstPcWithPhone(f);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  if (why === "unbind") f.devices.clearAccountBinding("unlisted", "account");
  else if (why === "identity_reset") await f.app.context.services.relay.resetIdentity();
  else {
    await remove();
    await relist();
    await f.app.context.services.accountMailbox.readSnapshot();
  }
  expect(f.devices.serviceBinding()).toBeNull();
  expect(await signIn(f, serverId, device)).toBe("auth_failed");
});

test("listing confirmation: a removal the PC has not read ends the account's sessions at the first sign-in after the 60 seconds", async () => {
  const f = await pc();
  const { device, serverId, remove, relist, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  const open = await relayConnection(f, { serverId });
  expect(await open.auth(device, listingFeatures)).toMatchObject({ role: "drive" });
  await remove();
  await relist();
  clock.advance(LISTING_CONFIRMED_MS - 1);
  const within = await relayConnection(f, { serverId });
  expect(await within.auth(device, listingFeatures)).toMatchObject({ role: "drive" });
  clock.advance(1);
  expect(await signIn(f, serverId, device)).toBe("auth_failed");
  expect(f.devices.serviceBinding()).toBeNull();
  expect(lastClear(f.stateDir)).toMatchObject({ reason: "unlisted", by: "account" });
  // removed by the account: nothing says to add it again
  expect(await accountOpen(f, serverId, device)).toBe("unsupported_extension");
  expect(await bounded(open.serverError, 2000)).toBe("auth_revoked");
  await bounded(Promise.all([open.closed, within.closed]), 2000);
});

const restarted: (() => Promise<void>)[] = [];
afterEach(async () => { for (const end of restarted.splice(0)) await end(); });
const noAdmission = () => Response.json({ error: { code: "no_admission", message: "No one-press add of this PC is waiting for that account" } }, { status: 404 });
const bindingOf = (stateDir: string) => JSON.parse(readFileSync(join(stateDir, "account-pc.json"), "utf8")).binding;

/**
 * The PC stopped, and started again from a copy of its state folder. `legacy`: its binding names no listing, as every
 * binding made before 0.5.10. `receipt`: the completion receipt of its bind was never taken.
 */
async function restartedFrom(f: Pc, options: { legacy?: boolean; receipt?: boolean; fetch?: (request: Request) => Promise<Response> } = {}) {
  await f.app.stop();
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-upgrade-listing-"));
  cpSync(f.stateDir, stateDir, { recursive: true });
  const path = join(stateDir, "account-pc.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  const { listing_id: listing, ...binding } = state.binding;
  if (options.legacy) writeFileSync(path, JSON.stringify({ ...state, binding }));
  if (options.receipt) writeFileSync(join(stateDir, "account-completion.json"), JSON.stringify({ account: binding.account, listing_id: listing }));
  const app = createServer({ stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, registerBridge: false, sidecar: false,
    accountOpensAll: true, accountService: { url: "https://account.test", fetch: options.fetch ?? f.account.fetch } });
  const closes: (() => void)[] = [];
  restarted.push(async () => { for (const end of closes) end(); await app.stop(); rmSync(stateDir, { recursive: true, force: true }); });
  await app.context.services.accountMailbox.pull();
  return { stateDir, app, closes, close() {}, devices: app.context.services.devices, listing: listing as string, bindId: binding.bind_id as string };
}
/** The PC as an update finds it. */
const updated = (f: Pc, options: Omit<NonNullable<Parameters<typeof restartedFrom>[1]>, "legacy"> = {}) => restartedFrom(f, { ...options, legacy: true });
const pathOf = (request: Request) => new URL(request.url).pathname;

test("upgrade: a binding without a listing ID pins the listing of an admission still current", async () => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  const now = await updated(f);
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
  expect(await signIn(now, serverId, device)).toBe("admitted");
});

test("upgrade: a binding without a listing ID pins the listing of its kept completion receipt", async () => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  const now = await updated(f, { receipt: true, fetch: async req => new URL(req.url).pathname === "/v1/pc/admission" ? noAdmission() : f.account.fetch(req) });
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
  expect(await signIn(now, serverId, device)).toBe("admitted");
});

test("upgrade: a kept completion receipt is not spent by a pull whose read failed, and pins at the next", async () => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  let down = true;
  const now = await updated(f, { receipt: true, fetch: async req => {
    const path = new URL(req.url).pathname;
    if (path === "/v1/pc/admission") return noAdmission();
    return down && path === "/v1/pc/snapshot" ? new Response(null, { status: 503 }) : f.account.fetch(req);
  } });
  expect(bindingOf(now.stateDir)).toEqual({ account: "acct_1", bind_id: now.bindId, service: true });
  down = false;
  await now.app.context.services.accountMailbox.pull();
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
  expect(await signIn(now, serverId, device)).toBe("admitted");
});

test.each([
  ["completed", false],
  ["relisted", false],
  // the receipt names the listing the account removed: the relisting is another
  ["relisted", true],
] as const)("upgrade: with no admission left and a %s listing (receipt kept: %p) the PC leaves the account and says to add it again", async (listing, receipt) => {
  const f = await pc();
  const { device, serverId, remove, relist } = await firstPcWithPhone(f);
  const local = await phone();
  const paired = f.devices.pairRelay(f.devices.startPairing().code, "Local", local.spki)!.device;
  if (listing === "relisted") { await remove(); await relist(); }
  const completions = completionChecks(f);
  let lapsed = true;
  const now = await updated(f, { receipt, fetch: async req => lapsed && new URL(req.url).pathname === "/v1/pc/admission" ? noAdmission() : f.account.fetch(req) });
  expect(bindingOf(now.stateDir)).toBeNull();
  expect(now.devices.account()).toBeNull();
  // A listing some device wrote since is never completed on this PC's own word.
  expect(completionChecks(f) - completions).toBe(receipt ? 1 : 0);
  expect(now.devices.sessionRow(device.id)).toBeNull();
  expect(await signIn(now, serverId, device)).toBe("auth_failed");
  expect(await signIn(now, serverId, { id: paired.id, keys: local.keys, publicKey: local.spki }, [])).toBe("admitted");
  expect(await accountOpen(now, serverId, device)).toBe("account_readd_required");
  expect(await accountOpen(now, serverId, device, [])).toBe("unsupported_extension");
  // why this PC left its account is said only to a key it knew, once proved
  const stranger = await phone();
  expect(await accountOpen(now, serverId, { id: accountDeviceId(serverId, stranger.spki), keys: stranger.keys, publicKey: stranger.spki })).toBe("auth_failed");
  expect(await accountOpen(now, serverId, { ...device, keys: stranger.keys })).toBe("auth_failed");
  lapsed = false;
  await admitAt(f, "acct_1");
  expect(await pressOnce(now.app.context.services, "acct_1")).toEqual({ account: "acct_1" });
  expect(bindingOf(now.stateDir)).toMatchObject({ account: "acct_1", service: true, listing_id: expect.stringMatching(/^[0-9a-f]{32}$/) });
  expect(bindingOf(now.stateDir).listing_id === now.listing).toBe(listing === "completed");
  expect(await accountOpen(now, serverId, device)).toBe("held");
  const held = Date.now();
  spyOn(Date, "now").mockImplementation(() => held + JOIN_HOLD_MS + 1);
  expect(await accountOpen(now, serverId, device)).toBe("admitted");
});

test.each([
  ["an outage", () => new Response(null, { status: 503 })],
  // Step 2 off for the account hides the route: that is no word on the admission
  ["a hidden 404", () => Response.json({ error: { code: "not_found", message: "Unknown request" } }, { status: 404 })],
] as const)("upgrade: %s clears no binding, and the admission pins once the service answers", async (_case, answer) => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  let failing = true;
  const now = await updated(f, { fetch: async req => failing && new URL(req.url).pathname === "/v1/pc/admission" ? answer() : f.account.fetch(req) });
  expect(await signIn(now, serverId, device)).toBe("account_unreachable");
  expect(bindingOf(now.stateDir)).toEqual({ account: "acct_1", bind_id: now.bindId, service: true });
  failing = false;
  await now.app.context.services.accountMailbox.pull();
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
  expect(await signIn(now, serverId, device)).toBe("admitted");
});

test.each([
  [listingFeatures, "account_readd_required"],
  [[], "auth_failed"],
] as const)("upgrade: a sign-in that finds no admission left for a binding without a listing ID is answered %p %p, and the PC leaves the account", async (features, code) => {
  let lapsed = false;
  const f = await pc({ accountFetch: async (req, svc) => lapsed && new URL(req.url).pathname === "/v1/pc/admission" ? noAdmission() : svc.fetch(req) });
  // an account service from before listings had IDs: its admission names none
  const made = await firstPcWithPhone(f, false);
  const { device, serverId } = made;
  expect(f.devices.serviceListing()).toBeUndefined();
  const { clock } = made;
  const open = await relayConnection(f, { serverId });
  expect(await open.auth(device, listingFeatures)).toMatchObject({ role: "drive" });
  clock.advance(LISTING_CONFIRMED_MS);
  lapsed = true;
  expect(await signIn(f, serverId, device, features)).toBe(code);
  expect(f.devices.account()).toBeNull();
  expect(await bounded(open.serverError, 2000)).toBe("auth_revoked");
  expect(await signIn(f, serverId, device)).toBe("auth_failed");
  expect(await accountOpen(f, serverId, device)).toBe("account_readd_required");
});

test("upgrade: an admission another device made for a replacement listing pins nothing to a binding without a listing ID", async () => {
  const f = await pc();
  const { device, serverId, remove, relist } = await firstPcWithPhone(f);
  await remove();
  await relist();
  // a device of the account, freshly signed in with two-step, admits the relisted PC: nobody pressed at the PC
  await admitAt(f, "acct_1");
  const now = await updated(f);
  expect(bindingOf(now.stateDir)).toBeNull();
  expect(now.devices.sessionRow(device.id)).toBeNull();
  expect(await signIn(now, serverId, device)).toBe("auth_failed");
});

test.each([
  ["an empty completed_at", { completed_at: "" }],
  ["a completed_at that is no time", { completed_at: "soon" }],
  ["no completed_at", {}],
  ["a null body", null],
] as const)("listing confirmation: a completion answered 200 with %s confirms nothing", async (_case, body) => {
  let garbled = false;
  const f = await pc({ accountFetch: async (req, svc) => {
    const answer = await svc.fetch(req);
    return garbled && pathOf(req) === "/v1/pc/complete" && answer.ok ? Response.json(body) : answer;
  } });
  const { device, serverId, clock } = await firstPcWithPhone(f);
  const binding = f.devices.serviceBinding();
  clock.advance(LISTING_CONFIRMED_MS);
  garbled = true;
  expect(await signIn(f, serverId, device)).toBe("account_unreachable");
  expect(await f.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: false });
  expect(f.devices.serviceBinding()).toBe(binding);
});

test("the completion receipt is kept until the service takes it or says its listing changed", async () => {
  let answer: (() => Response) | null = () => Response.json(null);
  const f = await pc({ accountFetch: async (req, svc) => {
    if (answer !== null && pathOf(req) === "/v1/pc/complete") return answer();
    return svc.fetch(req);
  } });
  f.account.completions = true;
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1", null);
  expect((await press(f, "acct_1")).status).toBe(200);
  const kept = () => JSON.parse(readFileSync(join(f.stateDir, "account-completion.json"), "utf8"));
  const receipt = { account: "acct_1", listing_id: f.devices.serviceListing() };
  expect(kept()).toEqual(receipt);
  for (const next of [() => Response.json({ completed_at: "" }), () => Response.json({ error: { code: "try_again" } }, { status: 409 }), () => new Response(null, { status: 503 })]) {
    answer = next;
    await f.app.context.services.accountMailbox.pull();
    expect(kept()).toEqual(receipt);
  }
  answer = null;
  await f.app.context.services.accountMailbox.pull();
  expect(kept()).toBeNull();
});

test.each([
  ["no listing ID", (body: Record<string, unknown>) => { const { listing_id: _listing, ...rest } = body; return rest; }],
  ["a null listing ID", (body: Record<string, unknown>) => ({ ...body, listing_id: null })],
  ["a malformed listing ID", (body: Record<string, unknown>) => ({ ...body, listing_id: "L1" })],
] as const)("a press whose admission names %s binds nothing", async (_case, change) => {
  const f = await pc({ accountFetch: async (req, svc) => {
    const answer = await svc.fetch(req);
    return pathOf(req) === "/v1/pc/admission" && answer.ok ? Response.json(change(await answer.json())) : answer;
  } });
  f.account.completions = true;
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1", null);
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([502, "listing_unnamed"]);
  expect(f.devices.account()).toBeNull();
});

test("listing confirmation: after a restart with the account service down, a device from before the account codes keeps its key", async () => {
  const f = await pc();
  const { device, serverId } = await firstPcWithPhone(f);
  const now = await restartedFrom(f, { fetch: async () => new Response(null, { status: 503 }) });
  // auth_failed would make that app forget its pairing; the row only waits for a read that cannot come
  expect(await signIn(now, serverId, device, [])).toBe("internal_error");
  expect(await signIn(now, serverId, device, [ACCOUNT_OPENS_ALL_FEATURE])).toBe("held");
  expect(await signIn(now, serverId, device)).toBe("account_unreachable");
  expect(bindingOf(now.stateDir)).toMatchObject({ bind_id: now.bindId, listing_id: now.listing });
});

test("one press: a listing replaced between the admission and the first read releases no account row", async () => {
  let replace: (() => Promise<void>) | null = null;
  const f = await pc({ accountFetch: async (req, svc) => {
    if (pathOf(req) === "/v1/pc/complete") return new Response(null, { status: 503 });
    const answer = await svc.fetch(req);
    if (pathOf(req) === "/v1/pc/admission" && replace !== null) { const run = replace; replace = null; await run(); }
    return answer;
  } });
  f.account.completions = true;
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const token = f.account.issueToken("acct_1");
  const key = await phone();
  f.account.registerSessionKey(token, key.spki, "Phone");
  const identity = f.app.context.services.relay.currentIdentity()!;
  const url = `https://account.test/v1/pcs/${identity.server_id}`;
  const headers = { authorization: `Bearer ${token}` };
  replace = async () => {
    expect((await f.account.fetch(new Request(url, { method: "DELETE", headers }))).status).toBe(204);
    expect((await f.account.fetch(new Request(url, { method: "PUT", headers, body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.test" }) }))).status).toBe(200);
  };
  await press(f, "acct_1");
  expect(replace).toBeNull();
  expect(f.devices.has(accountDeviceId(identity.server_id, key.spki))).toBe(false);
});

test("a snapshot read whose listing is replaced before its last page releases nothing", async () => {
  let replace: (() => Promise<void>) | null = null;
  const f = await pc({ accountFetch: async (req, svc) => {
    if (replace !== null && pathOf(req) === "/v1/pc/snapshot" && (await req.clone().json()).page === 1) { const run = replace; replace = null; await run(); }
    return svc.fetch(req);
  } });
  const { serverId, remove, relist } = await firstPcWithPhone(f);
  const late = await phone();
  f.account.registerDevice("acct_1", late.spki, "Late");
  for (let index = 0; index < 100; index++) f.account.registerDevice("acct_1", (await phone()).spki, `Device ${index}`);
  replace = async () => { await remove(); await relist(); };
  expect(await f.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: false });
  expect(replace).toBeNull();
  expect(f.devices.has(accountDeviceId(serverId, late.spki))).toBe(false);
});

test("listing confirmation: an AUTH_OK that leaves the queue after the 60 seconds admits nobody", async () => {
  const f = await pc();
  const { device, serverId, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  const link = await relayConnection(f, { serverId });
  const mux = link.session.mux;
  const enqueue = mux.enqueueControl.bind(mux);
  const queued = Promise.withResolvers<() => void>();
  // the carrier holds the frame back: its commit runs only when it is sent
  mux.enqueueControl = (frame, ...rest) => {
    if (frame.type !== FrameType.AUTH_OK) return enqueue(frame, ...rest);
    queued.resolve(() => enqueue(frame, ...rest));
  };
  const verdict = link.auth(device, listingFeatures).then(() => "admitted", () => bounded(link.serverError));
  const send = await bounded(queued.promise);
  clock.advance(LISTING_CONFIRMED_MS);
  send();
  expect(await verdict).toBe("timeout");
  expect(await signIn(f, serverId, device)).toBe("admitted");
});

test("listing confirmation: a later check that fails ends a warm answer", async () => {
  let offline = false;
  const f = await pc({ accountFetch: async (req, svc) => offline ? new Response(null, { status: 503 }) : svc.fetch(req) });
  const { device, serverId, clock } = await firstPcWithPhone(f);
  clock.advance(LISTING_CONFIRMED_MS);
  expect(await signIn(f, serverId, device)).toBe("admitted");
  offline = true;
  clock.advance(1_000);
  expect(await f.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: false });
  expect(await signIn(f, serverId, device)).toBe("account_unreachable");
});

test.each([true, false])("removed PC: restarting after a bare relist cannot release the old phone row (listing ID: %p)", async completions => {
  const f = await pc();
  const { device, serverId, remove, relist } = await firstPcWithPhone(f, completions);
  await f.app.stop();
  await remove();
  await relist();
  // A distinct folder forces all path-keyed state handles to reopen the files from disk.
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relisted-"));
  cpSync(f.stateDir, stateDir, { recursive: true });
  const app = createServer({ stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null,
    registerBridge: false, sidecar: false, accountOpensAll: true, accountService: { url: "https://account.test", fetch: f.account.fetch } });
  const closes: (() => void)[] = [];
  try {
    await app.context.services.accountMailbox.pull();
    expect(app.context.services.devices.sessionRow(device.id)).toBeNull();
    const next = await relayConnection({ stateDir, app, closes, close() {} }, { serverId });
    await expect(next.auth(device)).rejects.toThrow("Relay closed before admission");
    expect(await next.serverError).toBe("auth_failed");
  } finally { for (const close of closes) close(); await app.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("the owner's press binds a PC in no account to the account it is signed in to, and the account's devices are let in by its snapshot", async () => {
  const f = await pc();
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const laptop = await exportAccountKey(keys.publicKey);
  f.account.registerDevice("acct_1", laptop, "Laptop");
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body]).toEqual([200, { account: "acct_1" }]);
  expect(f.devices.account()).toBe("acct_1");
  expect(f.devices.has(accountDeviceId(f.app.context.services.relay.currentIdentity()!.server_id, laptop))).toBe(true);
  expect(await f.status()).toMatchObject({ account: "acct_1" });
  // the admission is spent: a second press finds the PC in its account
  const again = await press(f, "acct_1");
  expect([again.status, again.body.error?.code]).toEqual([409, "in_account"]);
});

test("a press with no admission of that account binds nothing", async () => {
  const f = await pc();
  await setUpFor(f, "acct_1");
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([404, "no_admission"]);
  expect(f.devices.account()).toBeNull();
});

test("the account pressed for must be the one named for this PC: a relay-account another drive caller set to B makes the owner's press for A refuse, and nothing is bound", async () => {
  const f = await pc();
  // any direct drive caller may name the relay-account (routes.ts): here it names B
  await setUpFor(f, "acct_b");
  await admitAt(f, "acct_a");
  await admitAt(f, "acct_b");
  const pressed = await press(f, "acct_a");
  expect([pressed.status, pressed.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(f.devices.account()).toBeNull();
});

test("an admission by another account is invisible to the PC: the press for its named account binds nothing", async () => {
  const f = await pc();
  await setUpFor(f, "acct_a");
  await admitAt(f, "acct_b");
  const pressed = await press(f, "acct_a");
  expect([pressed.status, pressed.body.error?.code]).toEqual([404, "no_admission"]);
  expect(f.devices.account()).toBeNull();
});

test("an answer of the account service that names another account is refused, and nothing is bound", async () => {
  const f = await pc({ accountFetch: async (request, service) => {
    if (new URL(request.url).pathname !== "/v1/pc/admission") return await service.fetch(request);
    const answer = await service.fetch(request);
    const body = await answer.json() as Record<string, unknown>;
    return Response.json({ ...body, account: "acct_other" }, { status: answer.status });
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([502, "account_mismatch"]);
  expect(f.devices.account()).toBeNull();
});

test("a device through the relay cannot press, and a watching one cannot either: nothing is bound", async () => {
  const f = await pc();
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
  const relayed = async (role: "drive" | "watch") => {
    const response = await handleRequest(new Request("https://relay.ovis.invalid/api/account/one-press", {
      method: "POST", headers: { origin: "https://relay.ovis.invalid", "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify({ account: "acct_1" }),
    }), { ...f.app.context, peer: { kind: "relay", device: { id: "aaaaaaaaaaaaaaaa", label: "Relay", role }, sessionId: "s", serverId, key: "" }, timeout: () => {} });
    return [response?.status, ((await response!.json()) as { error: { code: string } }).error.code];
  };
  expect(await relayed("drive")).toEqual([403, "owner_only"]);
  expect(await relayed("watch")).toEqual([403, "read_only"]);
  expect(f.devices.account()).toBeNull();
});

test("an open LAN window cannot press", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-one-press-open-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false, accountOpensAll: true });
  try {
    const base = `http://192.168.1.10:${app.port}`;
    const ctx: ServerContext = { ...app.context, requestIP: () => ({ address: "192.168.1.50" }), timeout: () => {}, upgrade: () => false };
    const response = await handleRequest(new Request(`${base}/api/account/one-press`, {
      method: "POST", headers: { host: `192.168.1.10:${app.port}`, origin: base, "x-herdr-machine": "1", "content-type": "application/json" },
      body: JSON.stringify({ account: "acct_1" }),
    }), ctx);
    expect(response?.status).toBe(403);
    expect(((await response!.json()) as { error: { code: string } }).error.code).toBe("owner_only");
    expect(app.context.services.devices.account()).toBeNull();
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("with the step-2 switch off the PC has no such route", async () => {
  const f = await pc({ server: { accountOpensAll: false } });
  await setUpFor(f, "acct_1");
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([404, "not_found"]);
  expect(f.devices.account()).toBeNull();
});

test("a PC bound in one press keeps its account when the snapshot route answers 404 (step 2 turned off for the account)", async () => {
  const f = await pc();
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  f.account.opensAll = false;
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBe("acct_1");
});

test("service unlisting clears one-press status without a screen channel", async () => {
  const f = await pc({ server: { platform: "darwin" } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
  expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE",
    headers: { authorization: `Bearer ${f.account.issueToken("acct_1")}` } }))).status).toBe(204);
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(await f.status()).toMatchObject({ account: null });
});

test.skipIf(process.platform !== "linux").each(["herdr-web-ui", "ovis"])("sibling unlisting: offline restart from %s keeps only this PC's pairings", async restartFolder => {
  const screen = new TransformStream<Uint8Array, Uint8Array>();
  const writer = screen.writable.getWriter();
  const legacy = await memberRow("acct_1");
  const { account: _, ...plain } = legacy.row;
  const f = await pc({ rows: [plain], server: { desktopOwner: { input: screen.readable, write() {} } } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  const { devices, relay, accountMailbox, localConfirms } = f.app.context.services;
  const serverId = relay.currentIdentity()!.server_id;
  const listed = await phone();
  f.account.registerDevice("acct_1", listed.spki, "Listed only");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const link = (id: string, key: string) => expect(devices.linkAccountKey(id, key, key, "acct_1")).not.toBeNull();
  link(plain.id, legacy.key.spki);
  const code = await phone(), localDigits = await phone(), memberDigits = await phone(), memberCode = await phone();
  const coded = devices.pairRelay(devices.startPairing().code, "Local code", code.spki)!;
  link(coded.device.id, code.spki);
  const memberCoded = devices.pairRelay(devices.startPairing().code, "Member code", memberCode.spki)!;
  link(memberCoded.device.id, memberCode.spki);
  expect(devices.originOf(memberCoded.device.id)).toMatchObject({ from: "remote", how: "code", by: null });
  const digits = devices.pairRelayApproved("Local digits", localDigits.spki, { path: "account" })!;
  link(digits.device.id, localDigits.spki);
  const member = devices.pairRelayApproved("Member digits", memberDigits.spki, { path: "account", addedBy: plain.id })!;
  const proof = await provingDevice(f, await f.offerCode());
  await proof.pending;
  const approval = localConfirms!.pending().find(e => e.action.kind === "approve_key")!;
  const admitted = Promise.withResolvers<string>();
  proof.link.onFrame = frame => { if (frame.type === FrameType.AUTH_OK) admitted.resolve(frame.payload.device_id); };
  await writer.write(new TextEncoder().encode(`${JSON.stringify({ approve: approval.id })}\n`));
  const screened = await bounded(admitted.promise);
  link(screened, proof.device.spki);
  expect(devices.originOf(digits.device.id)).toMatchObject({ from: "remote", how: "digits", by: null });
  expect(devices.originOf(member.device.id)).toMatchObject({ from: "remote", how: "member", by: legacy.key.spki });
  await f.app.stop();
  // a code a member device started names that member as `by`: it stood on the account's authority, not this PC's
  const rowsFile = join(f.stateDir, "devices.json");
  const rows = JSON.parse(readFileSync(rowsFile, "utf8")) as { devices: { id: string; origin?: object }[] };
  rows.devices = rows.devices.map(row => row.id === memberCoded.device.id ? { ...row, origin: { ...row.origin, by: legacy.key.spki } } : row);
  writeFileSync(rowsFile, JSON.stringify(rows), { mode: 0o600 });
  const root = mkdtempSync(join(tmpdir(), "unlisting-siblings-"));
  try {
    const active = join(root, "herdr-web-ui"), sibling = join(root, "ovis");
    for (const dest of [active, sibling]) cpSync(f.stateDir, dest, { recursive: true });
    const opts = { port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, registerBridge: false, sidecar: false };
    const bound = createServer({ ...opts, stateDir: active, siblingStateDir: sibling, accountService: { url: "https://account.test", fetch: f.account.fetch } });
    try {
      expect(bound.context.services.devices.account()).toBe("acct_1");
      expect(bound.context.services.devices.serviceBinding()).not.toBeNull();
      expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE",
        headers: { authorization: `Bearer ${f.account.issueToken("acct_1")}` } }))).status).toBe(204);
      await bound.context.services.accountMailbox.readSnapshot();
      expect(bound.context.services.devices.account()).toBeNull();
    } finally { await bound.stop(); }
    const stateDir = join(root, restartFolder);
    const offline = createServer({ ...opts, stateDir, siblingStateDir: stateDir === active ? sibling : active, accountService: { url: "off" } });
    const closes: (() => void)[] = [];
    try {
      const statuses: number[] = [];
      for (const [id, key] of [[plain.id, legacy.key], [coded.device.id, code], [memberCoded.device.id, memberCode], [screened, proof.device],
        [digits.device.id, localDigits], [member.device.id, memberDigits], [accountDeviceId(serverId, listed.spki), listed]] as const) {
        const session = await relayConnection({ app: offline, stateDir, closes, close() {} });
        statuses.push(await session.auth({ id, keys: key.keys, publicKey: key.spki })
          .then(async () => (await ask(session, "/api/devices")).status, () => 401));
      }
      const own = await fetch(`http://127.0.0.1:${offline.port}/api/account/status`);
      expect({ own: own.status, account: (await own.json()).account, statuses }).toEqual({ own: 200, account: null, statuses: [200, 200, 401, 200, 200, 401, 401] });
    } finally { for (const close of closes) close(); await offline.stop(); }
  } finally { rmSync(root, { recursive: true, force: true }); writer.releaseLock(); }
});

test.skipIf(process.platform !== "linux").each([false, true])("service unlisting keeps a locally paired linked phone through offline restart (locked: %s)", async locked => {
  const screen = new TransformStream<Uint8Array, Uint8Array>();
  const writer = screen.writable.getWriter();
  const f = await pc({ server: { desktopOwner: { input: screen.readable, write() {} } } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const laptop = await phone();
  f.account.registerDevice("acct_1", laptop.spki, "Laptop");
  expect((await press(f, "acct_1")).status).toBe(200);
  const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
  const listedId = accountDeviceId(serverId, laptop.spki);
  expect(f.devices.has(listedId)).toBe(true);
  const pairing = await provingDevice(f, await f.offerCode());
  await pairing.pending;
  const confirm = f.app.context.services.localConfirms?.pending().find(e => e.action.kind === "approve_key");
  if (!confirm) throw new Error("Missing local pairing approval");
  const admitted = Promise.withResolvers<string>();
  pairing.link.onFrame = frame => { if (frame.type === FrameType.AUTH_OK) admitted.resolve(frame.payload.device_id); };
  await writer.write(new TextEncoder().encode(`${JSON.stringify({ approve: confirm.id })}\n`));
  const id = await bounded(admitted.promise);
  await vouchFor(f, "acct_1", pairing.device);
  expect((await sendLink(pairing.link, await linkRecord(id, "acct_1", pairing.device))).status).toBe(200);
  expect(f.stored().find(d => d.id === id)).toMatchObject({ account: "acct_1", origin: { from: "pc" } });
  const lock = locked ? f.app.context.services.safetyLog!.appendLock({ account: "acct_1" }).id : null;
  const removed = await f.account.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${f.account.issueToken("acct_1")}` } }));
  expect(removed.status).toBe(204);
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBeNull();
  expect(f.devices.has(listedId)).toBe(false);
  const atClear = f.stored().find(d => d.id === id);
  await f.app.context.services.relay.stop();
  await f.app.stop();
  const offline = createServer({ stateDir: f.stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null,
    registerBridge: false, sidecar: false, accountService: { url: "off" } });
  const closes: (() => void)[] = [];
  try {
    const base = `http://127.0.0.1:${offline.port}`;
    const local = await fetch(`${base}/api/devices`);
    const signed = await relayConnection({ stateDir: f.stateDir, app: offline, closes, close() {} });
    const pairedStatus = await signed.auth({ id, keys: pairing.device.keys, publicKey: pairing.device.spki })
      .then(async () => (await ask(signed, "/api/devices")).status, () => 401);
    expect({ pairedStatus, local: local.status, account: atClear?.account, linked: atClear?.linked_at,
      stored: atClear?.id }).toEqual({ pairedStatus: 200, local: locked ? 403 : 200, account: undefined, linked: undefined, stored: id });
    expect(offline.context.services.devices.accountError).toBeNull();
    const listed = await relayConnection({ stateDir: f.stateDir, app: offline, closes, close() {} });
    await expect(listed.auth({ id: listedId, keys: laptop.keys, publicKey: laptop.spki })).rejects.toThrow();
    if (lock !== null) {
      expect(await local.json()).toMatchObject({ error: { code: "locked" } });
      expect(await (await fetch(`${base}/api/account/lock`)).json()).toMatchObject({ locked: lock, bound: false });
      expect((await fetch(`${base}/api/account/unlock`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1" },
        body: JSON.stringify({ lock }) })).status).toBe(202);
    }
  } finally { for (const close of closes) close(); await offline.stop(); writer.releaseLock(); }
});

test("first-PC exemption: an account never used, signed in with Google whose two-step is unknown, adds its first PC in one press", async () => {
  const f = await pc();
  await setUpFor(f, "acct_new");
  await admitAt(f, "acct_new", null);
  expect((await press(f, "acct_new")).status).toBe(200);
  expect(f.devices.account()).toBe("acct_new");
});

// account#62: device keys count only once the account had a confirmed or admitted PC, since a person may sign in on the
// phone first; the fake's own tests hold that they count from then on (shared/account-service-fake.test.ts)
test("first-PC exemption: an account whose only device key (revoked included) came before any PC adds its first PC in one press", async () => {
  const f = await pc();
  await setUpFor(f, "acct_phone_first");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const key = await exportAccountKey(keys.publicKey);
  f.account.registerDevice("acct_phone_first", key, "Old phone");
  f.account.removeDevice("acct_phone_first", key);
  await admitAt(f, "acct_phone_first", null);
  expect((await press(f, "acct_phone_first")).status).toBe(200);
  expect(f.devices.account()).toBe("acct_phone_first");
});

test("a LAN window holding the access token, or any window that is not this PC's own, cannot press", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-one-press-token-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "secret-token", tailscaleOwner: null, machines: false, sidecar: false, accountOpensAll: true });
  try {
    const base = `http://192.168.1.10:${app.port}`;
    const ctx: ServerContext = { ...app.context, requestIP: () => ({ address: "192.168.1.50" }), timeout: () => {}, upgrade: () => false };
    const response = await handleRequest(new Request(`${base}/api/account/one-press`, {
      method: "POST", headers: { host: `192.168.1.10:${app.port}`, origin: base, authorization: "Bearer secret-token", "x-herdr-machine": "1", "content-type": "application/json" },
      body: JSON.stringify({ account: "acct_1" }),
    }), ctx);
    expect(response?.status).toBe(403);
    expect(((await response!.json()) as { error: { code: string } }).error.code).toBe("owner_only");
    expect(app.context.services.devices.account()).toBeNull();
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a press whose PC is named for another account while the service answers binds nothing", async () => {
  let rename: (() => Promise<void>) | null = null;
  const f = await pc({ accountFetch: async (request, service) => {
    if (new URL(request.url).pathname === "/v1/pc/admission" && rename !== null) { const now = rename; rename = null; await now(); }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_a");
  await admitAt(f, "acct_a");
  rename = () => setUpFor(f, "acct_b");
  const pressed = await press(f, "acct_a");
  expect([pressed.status, pressed.body.error?.code]).toEqual([409, "account_mismatch"]);
  expect(f.devices.account()).toBeNull();
});

test("a not_listed that answers a read begun under an earlier binding never clears a binding made since", async () => {
  let rebind = false;
  const f = await pc({ accountFetch: async (request, service) => {
    if (rebind && new URL(request.url).pathname === "/v1/pc/snapshot") {
      rebind = false;
      // the PC left and was added again in one press while this read was on its way
      f.devices.clearAccountBinding("unlisted", "test");
      f.devices.bindByService("acct_1");
      return Response.json({ error: { code: "not_listed", message: "gone" } }, { status: 403 });
    }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  const first = f.devices.serviceBinding();
  rebind = true;
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBe("acct_1");
  expect(f.devices.serviceBinding()).not.toBe(first);
});

test("first-PC exemption: a device key the admitting sign-in registered itself does not count as the account being used", async () => {
  const f = await pc();
  await setUpFor(f, "acct_own");
  const identity = f.app.context.services.relay.currentIdentity()!;
  const token = f.account.issueToken("acct_own", { twoStep: null });
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  f.account.registerSessionKey(token, await exportAccountKey(keys.publicKey), "This browser");
  const call = (path: string, method: string, body: unknown) => f.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  expect((await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" })).ok).toBe(true);
  expect((await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {})).status).toBe(200);
  expect((await press(f, "acct_own")).status).toBe(200);
});

test("a press whose PC the account removes during its first read answers no success, and the PC is in no account", async () => {
  let remove = false;
  const f = await pc({ accountFetch: async (request, service) => {
    if (remove && new URL(request.url).pathname === "/v1/pc/snapshot") {
      remove = false;
      const serverId = f.app.context.services.relay.currentIdentity()!.server_id;
      await service.fetch(new Request(`https://account.test/v1/pcs/${serverId}`, { method: "DELETE", headers: { authorization: `Bearer ${service.issueToken("acct_1")}` } }));
    }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  remove = true;
  const pressed = await press(f, "acct_1");
  expect([pressed.status, pressed.body.error?.code]).toEqual([409, "not_listed"]);
  expect(f.devices.account()).toBeNull();
});

test("a not_listed refusal of anything but the snapshot route never unbinds a PC bound in one press", async () => {
  let refuseChallenge = false;
  const f = await pc({ accountFetch: async (request, service) => {
    if (refuseChallenge && new URL(request.url).pathname === "/v1/pc/challenge") return Response.json({ error: { code: "not_listed", message: "x" } }, { status: 403 });
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  expect((await press(f, "acct_1")).status).toBe(200);
  refuseChallenge = true;
  await f.app.context.services.accountMailbox.readSnapshot();
  expect(f.devices.account()).toBe("acct_1");
});

test("PADD-1: a Revoke all that finishes while the press waits on the account service binds nothing", async () => {
  let revoke: (() => void) | null = null;
  const f = await pc({ accountFetch: async (request, service) => {
    if (new URL(request.url).pathname === "/v1/pc/admission" && revoke !== null) { const now = revoke; revoke = null; now(); }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  revoke = () => { f.devices.revokeAll(); };
  const pressed = await press(f, "acct_1");
  expect(pressed.status).toBe(409);
  expect(f.devices.account()).toBeNull();
});

test("first-PC exemption: the same sign-in may repeat its admit before the PC reads it, and gets the same admission", async () => {
  const f = await pc();
  await setUpFor(f, "acct_retry");
  const identity = f.app.context.services.relay.currentIdentity()!;
  const token = f.account.issueToken("acct_retry", { twoStep: null });
  const call = (path: string, method: string, body: unknown) => f.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  expect((await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" })).ok).toBe(true);
  const first = await (await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {})).json() as { admitted_at: string };
  const again = await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {});
  expect(again.status).toBe(200);
  expect(((await again.json()) as { admitted_at: string }).admitted_at).toBe(first.admitted_at);
  // another sign-in of the account gets no exemption of its own
  const other = f.account.issueToken("acct_retry", { twoStep: null });
  expect((await f.account.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}/admit`, { method: "POST", headers: { authorization: `Bearer ${other}` }, body: "{}" }))).status).toBe(403);
  expect((await press(f, "acct_retry")).status).toBe(200);
});

test("PADD-1: a relay identity reset that finishes while the press waits on the account service binds nothing", async () => {
  let reset: (() => Promise<void>) | null = null;
  const f = await pc({ accountFetch: async (request, service) => {
    if (new URL(request.url).pathname === "/v1/pc/admission" && reset !== null) { const now = reset; reset = null; const answer = await service.fetch(request); await now(); return answer; }
    return await service.fetch(request);
  } });
  await setUpFor(f, "acct_1");
  await admitAt(f, "acct_1");
  const before = f.app.context.services.relay.currentIdentity()!.server_id;
  reset = async () => { await f.app.context.services.relay.resetIdentity(); };
  const pressed = await press(f, "acct_1");
  expect(f.app.context.services.relay.currentIdentity()?.server_id).not.toBe(before);
  expect([pressed.status, pressed.body.error?.code]).toEqual([409, "identity_changed"]);
  expect(f.devices.account()).toBeNull();
});

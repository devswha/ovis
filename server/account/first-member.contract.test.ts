import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, fsyncSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountDeviceId, exportAccountKey, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { readDeviceRegistry } from "../devices.ts";
import { privateStateFs } from "../private-state.ts";
import { PcAccountState } from "./pc-binding.ts";
import { loadRelayIdentity } from "../relay/identity.ts";
import { relayDevice, relayFixture } from "../relay/test-helpers.ts";

const account = "acct_first";
const service = "https://account.test";
const path = "/api/account/first-member";
const fresh = () => ({ account, own_sign_in: true, signed_in_at: new Date().toISOString() });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });

async function pc(answer: (r: Request) => Promise<Response> = async () => Response.json(fresh()), accessToken = "") {
  const calls: Request[] = [];
  const f = relayFixture(false, { token: accessToken, accountOpensAll: false, accountService: { url: service, fetch: req => { calls.push(req); return answer(req); } } });
  cleanup.push(() => f.close());
  const id = loadRelayIdentity(f.stateDir).server_id;
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const key = await exportAccountKey(keys.publicKey);
  const base = `http://127.0.0.1:${f.app.port}`;
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, {
    method: "POST", headers: { origin: base, "content-type": "application/json", "x-herdr-machine": "1", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...headers }, body: JSON.stringify(body),
  });
  const challenge = async () => {
    const r = await post(path + "/challenge", { label: "Study browser" });
    expect(r.status).toBe(200);
    const { challenge } = await r.json();
    expect(challenge).toMatch(/^[0-9a-f]{32}$/);
    return String(challenge);
  };
  const record = (nonce: string, forAccount = account, signer = { key, privateKey: keys.privateKey }) => signAccountRecord({
    v: 1, kind: "link", account: forAccount, key: signer.key, signer: signer.key, old_key: signer.key,
    server_id: id, device_id: accountDeviceId(id, signer.key), issued_at: new Date().toISOString(), id: nonce }, signer.privateKey);
  const token = newRecordId();
  const claim = async (nonce: string) => post(path, { account, record: await record(nonce), token });
  const devices = f.app.context.services.devices;
  const enroll = (grant: string, headers: Record<string, string> = {}) => post("/api/account/enroll", { account, records: [], last: true }, { "x-ovis-first-enroll": grant, ...headers });
  return { f, post, challenge, claim, record, token, calls, devices, key, id, privateKey: keys.privateKey, enroll };
}

async function refused(r: Response, status: number, code: string) {
  expect({ status: r.status, code: (await r.json()).error?.code }).toEqual({ status, code });
}

test("both first-member actions refuse a forwarded window before inspecting the claim", async () => {
  const p = await pc();
  for (const header of ["x-forwarded-for", "tailscale-funnel-request", "x-forwarded-port"]) {
    for (const route of [path + "/challenge", path]) await refused(await p.post(route, {}, { [header]: "1" }), 403, "own_window_required");
  }
  expect(p.calls).toHaveLength(0);
});

test("a PC with an existing pairing refuses both actions before looking up a challenge", async () => {
  const p = await pc();
  await relayDevice(p.f);
  for (const route of [path + "/challenge", path]) await refused(await p.post(route, {}), 409, "in_account");
  expect(p.calls).toHaveLength(0);
});

test("a healthy opens-all PC identifies its switch without issuing a challenge or accepting a claim", async () => {
  const f = relayFixture(false, { accountOpensAll: true });
  cleanup.push(() => f.close());
  const base = `http://127.0.0.1:${f.app.port}`;
  for (const action of [path + "/challenge", path]) {
    await refused(await fetch(base + action, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-herdr-machine": "1" }, body: "{}" }), 409, "opens_all");
  }
  expect(f.app.context.services.devices.list(null)).toEqual([]);
});

test("the PC makes fresh challenges and rejects an unknown or sixty-second-old challenge", async () => {
  const p = await pc();
  const first = await p.challenge();
  const second = await p.challenge();
  expect(first).not.toBe(second);
  await refused(await p.claim(newRecordId()), 409, "challenge_invalid");
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  try { await refused(await p.claim(second), 409, "challenge_invalid"); } finally { clock.mockRestore(); }
  expect(p.calls).toHaveLength(0);
});

for (const mismatch of ["key", "account", "signature"] as const) test(`a ${mismatch} mismatch consumes the challenge without contacting the service`, async () => {
  const p = await pc();
  const nonce = await p.challenge();
  const record = await p.record(nonce);
  const other = await pc();
  const r = await p.post(path, { account: mismatch === "account" ? "other" : account, token: p.token,
    record: mismatch === "signature" ? { ...record, issued_at: "2020-01-01T00:00:00.000Z" } : mismatch === "key" ? { ...record, key: other.key } : record });
  expect(r.status).toBe(400);
  await refused(await p.claim(nonce), 409, "challenge_invalid");
  expect(p.calls).toHaveLength(0);
  expect(p.devices.list(null)).toEqual([]);
});

test("a record naming another PC is refused before the service is asked", async () => {
  const p = await pc();
  const other = (await pc()).id;
  const nonce = await p.challenge();
  const record = await signAccountRecord({ v: 1, kind: "link", account, key: p.key, signer: p.key, old_key: p.key, server_id: other,
    device_id: accountDeviceId(other, p.key), issued_at: new Date().toISOString(), id: nonce }, p.privateKey);
  await refused(await p.post(path, { account, record, token: p.token }), 400, "record_invalid");
  expect(p.calls).toHaveLength(0);
  expect(p.devices.list(null)).toEqual([]);
});

test("a sign-in whose time is a few seconds ahead of this PC's clock still proves it", async () => {
  const p = await pc(async () => Response.json({ ...fresh(), signed_in_at: new Date(Date.now() + 20_000).toISOString() }));
  expect((await p.claim(await p.challenge())).status).toBe(200);
  expect(p.devices.list(null)).toHaveLength(1);
});

for (const reason of ["false", "other account", "old", "future", "malformed", "401", "404", "network", "timeout"] as const) test(`session proof fails closed: ${reason}`, async () => {
  const p = await pc(async req => {
    if (reason === "network") throw new TypeError("unreachable");
    if (reason === "timeout") return new Promise((_resolve, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason)));
    if (reason === "401" || reason === "404") return new Response(null, { status: Number(reason) });
    const proof = fresh();
    return Response.json({ ...proof, ...(reason === "false" ? { own_sign_in: false } : reason === "other account" ? { account: "other" }
      : { signed_in_at: reason === "malformed" ? null : new Date(Date.now() + (reason === "old" ? -600_001 : 5 * 60_000)).toISOString() }) });
  });
  const nonce = await p.challenge();
  await refused(await p.claim(nonce), 403, "own_sign_in_required");
  await refused(await p.claim(nonce), 409, "challenge_invalid");
  expect(p.calls).toHaveLength(1);
  expect(p.devices.list(null)).toEqual([]);
}, 12_000);

test("a device-code token leaves no first member and no directory row in either view", async () => {
  const fake = new FakeAccountService();
  const codes = await (await fake.fetch(service + "/v1/signin/github/device", { method: "POST" })).json();
  fake.approveDevice(codes.user_code, account);
  const tokens = await (await fake.fetch(service + "/v1/token", { method: "POST", body: JSON.stringify({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: codes.device_code,
  }) })).json();
  const headers = { authorization: `Bearer ${tokens.access_token}` };
  expect(await (await fake.fetch(service + "/v1/session", { headers })).json()).toMatchObject({ account, own_sign_in: false });
  const p = await pc(fake.fetch);
  await refused(await p.post(path, { record: await p.record(await p.challenge()), account, token: tokens.access_token }), 403, "own_sign_in_required");
  expect(p.devices.list(null)).toEqual([]);
  expect(fake.pcs(account)).toEqual([]);
  for (const query of ["", "?include=unconfirmed"]) expect(await (await fake.fetch(service + "/v1/pcs" + query, { headers })).json()).toEqual({ pcs: [] });
});

test("own proof admits exactly its signer, audits the row and gates enrollment to this member", async () => {
  const p = await pc();
  const nonce = await p.challenge();
  const r = await p.claim(nonce);
  expect(r.status).toBe(200);
  const { device } = await r.json();
  expect(device).toMatchObject({ id: accountDeviceId(p.id, p.key), role: "drive", label: "Study browser" });
  expect(p.devices.accountSigner(p.key, account)).toMatchObject(device);
  expect(p.devices.list(null)).toHaveLength(1);
  expect(p.calls.map(r => [r.method, r.url, r.headers.get("authorization"), r.redirect])).toEqual([["GET", service + "/v1/session", `Bearer ${p.token}`, "error"]]);
  expect(p.f.app.context.services.accountHolds.enrollingMember()).toBe(device.id);
  expect(readFileSync(join(p.f.stateDir, "first-member-journal.json"), "utf8")).toContain("first member added on this PC");
  expect(existsSync(join(p.f.stateDir, "account-pc.json"))).toBe(false);
  const log = readFileSync(join(p.f.stateDir, "http-requests.jsonl"), "utf8");
  expect(log).toContain(path);
  expect(log).not.toContain(p.token);
  await refused(await p.claim(nonce), 409, "in_account");
  const enroll = (grant: string) => p.post("/api/account/enroll", { account, records: [], last: true }, { "x-ovis-first-enroll": grant });
  expect((await enroll("unknown")).status).toBe(403);
  const grant = r.headers.get("x-ovis-first-enroll") ?? "";
  expect((await enroll(grant)).status).toBe(200);
  expect(p.f.app.context.services.accountHolds.enrolling()).toBe(false);
  expect((await enroll(grant)).status).toBe(403);
});

test("a pairing arriving during the session read wins over the pending first member", async () => {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const p = await pc(async () => { arrived.resolve(); await release.promise; return Response.json(fresh()); });
  const claim = p.claim(await p.challenge());
  await arrived.promise;
  try { await relayDevice(p.f); } finally { release.resolve(); }
  await refused(await claim, 409, "in_account");
  expect(p.devices.account()).toBeNull();
});

test("Revoke all during the session read cancels the outstanding admission", async () => {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const p = await pc(async () => { arrived.resolve(); await release.promise; return Response.json(fresh()); });
  const claim = p.claim(await p.challenge());
  await arrived.promise;
  try { p.devices.revokeAll(); } finally { release.resolve(); }
  await refused(await claim, 409, "challenge_invalid");
  expect(p.devices.list(null)).toEqual([]);
});

test("only a fresh claim by the sole enrolling member rotates its grant without rewriting its row or journal", async () => {
  let own = true;
  const p = await pc(async () => Response.json({ ...fresh(), own_sign_in: own }));
  const first = await p.claim(await p.challenge());
  expect(first.status).toBe(200);
  const before = p.devices.list(null, true);
  const journal = () => readFileSync(join(p.f.stateDir, "first-member-journal.json"), "utf8");
  const audit = journal();
  own = false;
  await refused(await p.claim(await p.challenge()), 403, "own_sign_in_required");
  own = true;
  const recovered = await p.claim(await p.challenge());
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual(await first.json());
  const grant = recovered.headers.get("x-ovis-first-enroll") ?? "";
  expect(grant).not.toBe(first.headers.get("x-ovis-first-enroll"));
  expect(p.calls).toHaveLength(3);
  expect(p.devices.list(null, true)).toEqual(before);
  expect(journal()).toBe(audit);
  const pending = await p.challenge();
  expect((await p.enroll(first.headers.get("x-ovis-first-enroll") ?? "")).status).toBe(403);
  expect((await p.enroll(grant)).status).toBe(200);
  await refused(await p.claim(pending), 409, "in_account");
  await refused(await p.post(path + "/challenge", {}), 409, "in_account");
});

for (const mismatch of ["another key", "another account"] as const) test(`an enrolling PC refuses a fresh claim for ${mismatch}`, async () => {
  const p = await pc();
  expect((await p.claim(await p.challenge())).status).toBe(200);
  const nonce = await p.challenge();
  const forAccount = mismatch === "another account" ? "acct_other" : account;
  const signer = mismatch === "another key" ? await pc() : p;
  await refused(await p.post(path, { account: forAccount, token: p.token, record: await p.record(nonce, forAccount, signer) }), 409, "in_account");
});

for (const race of ["identity reset", "new challenge"] as const) test(`${race} during the session read refuses the claim without a row, barrier or journal`, async () => {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const p = await pc(async () => { arrived.resolve(); await release.promise; return Response.json(fresh()); });
  const claim = p.claim(await p.challenge());
  await arrived.promise;
  try {
    if (race === "identity reset") await p.f.app.context.services.relay.resetIdentity();
    else await p.challenge();
  } finally { release.resolve(); }
  await refused(await claim, 409, race === "identity reset" ? "account_unavailable" : "challenge_invalid");
  expect(p.devices.list(null)).toEqual([]);
  expect(p.devices.account()).toBeNull();
  expect(p.f.app.context.services.accountHolds.enrolling()).toBe(false);
  expect(existsSync(join(p.f.stateDir, "first-member-journal.json"))).toBe(false);
});

for (const reason of ["expired", "revoked member", "forwarded window"] as const) test(`a grant cannot enroll: ${reason}`, async () => {
  const p = await pc(undefined, reason === "forwarded window" ? newRecordId() : "");
  const admitted = await p.claim(await p.challenge());
  expect(admitted.status).toBe(200);
  const grant = admitted.headers.get("x-ovis-first-enroll");
  if (!grant) throw new Error("Missing enrollment grant");
  if (reason === "revoked member") expect(p.devices.revoke(accountDeviceId(p.id, p.key))).toBe(true);
  const clock = reason === "expired" ? spyOn(Date, "now").mockReturnValue(Date.now() + 600_001) : null;
  try {
    await refused(await p.enroll(grant, reason === "forwarded window" ? { "x-forwarded-for": "127.0.0.1" } : {}), 403, "account_required");
  } finally { clock?.mockRestore(); }
});

test("a recovery claim never creates a first member on an empty PC", async () => {
  const p = await pc();
  await refused(await p.post(path, { account, record: await p.record(await p.challenge()), token: p.token, recover: true }), 409, "in_account");
  expect(p.devices.list(null)).toEqual([]);
});

for (const failure of ["open", "write", "full disk", "previously closed gate"] as const) test(`a first-member journal ${failure} failure leaves no member, grant, barrier or pairing announcement`, async () => {
  const p = await pc();
  if (failure === "previously closed gate") { p.devices.closeGate(); await Promise.resolve(); }
  const registry = join(p.f.stateDir, "devices.json");
  const before = readDeviceRegistry(registry, false);
  const gated = p.devices.gated;
  const othersEver = PcAccountState.open(p.f.stateDir).othersEver();
  let closures = 0;
  p.devices.onGateClosed(() => { closures++; });
  const journal = join(p.f.stateDir, "first-member-journal.json");
  if (failure === "open") writeFileSync(journal, "damaged");
  let full = false;
  const sync = failure === "full disk" ? spyOn(privateStateFs, "fsyncSync").mockImplementation(fd => {
    if (full) throw new Error("no space left to flush a new file");
    fsyncSync(fd);
  }) : null;
  const rename = failure !== "open" ? spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (to === journal) { full = failure === "full disk"; throw new Error("journal replacement failed"); }
    renameSync(from, to);
  }) : null;
  const paired: string[] = [];
  p.devices.onPaired(event => paired.push(event.device_id));
  try {
    const res = await p.claim(await p.challenge());
    const disk = readDeviceRegistry(registry, false);
    expect({ rows: p.devices.list(null).length, disk: disk.kind === "ok" ? disk.devices.length : disk.kind === "missing" ? 0 : "bad",
      account: p.devices.account(), enrolling: p.f.app.context.services.accountHolds.enrolling(), grant: res.headers.get("x-ovis-first-enroll"), paired })
      .toEqual({ rows: 0, disk: 0, account: null, enrolling: false, grant: null, paired: [] });
    await refused(res, 409, "account_unavailable");
    expect({ disk, gated: p.devices.gated, othersEver: PcAccountState.open(p.f.stateDir).othersEver(), closures })
      .toEqual({ disk: before, gated, othersEver, closures: 0 });
    expect(p.devices.isTombstoned(p.key)).toBe(false);
  } finally { rename?.mockRestore(); sync?.mockRestore(); }
});

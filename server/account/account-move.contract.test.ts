import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId } from "../../shared/account-records.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { createServer } from "../index.ts";
import { privateStateFs } from "../private-state.ts";
import { bounded, relayConnection } from "../relay/test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ask, firstPairingRead, memberRow, pairingPc, phone, setUpFor } from "./pairing.test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";

const FROM = "acct_1";
const INTO = "acct_after";
const service = "https://account.test";
const headers = { "x-herdr-machine": "1" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture({ limit = false, failLeave = false } = {}) {
  const member = await memberRow(FROM);
  const leaves: string[] = [];
  const pc = await pairingPc({
    rows: [member.row], server: { accountOpensAll: true },
    accountFetch: async (request, fake) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/leave")) {
        const body = await request.clone().json();
        leaves.push(body.account);
        if (failLeave && leaves.length === 1) return new Response(null, { status: 503 });
      }
      return fake.fetch(request);
    },
  });
  cleanups.push(() => pc.close());
  pc.account.relayPassSlots = limit ? 0 : 10;
  const { services } = pc.app.context;
  const identity = services.relay.currentIdentity();
  if (!identity) throw new Error("Missing fixture identity");
  pc.account.saysListingAdmitted = true;
  pc.account.completions = true;
  await firstPairingRead(pc);
  await setUpFor(pc, FROM);
  const token = pc.account.issueToken(INTO, { twoStep: true });
  const path = `/v1/pcs/${identity.server_id}`;
  const entry = { label: "Desk", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.test" };
  const send = (route: string, method: string, body?: unknown, bearer = token) => pc.account.fetch(new Request(service + route, {
    method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const put = () => send(path, "PUT", entry);
  const admit = () => send(`${path}/admit`, "POST", {});
  const rows = async (account: string) => (await (await send("/v1/pcs", "GET", undefined, pc.account.issueToken(account))).json()).pcs;
  const move = (stage?: "prepare" | "cancel") => pc.local("/api/account/move", {
    method: "POST", headers, body: { into: INTO, ...(stage === undefined ? {} : { stage }) },
  });
  const journal = () => existsSync(join(pc.stateDir, "account-move.json"));
  const original = pc.stored().map(({ id, relay_public_key, token_hash, role }) => ({ id, relay_public_key, token_hash, role }));
  const keptRows = () => pc.stored().map(({ id, relay_public_key, token_hash, role }) => ({ id, relay_public_key, token_hash, role }));
  return { pc, move, put, admit, rows, journal, leaves, original, keptRows, path, token, entry, identity, member };
}

function reopen(pc: Awaited<ReturnType<typeof pairingPc>>) {
  const app = createServer({
    stateDir: pc.stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, sidecar: false,
    accountOpensAll: true, accountService: { url: service, fetch: pc.account.fetch },
  });
  cleanups.push(async () => { await app.stop(); });
  return app;
}

const localMove = (port: number, stage?: "prepare") => fetch(`http://127.0.0.1:${port}/api/account/move`, {
  method: "POST", headers: { ...headers, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
  body: JSON.stringify({ into: INTO, ...(stage === undefined ? {} : { stage }) }),
});

test("moving a bound PC preserves local rows and leaves its W listing only after the switch", async () => {
  const f = await fixture();
  expect((await f.move("prepare")).status).toBe(200);
  expect(f.journal()).toBe(true);
  expect((await f.put()).status).toBe(200);
  expect((await f.admit()).status).toBe(200);
  expect(await f.move()).toMatchObject({ status: 200, body: { state: "moved", account: INTO } });
  expect(f.pc.devices.account()).toBe(INTO);
  expect(f.keptRows()).toEqual(f.original);
  expect(f.pc.devices.accountSession(f.member.row.id, f.member.key.spki)).toBe(false);
  expect(await f.rows(FROM)).toEqual([]);
  expect(await f.rows(INTO)).toMatchObject([{ completed_at: expect.any(String) }]);
  expect(f.leaves).toEqual([FROM]);
  expect(f.journal()).toBe(false);
});

test("a drive device cannot start a move through the relay", async () => {
  const f = await fixture();
  const link = await relayConnection(f.pc, { serverId: f.identity.server_id });
  await link.auth({ id: f.member.row.id, keys: f.member.key.keys, publicKey: f.member.key.spki });
  expect(await ask(link, "/api/account/move", { method: "POST", body: { into: INTO, stage: "prepare" } }))
    .toMatchObject({ status: 403 });
  expect(f.journal()).toBe(false);
});

test("a paired account key still authenticates after a restart during the local row write", async () => {
  const f = await fixture();
  const { accountMailbox } = f.pc.app.context.services;
  const listed = await phone();
  const id = accountDeviceId(f.identity.server_id, listed.spki);
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() - JOIN_HOLD_MS - 1_000);
  try {
    f.pc.account.registerDevice(FROM, listed.spki, "Listed");
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  } finally { clock.mockRestore(); }
  expect(f.pc.devices.sessionRow(id)?.key).toBe(listed.spki);
  expect((await f.move("prepare")).status).toBe(200);
  expect((await f.put()).status).toBe(200);
  expect((await f.admit()).status).toBe(200);
  const rename = privateStateFs.renameSync;
  const write = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (to === join(f.pc.stateDir, "devices.json") && f.pc.devices.account() === INTO) {
      throw Object.assign(new Error("Registry write was interrupted"), { code: "EIO" });
    }
    rename(from, to);
  });
  try {
    expect((await f.move()).status).toBe(202);
    expect(f.pc.devices.account()).toBe(INTO);
    expect(f.journal()).toBe(true);
    expect(f.leaves).toEqual([]);
  } finally { write.mockRestore(); }
  await f.pc.app.stop();
  const app = reopen(f.pc);
  const { devices } = app.context.services;
  expect((await localMove(app.port)).status).toBe(200);
  const link = await relayConnection({ ...f.pc, app }, { serverId: f.identity.server_id });
  await link.auth({ id, keys: listed.keys, publicKey: listed.spki });
  expect((await ask(link, "/api/devices")).status).toBe(200);
  expect(devices.accountSession(id, listed.spki)).toBe(false);
  expect(await f.rows(FROM)).toEqual([]);
  expect(f.journal()).toBe(false);
});

test("plain one press still refuses a PC bound to the named account", async () => {
  const { pc } = await fixture();
  expect(await pc.local("/api/account/one-press", { method: "POST", headers, body: { account: FROM } }))
    .toMatchObject({ status: 409, body: { error: { code: "in_account" } } });
});

test.each(["relay_limit", "cancel"] as const)("%s keeps W and leaves the G listing visible", async (reason) => {
  const f = await fixture({ limit: reason === "relay_limit" });
  expect((await f.move("prepare")).status).toBe(200);
  expect((await f.put()).status).toBe(200);
  expect((await f.admit()).status).toBe(200);
  const answer = reason === "cancel" ? await f.move("cancel") : await f.move();
  expect(answer.body).toMatchObject({ state: "aborted", account: INTO });
  expect(f.pc.devices.account()).toBe(FROM);
  expect(f.keptRows()).toEqual(f.original);
  expect(await f.rows(FROM)).toHaveLength(1);
  expect(await f.rows(INTO)).toHaveLength(1);
  expect(f.leaves).toEqual([]);
  expect(f.journal()).toBe(false);
  await f.pc.app.stop();
  const app = reopen(f.pc);
  const status = await fetch(`http://127.0.0.1:${app.port}/api/account/move`);
  expect(await status.json()).toEqual({ into: null, aborted: { state: "aborted", account: INTO, reason: reason === "cancel" ? "cancelled" : "relay_limit" } });
});

test("an unsuccessful W leave keeps the journal and is retried after restart", async () => {
  const f = await fixture({ failLeave: true });
  expect((await f.move("prepare")).status).toBe(200);
  expect((await f.put()).status).toBe(200);
  expect((await f.admit()).status).toBe(200);
  expect((await f.move()).status).toBe(202);
  expect(f.pc.devices.account()).toBe(INTO);
  expect(f.leaves).toEqual([FROM]);
  expect(f.journal()).toBe(true);
  await f.pc.app.stop();
  const app = reopen(f.pc);
  const reply = await localMove(app.port);
  expect(reply.status).toBe(200);
  expect(await f.rows(FROM)).toEqual([]);
  expect(f.journal()).toBe(false);
  expect(f.keptRows()).toEqual(f.original);
});

test.skipIf(process.platform === "win32").each(["journal", "put", "admit", "admission", "pass", "switch", "complete", "leave"] as const)(
  "SIGKILL after %s leaves one local binding and can finish forward", async (boundary) => {
    const f = await fixture();
    await f.pc.app.stop();
    const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => f.pc.account.fetch(request) });
    const child = Bun.spawn([process.execPath, "-e", `
      import { createServer } from ${JSON.stringify(join(import.meta.dir, "../index.ts"))};
      import { privateStateFs } from ${JSON.stringify(join(import.meta.dir, "../private-state.ts"))};
      import { join } from "node:path";
      const c = ${JSON.stringify({ boundary, dir: f.pc.stateDir, fake: fake.url.origin, path: f.path, token: f.token, entry: f.entry, into: INTO })};
      const killed = at => { if (at === c.boundary) process.kill(process.pid, "SIGKILL"); };
      const app = createServer({ stateDir: c.dir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, sidecar: false,
        accountOpensAll: true, accountService: { url: "https://account.test", fetch: async request => {
          const path = new URL(request.url).pathname;
          const body = await request.clone().json();
          const response = await fetch(new Request(c.fake + path, request));
          if (response.ok) {
            if (body.account === c.into) {
              if (path === "/v1/pc/admission") killed("admission");
              if (path === "/v1/pc/relay-pass") killed("pass");
              if (path === "/v1/pc/complete") killed("complete");
            }
            if (path.endsWith("/leave")) killed("leave");
          }
          return response;
        } },
      });
      const rename = privateStateFs.renameSync;
      privateStateFs.renameSync = (from, to) => {
        rename(from, to);
        if (to === join(c.dir, "account-move.json")) killed("journal");
        if (to === join(c.dir, "account-pc.json") && app.context.services.devices.account() !== c.into) {
          const doc = awaitFile(to);
          if (doc.binding?.account === c.into) killed("switch");
        }
      };
      function awaitFile(path) { return JSON.parse(readFileSync(path, "utf8")); }
      import { readFileSync } from "node:fs";
      const base = "http://127.0.0.1:" + app.port;
      const move = stage => fetch(base + "/api/account/move", { method: "POST", headers: {
        origin: base, "x-herdr-machine": "1", "content-type": "application/json",
      }, body: JSON.stringify({ into: c.into, stage }) });
      const requireOk = response => { if (!response.ok) throw new Error("Unexpected HTTP " + response.status); };
      requireOk(await move("prepare"));
      const target = (path, method, body) => fetch(c.fake + path, { method, body: JSON.stringify(body), headers: {
        authorization: "Bearer " + c.token, "content-type": "application/json",
      } });
      requireOk(await target(c.path, "PUT", c.entry));
      killed("put");
      requireOk(await target(c.path + "/admit", "POST", {}));
      killed("admit");
      requireOk(await move());
      await app.stop();
    `], { env: { ...process.env }, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    try {
      await bounded(child.exited);
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await child.exited;
      await fake.stop(true);
    }
    for (const file of ["account-move.json", "account-pc.json"]) {
      const lock = join(f.pc.stateDir, `${file}.lock`);
      const stale = new Date(Date.now() - 11_000);
      if (existsSync(lock)) utimesSync(lock, stale, stale);
    }
    const beforeSwitch = ["journal", "put", "admit", "admission", "pass"].includes(boundary);
    expect(PcAccountState.open(f.pc.stateDir).binding()?.account).toBe(beforeSwitch ? FROM : INTO);
    expect(await f.rows(FROM)).toHaveLength(boundary === "leave" ? 0 : 1);
    const app = reopen(f.pc);
    if (["journal", "put", "admit"].includes(boundary)) {
      expect(app.context.services.devices.account()).toBe(FROM);
      expect((await localMove(app.port, "prepare")).status).toBe(200);
      expect((await f.put()).status).toBe(200);
      expect((await f.admit()).status).toBe(200);
    }
    if (beforeSwitch) expect(f.keptRows()).toEqual(f.original);
    expect((await localMove(app.port)).status).toBe(200);
    expect(app.context.services.devices.account()).toBe(INTO);
    expect(f.keptRows()).toEqual(f.original);
    expect(await f.rows(FROM)).toEqual([]);
    expect(await f.rows(INTO)).toHaveLength(1);
    expect(f.journal()).toBe(false);
  },
);

test("a denied binding-file replacement keeps W and retries without losing rows", async () => {
  const f = await fixture();
  expect((await f.move("prepare")).status).toBe(200);
  expect((await f.put()).status).toBe(200);
  expect((await f.admit()).status).toBe(200);
  const rename = privateStateFs.renameSync;
  const locked = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (to === join(f.pc.stateDir, "account-pc.json")) throw Object.assign(new Error("Sharing violation"), { code: "EPERM" });
    rename(from, to);
  });
  try {
    expect((await f.move()).status).toBe(202);
    expect(f.pc.devices.account()).toBe(FROM);
    expect(f.keptRows()).toEqual(f.original);
    expect(f.leaves).toEqual([]);
    expect(f.journal()).toBe(true);
  } finally { locked.mockRestore(); }
  expect((await f.move()).status).toBe(200);
  expect(f.pc.devices.account()).toBe(INTO);
  expect(f.keptRows()).toEqual(f.original);
  expect(f.journal()).toBe(false);
});

test.skipIf(process.platform !== "win32")("a Windows read handle delays the binding switch without losing rows", async () => {
  const f = await fixture();
  expect((await f.move("prepare")).status).toBe(200);
  expect((await f.put()).status).toBe(200);
  expect((await f.admit()).status).toBe(200);
  const command = "$f=[IO.File]::Open($env:OVIS_MOVE_TEST_FILE,'Open','Read','Read'); [Console]::WriteLine('held'); [Console]::ReadLine(); $f.Dispose()";
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, OVIS_MOVE_TEST_FILE: join(f.pc.stateDir, "account-pc.json") }, stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await bounded(reader.read())).value).trim()).toBe("held");
    expect((await f.move()).status).toBe(202);
    expect(f.pc.devices.account()).toBe(FROM);
    expect(f.keptRows()).toEqual(f.original);
    expect(f.journal()).toBe(true);
  } finally {
    child.stdin.end();
    await bounded(child.exited);
  }
  expect((await f.move()).status).toBe(200);
  expect(f.pc.devices.account()).toBe(INTO);
  expect(f.keptRows()).toEqual(f.original);
});

import { afterEach, expect, spyOn, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
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
const JOURNAL = "account-move.json";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const scratch = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `ovis-move-${name}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** What the test account service is made to answer: leaves that fail, and the destination's pass or mailbox while it is down. */
interface Faults { leave: number; pass: boolean; mailbox: boolean }

async function fixture({ limit = false, sibling = false, relayPass = false } = {}) {
  const member = await memberRow(FROM);
  const leaves: string[] = [];
  const intoPasses: string[] = [];
  const faults: Faults = { leave: 0, pass: false, mailbox: false };
  const siblingDir = sibling ? scratch("sibling") : null;
  const down = () => Response.json({ error: { code: "unavailable", message: "Try again later" } }, { status: 503 });
  const pc = await pairingPc({
    rows: [member.row], server: { accountOpensAll: true, ...(siblingDir === null ? {} : { siblingStateDir: siblingDir }) }, relayPass,
    accountFetch: async (request, fake) => {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.clone().json().catch(() => null) as { account?: string } | null : null;
      if (path.endsWith("/leave")) {
        leaves.push(String(body?.account));
        if (faults.leave > 0) { faults.leave -= 1; return down(); }
      }
      if (body?.account === INTO && ((path === "/v1/pc/relay-pass" && faults.pass) || (path === "/v1/pc/mailbox" && faults.mailbox))) return down();
      const response = await fake.fetch(request);
      if (body?.account === INTO && path === "/v1/pc/relay-pass" && response.ok) intoPasses.push((await response.clone().json() as { pass: string }).pass);
      return response;
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
  /** The window's part of a move: the journal, then the destination's listing and admission. */
  const ready = async () => {
    expect((await move("prepare")).status).toBe(200);
    expect((await put()).status).toBe(200);
    expect((await admit()).status).toBe(200);
  };
  const journal = () => existsSync(join(pc.stateDir, JOURNAL));
  const pairings = () => pc.stored().map(({ id, relay_public_key, token_hash, role }) => ({ id, relay_public_key, token_hash, role }));
  return { pc, move, ready, put, admit, send, rows, journal, leaves, intoPasses, faults, original: pairings(), keptRows: pairings, path, token, entry, identity, member, siblingDir };
}

function reopen(pc: Awaited<ReturnType<typeof pairingPc>>, options: Partial<Parameters<typeof createServer>[0]> = {}) {
  const app = createServer({
    stateDir: pc.stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, sidecar: false,
    accountOpensAll: true, accountService: { url: service, fetch: pc.account.fetch }, ...options,
  });
  cleanups.push(async () => { await app.stop(); });
  return app;
}

/** Resolves once the move journal of `dir` is gone: the move finished, or was dropped, on the server's own. */
async function journalGone(dir: string): Promise<void> {
  const path = join(dir, JOURNAL);
  let watcher: FSWatcher | undefined;
  try {
    await bounded(new Promise<void>((resolve) => {
      watcher = watch(dir, () => { if (!existsSync(path)) resolve(); });
      if (!existsSync(path)) resolve();
    }), 20_000);
  } finally { watcher?.close(); }
}

test("moving a bound PC preserves local rows and leaves its W listing only after the switch", async () => {
  const f = await fixture();
  await f.ready();
  expect(f.journal()).toBe(true);
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

test("a listed device still on its join hold keeps its pairing through the move", async () => {
  const f = await fixture();
  const { accountMailbox, accountRows } = f.pc.app.context.services;
  const listed = await phone();
  const id = accountDeviceId(f.identity.server_id, listed.spki);
  f.pc.account.registerDevice(FROM, listed.spki, "Listed");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(accountRows?.row(id)?.state).toBe("hold");
  await f.ready();
  expect((await f.move()).status).toBe(200);
  expect(f.pc.stored().find((row) => row.id === id)?.relay_public_key).toBe(listed.spki);
  const later = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1_000);
  try {
    const link = await relayConnection(f.pc, { serverId: f.identity.server_id });
    await link.auth({ id, keys: listed.keys, publicKey: listed.spki });
    expect((await ask(link, "/api/devices")).status).toBe(200);
  } finally { later.mockRestore(); }
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
  await f.ready();
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
  await journalGone(f.pc.stateDir);
  const link = await relayConnection({ ...f.pc, app }, { serverId: f.identity.server_id });
  await link.auth({ id, keys: listed.keys, publicKey: listed.spki });
  expect((await ask(link, "/api/devices")).status).toBe(200);
  expect(app.context.services.devices.accountSession(id, listed.spki)).toBe(false);
  expect(await f.rows(FROM)).toEqual([]);
});

test("plain one press still refuses a PC bound to the named account", async () => {
  const { pc } = await fixture();
  expect(await pc.local("/api/account/one-press", { method: "POST", headers, body: { account: FROM } }))
    .toMatchObject({ status: 409, body: { error: { code: "in_account" } } });
});

test.each(["relay_limit", "cancel"] as const)("%s keeps W and leaves the G listing visible", async (reason) => {
  const f = await fixture({ limit: reason === "relay_limit" });
  // the window cancels a move whose admit it could not make; a refused relay pass gives one up after its admit
  if (reason === "cancel") {
    expect((await f.move("prepare")).status).toBe(200);
    expect((await f.put()).status).toBe(200);
  } else await f.ready();
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

test("a failed W leave is retried by the server itself until it answers 204", async () => {
  const f = await fixture();
  f.faults.leave = 1;
  await f.ready();
  expect((await f.move()).status).toBe(202);
  expect(f.pc.devices.account()).toBe(INTO);
  expect(f.journal()).toBe(true);
  await journalGone(f.pc.stateDir);
  expect(f.leaves).toEqual([FROM, FROM]);
  expect(await f.rows(FROM)).toEqual([]);
  expect(f.keptRows()).toEqual(f.original);
});

test("after the switch the W leave is retried whatever the destination's completion answers", async () => {
  const f = await fixture();
  f.faults.leave = 1;
  await f.ready();
  expect((await f.move()).status).toBe(202);
  expect(f.pc.devices.account()).toBe(INTO);
  // the destination drops the PC before the retry: its completion is refused from then on, and the PC leaves it
  expect((await f.send(f.path, "DELETE")).status).toBe(204);
  await journalGone(f.pc.stateDir);
  expect(f.leaves).toEqual([FROM, FROM]);
  expect(await f.rows(FROM)).toEqual([]);
  expect(f.keptRows()).toEqual(f.original);
});

test("a prepared move whose window closed after its admit finishes without another request", async () => {
  const f = await fixture();
  await f.ready();
  await journalGone(f.pc.stateDir);
  expect(f.pc.devices.account()).toBe(INTO);
  expect(f.keptRows()).toEqual(f.original);
  expect(await f.rows(FROM)).toEqual([]);
});

test("a cancel after the admission was taken finishes the move instead", async () => {
  const f = await fixture();
  f.faults.pass = true;
  await f.ready();
  expect((await f.move()).status).toBe(202);
  expect(await f.move("cancel")).toMatchObject({ status: 202, body: { state: "pending" } });
  expect(f.journal()).toBe(true);
  expect(f.pc.devices.account()).toBe(FROM);
  f.faults.pass = false;
  await journalGone(f.pc.stateDir);
  expect(f.pc.devices.account()).toBe(INTO);
  expect(await f.rows(FROM)).toEqual([]);
});

test("a cancel the mailbox cannot answer leaves the move as it is", async () => {
  const f = await fixture();
  expect((await f.move("prepare")).status).toBe(200);
  expect((await f.put()).status).toBe(200);
  f.faults.mailbox = true;
  expect(await f.move("cancel")).toMatchObject({ status: 202, body: { state: "pending" } });
  expect(f.journal()).toBe(true);
  f.faults.mailbox = false;
  expect(await f.move("cancel")).toMatchObject({ status: 200, body: { state: "aborted", reason: "cancelled" } });
  expect(f.pc.devices.account()).toBe(FROM);
});

test("the relay pass asked for before the switch is the one the PC keeps", async () => {
  const f = await fixture({ relayPass: true });
  await f.ready();
  expect((await f.move()).status).toBe(200);
  const kept = JSON.parse(readFileSync(join(f.pc.stateDir, "relay", "pass.json"), "utf8")) as { pass: string };
  expect(f.intoPasses).toHaveLength(1);
  expect(kept.pass).toBe(f.intoPasses[0]!);
});

test("a sibling folder's lock left by a killed process is taken over at start", async () => {
  const f = await fixture();
  expect((await f.move("prepare")).status).toBe(200);
  expect((await f.put()).status).toBe(200);
  await f.pc.app.stop();
  const sibling = scratch("locked");
  const child = Bun.spawn([process.execPath, "-e", `
    import { withFileLock } from ${JSON.stringify(join(import.meta.dir, "pc-binding.ts"))};
    withFileLock(${JSON.stringify(join(sibling, JOURNAL))}, () => process.kill(process.pid, "SIGKILL"));
  `], { env: { ...process.env }, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  await bounded(child.exited);
  expect(child.signalCode).toBe("SIGKILL");
  expect(existsSync(join(sibling, `${JOURNAL}.lock`))).toBe(true);
  const app = reopen(f.pc, { siblingStateDir: sibling });
  expect(app.context.services.devices.failsClosed).toBe(false);
  expect((await f.admit()).status).toBe(200);
  await journalGone(f.pc.stateDir);
  expect(app.context.services.devices.account()).toBe(INTO);
  expect(existsSync(join(sibling, JOURNAL))).toBe(false);
});

test("a cancel stopped before its journals went stays a cancel from the sibling folder", async () => {
  const f = await fixture({ sibling: true });
  const siblingDir = f.siblingDir!;
  expect((await f.move("prepare")).status).toBe(200);
  expect((await f.put()).status).toBe(200);
  const unlink = privateStateFs.unlinkSync;
  const stopped = spyOn(privateStateFs, "unlinkSync").mockImplementation((path) => {
    if (String(path).endsWith(JOURNAL)) throw Object.assign(new Error("Stopped while removing the journal"), { code: "EIO" });
    unlink(path);
  });
  try { expect(await f.move("cancel")).toMatchObject({ status: 202, body: { state: "pending" } }); }
  finally { stopped.mockRestore(); }
  expect(f.journal()).toBe(true);
  await f.pc.app.stop();
  // the sibling folder is this PC's too: the same relay identity
  mkdirSync(join(siblingDir, "relay"), { recursive: true });
  copyFileSync(join(f.pc.stateDir, "relay", "identity.json"), join(siblingDir, "relay", "identity.json"));
  expect((await f.admit()).status).toBe(200);
  const app = createServer({
    stateDir: siblingDir, siblingStateDir: f.pc.stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, sidecar: false,
    accountOpensAll: true, accountService: { url: service, fetch: f.pc.account.fetch },
  });
  cleanups.push(async () => { await app.stop(); });
  await journalGone(siblingDir);
  expect(app.context.services.devices.account()).toBe(FROM);
  expect(PcAccountState.open(f.pc.stateDir).binding()?.account).toBe(FROM);
  expect(await f.rows(FROM)).toHaveLength(1);
});

test.skipIf(process.platform === "win32").each(["journal", "put", "admit", "admission", "pass", "switch", "complete", "leave"] as const)(
  "SIGKILL after %s leaves one local binding and the server finishes forward by itself", async (boundary) => {
    const f = await fixture();
    await f.pc.app.stop();
    const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => f.pc.account.fetch(request) });
    const child = Bun.spawn([process.execPath, "-e", `
      import { createServer } from ${JSON.stringify(join(import.meta.dir, "../index.ts"))};
      import { privateStateFs } from ${JSON.stringify(join(import.meta.dir, "../private-state.ts"))};
      import { readFileSync } from "node:fs";
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
        if (to === join(c.dir, "account-pc.json") && JSON.parse(readFileSync(to, "utf8")).binding?.account === c.into) killed("switch");
      };
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
    const beforeSwitch = ["journal", "put", "admit", "admission", "pass"].includes(boundary);
    expect(PcAccountState.open(f.pc.stateDir).binding()?.account).toBe(beforeSwitch ? FROM : INTO);
    expect(await f.rows(FROM)).toHaveLength(boundary === "leave" ? 0 : 1);
    const app = reopen(f.pc);
    // the window's part of the move, where the stop came before it: the server waits for it, and asks again by itself
    if (boundary === "journal") expect((await f.put()).status).toBe(200);
    if (boundary === "journal" || boundary === "put") expect((await f.admit()).status).toBe(200);
    await journalGone(f.pc.stateDir);
    expect(app.context.services.devices.account()).toBe(INTO);
    expect(f.keptRows()).toEqual(f.original);
    expect(await f.rows(FROM)).toEqual([]);
    expect(await f.rows(INTO)).toHaveLength(1);
  },
);

test("a denied binding-file replacement keeps W and the server retries without losing rows", async () => {
  const f = await fixture();
  await f.ready();
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
  await journalGone(f.pc.stateDir);
  expect(f.pc.devices.account()).toBe(INTO);
  expect(f.keptRows()).toEqual(f.original);
});

test.skipIf(process.platform !== "win32")("a Windows read handle delays the binding switch without losing rows", async () => {
  const f = await fixture();
  await f.ready();
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
  await journalGone(f.pc.stateDir);
  expect(f.pc.devices.account()).toBe(INTO);
  expect(f.keptRows()).toEqual(f.original);
});

import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateStateFs } from "../private-state.ts";
import { createServer } from "../index.ts";
import { bounded } from "../relay/test-helpers.ts";
import { ACCOUNT_SERVICE, FROM, INTO, JOURNAL, MERGE, filesOf, movePc, reopen } from "./account-move.test-helpers.ts";
import type { Pc } from "./pairing.test-helpers.ts";
import { PcAccountState } from "./pc-binding.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });
async function setup() {
  const fixture = await movePc({ memberAge: 2 * 60 * 60_000 });
  pcs.push(fixture.pc);
  return fixture;
}
const PC = "account-pc.json";
const ROWS = "devices.json";
const LISTED = "account-devices.json";
const RELAY = join("relay", "account.json");
const BOUNDARIES = [JOURNAL, "transfer-sent", ROWS, LISTED, PC, RELAY, "journal-gone"] as const;
const cases = BOUNDARIES.flatMap(boundary => [false, true].map(cancel => [boundary, cancel] as const));

test("starting a sibling without the relay identity keeps the pending transfer recoverable", async () => {
  const { pc, order } = await movePc({ memberAge: 2 * 60 * 60_000, accountFetch: async (request, fake) => {
    const response = await fake.fetch(request);
    return new URL(request.url).pathname === "/v1/pc/transfer" && response.ok ? new Response(null, { status: 503 }) : response;
  } });
  pcs.push(pc);
  expect((await order()).status).toBe(202);
  await pc.app.stop();
  const sibling = mkdtempSync(join(tmpdir(), "ovis-account-move-sibling-"));
  try {
    const second = createServer({ stateDir: sibling, siblingStateDir: pc.stateDir, port: 0, hostname: "127.0.0.1",
      token: "", tailscaleOwner: null, sidecar: false, accountOpensAll: true, accountService: { url: ACCOUNT_SERVICE, fetch: pc.account.fetch } });
    try {
      expect(second.context.services.relay.currentIdentity()).toBeUndefined();
      await second.context.services.accountMove?.idle();
      expect([pc.stateDir, sibling].map(dir => existsSync(join(dir, JOURNAL)))).toEqual([true, true]);
    } finally { await second.stop(); }
    const resumed = reopen(pc, { siblingStateDir: sibling });
    try {
      await resumed.context.services.accountMove?.idle();
      expect(resumed.context.services.devices.account()).toBe(INTO);
      expect([pc.stateDir, sibling].map(dir => existsSync(join(dir, JOURNAL)))).toEqual([false, false]);
    } finally { await resumed.stop(); }
  } finally { rmSync(sibling, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32").each(cases)("SIGKILL after %s (cancel before restart: %s)", async (boundary, cancel) => {
  const { pc, services, body } = await setup();
  const serverId = services.relay.currentIdentity()?.server_id;
  if (!serverId) throw new Error("missing relay identity");
  // Make a live listed row as well as the existing member, so losing either or skipping its retirement fails this matrix.
  const { phone } = await import("./pairing.test-helpers.ts");
  const { JOIN_HOLD_MS } = await import("./join-hold.ts");
  const { accountDeviceId } = await import("../../shared/account-records.ts");
  const listed = await phone();
  const now = Date.now();
  const time = spyOn(Date, "now").mockReturnValue(now - JOIN_HOLD_MS - 1_000);
  try {
    pc.account.registerDevice(FROM, listed.spki, "Listed");
    expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  } finally { time.mockRestore(); }
  const listedId = accountDeviceId(serverId, listed.spki);
  expect(pc.devices.sessionRow(listedId)?.key).toBe(listed.spki);
  const before = [...pc.stored().map(row => row.id), listedId].sort();
  await pc.app.stop();

  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => pc.account.fetch(req) });
  const code = `
    const c = ${JSON.stringify({ stateDir: pc.stateDir, boundary, relayFile: RELAY, fake: fake.url.origin, body })};
    const { createServer } = await import(${JSON.stringify(join(import.meta.dir, "../index.ts"))});
    const { privateStateFs } = await import(${JSON.stringify(join(import.meta.dir, "../private-state.ts"))});
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const app = createServer({
      stateDir: c.stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, sidecar: false,
      accountOpensAll: true, accountService: { url: "https://account.test", fetch: async req => {
        const path = new URL(req.url).pathname;
        const response = await fetch(new Request(c.fake + path, req));
        if (c.boundary === "transfer-sent" && path === "/v1/pc/transfer" && response.ok) process.kill(process.pid, "SIGKILL");
        return response;
      } },
    });
    const rename = privateStateFs.renameSync;
    privateStateFs.renameSync = (from, to) => {
      rename(from, to);
      if (String(to) === join(c.stateDir, c.boundary) && existsSync(join(c.stateDir, "account-move.json"))) process.kill(process.pid, "SIGKILL");
    };
    const unlink = privateStateFs.unlinkSync;
    privateStateFs.unlinkSync = path => {
      unlink(path);
      if (c.boundary === "journal-gone" && String(path) === join(c.stateDir, "account-move.json")) process.kill(process.pid, "SIGKILL");
    };
    const base = "http://127.0.0.1:" + app.port;
    const reply = await fetch(base + "/api/account/move", {
      method: "POST", headers: { origin: base, "x-herdr-machine": "1", "content-type": "application/json" }, body: JSON.stringify(c.body),
    });
    console.error("No crash at " + c.boundary + ": HTTP " + reply.status);
    await app.stop();
  `;
  const child = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env }, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  try {
    await bounded(child.exited);
    expect(child.signalCode).toBe("SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    await fake.stop(true);
  }

  // A killed writer can leave a fresh lock. Advancing its mtime past the existing takeover threshold models reboot.
  for (const file of [JOURNAL, PC]) {
    const lock = join(pc.stateDir, `${file}.lock`);
    const old = new Date(Date.now() - 11_000);
    if (existsSync(lock)) utimesSync(lock, old, old);
  }
  if (cancel) pc.account.setMergeState(MERGE, "cancelled");
  const expected = cancel && boundary === JOURNAL ? FROM : INTO;
  const restarted = reopen(pc);
  try {
    await restarted.context.services.accountMove?.idle();
    const accounts = [FROM, INTO].filter(account => pc.account.pcs(account).some(row => row.server_id === serverId));
    expect(accounts).toEqual([expected]);
    const { devices } = restarted.context.services;
    expect(devices.account()).toBe(expected);
    const ordinary = devices.list(null).map(row => row.id);
    const listed = restarted.context.services.accountRows?.rows().map(row => row.id) ?? [];
    expect(before.filter(id => !ordinary.includes(id) && !listed.includes(id))).toEqual([]);
    expect(devices.failsClosed).toBe(false);
    expect(PcAccountState.open(pc.stateDir).clears().map(clear => clear.by)).not.toContain("account");
    expect(PcAccountState.open(pc.stateDir).clears().map(clear => clear.by)).not.toContain("unpinned");
    expect(existsSync(join(pc.stateDir, JOURNAL))).toBe(false);
  } finally { await restarted.stop(); }
  const bytes = filesOf(pc.stateDir, [PC, ROWS]);
  const again = reopen(pc);
  try {
    await again.context.services.accountMove?.idle();
    expect(filesOf(pc.stateDir, [PC, ROWS])).toEqual(bytes);
  } finally { await again.stop(); }
});

test.each([[ROWS, "EIO"], [PC, "EPERM"], [PC, "EBUSY"], [RELAY, "EIO"], [JOURNAL, "EPERM"]] as const)(
  "a failed write to %s (%s) leaves one binding and is finished by resume",
  async (file, code) => {
    const { pc, services, order } = await setup();
    const ids = pc.stored().map(row => row.id);
    const filesystemError = () => Object.assign(new Error("injected filesystem error"), { code });
    const path = join(pc.stateDir, file);
    const rename = privateStateFs.renameSync;
    const unlink = privateStateFs.unlinkSync;
    const fail = file === JOURNAL
      ? spyOn(privateStateFs, "unlinkSync").mockImplementation(at => { if (at === path) throw filesystemError(); unlink(at); })
      : spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
        if (to === path && existsSync(join(pc.stateDir, JOURNAL))) throw filesystemError();
        rename(from, to);
      });
    try {
      expect((await order()).body).toEqual({ state: "pending" });
      expect(pc.devices.account()).toBe(file === JOURNAL || file === RELAY ? INTO : FROM);
      expect(pc.stored().map(row => row.id)).toEqual(ids);
      expect(pc.devices.failsClosed).toBe(false);
      expect(existsSync(join(pc.stateDir, JOURNAL))).toBe(true);
      if (file === JOURNAL) {
        const standing = PcAccountState.open(pc.stateDir).binding();
        if (!standing) throw new Error("committed binding missing");
        expect(services.accountMove?.pending(standing.bind_id)).toBe(false);
      }
    } finally { fail.mockRestore(); }
    services.accountMove?.resume();
    await services.accountMove?.idle();
    expect(pc.devices.account()).toBe(INTO);
    expect(existsSync(join(pc.stateDir, JOURNAL))).toBe(false);
  },
);

test("a dead writer's lock delays a move but does not lose it", async () => {
  const { pc, services, order } = await movePc({ memberAge: 2 * 60 * 60_000, accountFetch: async (req, fake) => {
    const response = await fake.fetch(req);
    if (new URL(req.url).pathname === "/v1/pc/transfer" && response.ok) {
      writeFileSync(join(pc.stateDir, `${PC}.lock`), "", { mode: 0o600 });
    }
    return response;
  } });
  pcs.push(pc);
  const path = join(pc.stateDir, `${PC}.lock`);
  expect((await order()).body).toEqual({ state: "pending" });
  expect(pc.devices.account()).toBe(FROM);
  const stale = new Date(Date.now() - 11_000);
  utimesSync(path, stale, stale);
  services.accountMove?.resume();
  await services.accountMove?.idle();
  expect(pc.devices.account()).toBe(INTO);
});

test.skipIf(process.platform !== "win32")("a PowerShell read handle without delete sharing blocks the binding rename until released", async () => {
  const { pc, services, order } = await setup();
  const command = "$f=[IO.File]::Open($env:OVIS_MOVE_TEST_FILE,'Open','Read','Read'); [Console]::WriteLine('held'); [Console]::ReadLine(); $f.Dispose()";
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, OVIS_MOVE_TEST_FILE: join(pc.stateDir, PC) }, stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await bounded(reader.read())).value).trim()).toBe("held");
    expect((await order()).body).toEqual({ state: "pending" });
    expect(pc.devices.account()).toBe(FROM);
    expect(pc.stored().length).toBe(1);
    expect(pc.devices.failsClosed).toBe(false);
    expect(existsSync(join(pc.stateDir, JOURNAL))).toBe(true);
  } finally {
    child.stdin.end();
    await bounded(child.exited);
  }
  services.accountMove?.resume();
  await services.accountMove?.idle();
  expect(pc.devices.account()).toBe(INTO);
  expect(existsSync(join(pc.stateDir, JOURNAL))).toBe(false);
});
